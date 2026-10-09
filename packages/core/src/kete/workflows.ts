// Reusable engineering workflows (docs/architecture.md §67): named sequences of agent steps,
// configured under `kete.workflows`, run with the `workflow` tool.
//
// A workflow orchestrates the existing machinery rather than duplicating it: every step is a call
// of the `subagent` tool, so it gets that tool's permission check, the permission ceiling, the
// nesting limit, `kete.subagents` limits and timeout, and worktrees. Steps whose earlier steps
// (`after`, `continue`) have finished run at the same time, up to `kete.subagents.max_concurrent`.
// A step's final answer can feed later prompts ({{steps.<id>}}). A step that fails, or that the
// user moves to the background, stops the steps after it; the result says which ran, which failed
// and which were skipped.

export * as KeteWorkflows from "./workflows.js"

import { ToolFailure } from "@opencode/ai"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { ConfigKete } from "@opencode/schema/config/kete"
import { Effect, Schema, Stream } from "effect"
import { Config } from "../config.js"
import { SessionSchema } from "../session/schema.js"
import { Tool } from "../tool.js"
import { KeteDag } from "./dag.js"
import { KeteSubagents } from "./subagents.js"

export const name = "workflow"

type Step = ConfigKete.WorkflowStep

/** A validated workflow: steps with their dependencies, in an order where each follows its dependencies. */
export interface Plan {
  readonly name: string
  readonly steps: ReadonlyArray<Step>
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>
}

const placeholder = /\{\{\s*([^}]*?)\s*\}\}/g

/** Checks a workflow; returns its plan, or every problem found. */
export function validate(
  workflowName: string,
  workflow: ConfigKete.Workflow,
): { readonly plan: Plan } | { readonly errors: ReadonlyArray<string> } {
  const errors: string[] = []
  const steps = workflow.steps
  if (steps.length === 0) errors.push("it has no steps")
  const byID = new Map<string, Step>()
  for (const step of steps) {
    if (byID.has(step.id)) errors.push(`step "${step.id}" is defined twice`)
    byID.set(step.id, step)
  }
  const direct = new Map<string, Set<string>>()
  for (const step of steps) {
    const deps = new Set([...(step.after ?? []), ...(step.continue === undefined ? [] : [step.continue])])
    for (const dep of deps) {
      if (dep === step.id) errors.push(`step "${step.id}" can't come after itself`)
      else if (!byID.has(dep)) errors.push(`step "${step.id}" refers to "${dep}", which isn't a step`)
    }
    if (step.continue !== undefined && step.worktree === true)
      errors.push(`step "${step.id}" continues "${step.continue}", so it can't also have its own worktree`)
    direct.set(step.id, deps)
  }
  if (errors.length > 0) return { errors }

  // Order the steps so each follows its dependencies (Kahn, the shared KeteDag); what's left over is a cycle.
  const sorted = KeteDag.order([...direct])
  if (sorted.cycle.length > 0) {
    errors.push(`steps ${sorted.cycle.map((id) => `"${id}"`).join(", ")} depend on each other in a cycle`)
    return { errors }
  }
  const ordered: Step[] = sorted.order.map((id) => byID.get(id)!)

  // Everything each step comes after, directly or not.
  const dependencies = new Map<string, Set<string>>()
  for (const step of ordered) {
    const all = new Set<string>()
    for (const dep of direct.get(step.id)!) {
      all.add(dep)
      for (const inherited of dependencies.get(dep)!) all.add(inherited)
    }
    dependencies.set(step.id, all)
  }

  for (const step of ordered) {
    for (const match of step.prompt.matchAll(placeholder)) {
      const reference = match[1] ?? ""
      if (reference === "input") continue
      const id = reference.startsWith("steps.") ? reference.slice("steps.".length) : undefined
      if (id === undefined)
        errors.push(`step "${step.id}" uses {{${reference}}}; only {{input}} and {{steps.<id>}} exist`)
      else if (!dependencies.get(step.id)!.has(id))
        errors.push(`step "${step.id}" uses {{steps.${id}}} but doesn't come after "${id}"`)
    }
  }

  // Steps that continue the same session must run one after another.
  const session = (step: Step): string => (step.continue === undefined ? step.id : session(byID.get(step.continue)!))
  const groups = new Map<string, Step[]>()
  for (const step of ordered) groups.set(session(step), [...(groups.get(session(step)) ?? []), step])
  for (const group of groups.values())
    for (const [i, a] of group.entries())
      for (const b of group.slice(i + 1))
        if (!dependencies.get(b.id)!.has(a.id) && !dependencies.get(a.id)!.has(b.id))
          errors.push(`steps "${a.id}" and "${b.id}" continue the same session, so one must come after the other`)

  if (errors.length > 0) return { errors }
  return { plan: { name: workflowName, steps: ordered, dependencies } }
}

/** Fills a step's prompt: {{input}} and {{steps.<id>}}. */
export function render(prompt: string, input: string, outputs: ReadonlyMap<string, string>) {
  return prompt.replace(placeholder, (_, reference: string) =>
    reference === "input" ? input : (outputs.get(reference.slice("steps.".length)) ?? ""),
  )
}

export type StepResult =
  | { readonly id: string; readonly state: "completed"; readonly sessionID: string; readonly output: string }
  | { readonly id: string; readonly state: "backgrounded"; readonly sessionID: string }
  | { readonly id: string; readonly state: "failed"; readonly error: string }
  | { readonly id: string; readonly state: "skipped"; readonly reason: string }

export type StepRun = (input: {
  readonly step: Step
  readonly prompt: string
  /** The session to continue, for a step with `continue`. */
  readonly sessionID?: string
}) => Effect.Effect<Exclude<StepResult, { state: "skipped" }>>

/**
 * Runs a plan: in waves of steps whose dependencies have completed, each wave with up to
 * `concurrency` steps at once. A step after a failed, skipped or backgrounded one is skipped.
 */
export const run = Effect.fnUntraced(function* (plan: Plan, input: string, concurrency: number, step: StepRun) {
  const results = new Map<string, StepResult>()
  const outputs = new Map<string, string>()
  const sessions = new Map<string, string>()
  while (results.size < plan.steps.length) {
    const pending = plan.steps.filter((item) => !results.has(item.id))
    for (const item of pending) {
      const blocker = [...plan.dependencies.get(item.id)!].find((dep) => {
        const state = results.get(dep)?.state
        return state !== undefined && state !== "completed"
      })
      if (blocker !== undefined)
        results.set(item.id, {
          id: item.id,
          state: "skipped",
          reason: `"${blocker}" ${results.get(blocker)!.state === "backgrounded" ? "is still running in the background" : "didn't complete"}`,
        })
    }
    const ready = plan.steps.filter(
      (item) =>
        !results.has(item.id) &&
        [...plan.dependencies.get(item.id)!].every((dep) => results.get(dep)?.state === "completed"),
    )
    if (ready.length === 0) break
    const finished = yield* Effect.forEach(
      ready,
      (item) =>
        step({
          step: item,
          prompt: render(item.prompt, input, outputs),
          ...(item.continue === undefined ? {} : { sessionID: sessions.get(item.continue) }),
        }),
      { concurrency },
    )
    for (const result of finished) {
      results.set(result.id, result)
      if (result.state === "completed") outputs.set(result.id, result.output)
      if (result.state === "completed" || result.state === "backgrounded") sessions.set(result.id, result.sessionID)
    }
  }
  return plan.steps.map((item) => results.get(item.id)!)
})

const PREVIEW = 4000

/** The workflow's result as the model reads it. */
export function describe(plan: Plan, results: ReadonlyArray<StepResult>) {
  const state = results.every((result) => result.state === "completed") ? "completed" : "incomplete"
  const body = results.map((result) => {
    if (result.state === "completed") {
      const text =
        result.output.length > PREVIEW
          ? `${result.output.slice(0, PREVIEW)}\n… (shortened; the full answer is in session ${result.sessionID})`
          : result.output
      return `<step id="${result.id}" state="completed" sessionID="${result.sessionID}">\n${text}\n</step>`
    }
    if (result.state === "backgrounded")
      return `<step id="${result.id}" state="backgrounded" sessionID="${result.sessionID}">\nStill running in the background; you'll be notified when it finishes. Steps after it weren't run.\n</step>`
    if (result.state === "failed") return `<step id="${result.id}" state="failed">\n${result.error}\n</step>`
    return `<step id="${result.id}" state="skipped">\nNot run: ${result.reason}.\n</step>`
  })
  return [`<workflow name="${plan.name}" state="${state}">`, ...body, "</workflow>"].join("\n")
}

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "The workflow to run" }),
  input: Schema.String.annotate({
    description: "What the workflow works on (the requirement, issue, or change), given to its steps as {{input}}",
  }),
})

const StepOutput = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["completed", "backgrounded", "failed", "skipped"]),
  sessionID: Schema.optionalKey(Schema.String),
})

export const Output = Schema.Struct({
  state: Schema.Literals(["completed", "incomplete"]),
  steps: Schema.Array(StepOutput),
})

const SubagentOutput = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
const decodeSubagent = Schema.decodeUnknownOption(SubagentOutput)

export const description = [
  "Runs a configured workflow: named steps, each done by an agent as a subagent, in order, with independent steps at the same time.",
  "Give it the thing to work on as `input`. The result has each step's final answer, or why it failed or was skipped.",
  "Use it when the user asks for a workflow by name, or for work one of the listed workflows is for.",
].join("\n")

export const Plugin = {
  id: "kete.workflows",
  effect: Effect.fn("KeteWorkflows.Plugin")(function* (ctx: PluginContext) {
    const config = yield* Config.Service
    const tools = yield* Tool.Service

    const none: Readonly<Record<string, ConfigKete.Workflow>> = {}
    const workflows = Effect.map(config.entries(), (entries) => Config.latest(entries, "kete")?.workflows ?? none)

    // The tool exists only while workflows are configured; configuration changes add or remove it.
    let enabled = Object.keys(yield* workflows).length > 0
    const refresh = Effect.gen(function* () {
      const next = Object.keys(yield* workflows).length > 0
      if (next === enabled) return
      enabled = next
      yield* ctx.tool.reload()
    })
    yield* Stream.merge(
      config.changes(),
      ctx.event.subscribe().pipe(Stream.filter((event) => event.type === "config.updated")),
    ).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => refresh),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) => {
        if (!enabled) return
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const all = yield* workflows
              const workflow = all[input.name]
              if (workflow === undefined)
                return yield* new ToolFailure({
                  message: `No workflow named "${input.name}". Configured: ${Object.keys(all).join(", ") || "none"}.`,
                })
              const checked = validate(input.name, workflow)
              if ("errors" in checked)
                return yield* new ToolFailure({
                  message: `Workflow "${input.name}" can't run: ${checked.errors.join("; ")}. Fix it under kete.workflows.`,
                })
              const { maxConcurrent } = KeteSubagents.limits(Config.latest(yield* config.entries(), "kete")?.subagents)

              const step: StepRun = ({ step, prompt, sessionID }) =>
                Effect.gen(function* () {
                  yield* context.progress({ step: step.id, status: "running" })
                  const snapshot = yield* tools.snapshot()
                  const call = {
                    type: "tool-call" as const,
                    id: `${context.id}-${step.id}`,
                    name: "subagent",
                    input: {
                      agent: step.agent,
                      description: `${input.name}: ${step.id}`,
                      prompt,
                      ...(sessionID === undefined ? {} : { sessionID }),
                      ...(step.worktree === undefined ? {} : { worktree: step.worktree }),
                    },
                  }
                  const result = yield* snapshot
                    .execute({ sessionID: context.sessionID, agent: context.agent, messageID: context.messageID, call })
                    .pipe(Effect.result)
                  if (result._tag === "Failure")
                    return { id: step.id, state: "failed" as const, error: result.failure.message }
                  const output = decodeSubagent(result.success.output)
                  if (output._tag === "None")
                    return { id: step.id, state: "failed" as const, error: "The subagent returned no result." }
                  if (output.value.status === "running")
                    return { id: step.id, state: "backgrounded" as const, sessionID: output.value.sessionID }
                  return {
                    id: step.id,
                    state: "completed" as const,
                    sessionID: output.value.sessionID,
                    output: output.value.output,
                  }
                })

              const results = yield* run(checked.plan, input.input, maxConcurrent, step)
              return { plan: checked.plan, results }
            }).pipe(
              Effect.map(({ plan, results }) => ({
                output: {
                  state: results.every((result) => result.state === "completed")
                    ? ("completed" as const)
                    : ("incomplete" as const),
                  steps: results.map((result) => ({
                    id: result.id,
                    state: result.state,
                    ...("sessionID" in result ? { sessionID: result.sessionID } : {}),
                  })),
                },
                content: describe(plan, results),
              })),
            ),
        })
      })
      .pipe(Effect.orDie)

    // List the configured workflows in the tool's description, as the subagent tool lists agents.
    const hook = (event: { tools: Record<string, { description: string }> }) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const all = Object.entries(yield* workflows)
        tool.description = [
          tool.description,
          "",
          "Available workflows:",
          ...all.map(
            ([id, workflow]) =>
              `- ${id}: ${workflow.description ?? workflow.steps.map((item) => `${item.id} (${item.agent})`).join(" → ")}`,
          ),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
