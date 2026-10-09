// The `orchestrate` tool (orchestrations-v1; kete-code ADR 0012; design spec §4.1, piece O7): a cloud
// job's coordinator turn plans an orchestration's nodes and decides how it ends. Registered by
// KeteJobPlugin only in job mode and only when the job's spec says this is a coordinator turn
// (`spec.orchestration.role = "coordinator"`, handed over by `kete job run`, KeteJobSecrets) — never in
// an interactive session and never in a node's job. It calls the platform's coordinator routes with the
// turn's own job key; nothing but metadata leaves the zone (keys, dependencies, agents, budgets,
// timeouts, digests; titles and the summary only where the boundary lets them).
//
// - plan: builds `.kete-orchestration/plan.json` from the nodes (prompts and notes stay in-zone),
//   checks it with the contract's own rules against the platform's view, PUTs the proposal (metadata
//   and digests) and, only after a 200, writes the plan file into the working tree. The entrypoint then
//   publishes exactly that file as the plan branch. From then on the turn edits nothing.
// - status: the platform's view of the orchestration.
// - finish: `integrated` (the working tree is the integration result) or `abandon`; a plan proposed
//   earlier in the turn is discarded, and its file removed from the working tree.
//
// Also, for every orchestrated job: an edit under `.kete-orchestration` is denied (only the tool writes
// the plan file; every other bundle refuses that directory).

export * as KeteOrchestrate from "./orchestrate.js"

import path from "node:path"
import { ToolFailure } from "@opencode/ai"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import type { KeteOrchestrationSpec } from "@opencode/util/kete/orchestration-spec"
import { Effect, Option, Schema } from "effect"
import { Environment } from "../environment/index.js"
import { KeteOrchestrationClient } from "./orchestration/client.js"
import {
  JOB_SUMMARY_MAX_BYTES,
  ORCHESTRATION_DIR,
  ORCHESTRATION_PLAN_PATH,
  OrchestrationDecisionRequest,
  checkOrchestrationBundle,
  orchestrationPlanBranch,
  type OrchestrationCoordinatorView,
  type OrchestrationTitles,
} from "./orchestration/contract.js"
import { KeteOrchestrationPlan } from "./orchestration/plan.js"
import { KeteOrchestrationPrompt } from "./orchestration/prompt.js"
import { KeteOrchestrationTurnState } from "./orchestration/turn-state.js"
import { Global } from "@opencode/util/global"

export const name = "orchestrate"

const Node = Schema.Struct({
  key: Schema.String.annotate({
    description: "Stable node key: a lowercase letter, then lowercase letters, digits or '-' (max 32); not 'plan'",
  }),
  title: Schema.optional(Schema.String.annotate({ description: "One-line title (max 80 characters)" })),
  prompt: Schema.String.annotate({
    description:
      "The node agent's complete instructions (it sees nothing else): goal, files, approach, how to test. Max 64 KiB",
  }),
  depends_on: Schema.optional(
    Schema.Array(Schema.String).annotate({ description: "Keys of nodes that must succeed first" }),
  ),
  base_from: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "A (transitive) dependency whose branch this node starts from; omit for the base",
    }),
  ),
  agent: Schema.String.annotate({ description: "One of the orchestration's worker agents" }),
  budget_usd: Schema.Number.annotate({ description: "This node's budget in USD (at least 0.25)" }),
  timeout_minutes: Schema.Number.annotate({ description: "This node's time limit in minutes (1-120)" }),
  max_attempts: Schema.optional(Schema.Number.annotate({ description: "Attempts allowed (1-3); default: the limit" })),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["plan", "status", "finish"]).annotate({
    description: "plan nodes, read the status, or finish the orchestration",
  }),
  notes: Schema.optional(Schema.String.annotate({ description: "plan: your notes for later turns (max 32 KiB)" })),
  max_parallel: Schema.optional(Schema.Number.annotate({ description: "plan: run at most this many nodes at once" })),
  nodes: Schema.optional(Schema.Array(Node).annotate({ description: "plan: the nodes of this revision (1-8)" })),
  decision: Schema.optional(
    Schema.Literals(["integrated", "abandon"]).annotate({ description: "finish: integrated or abandon" }),
  ),
  summary: Schema.optional(Schema.String.annotate({ description: "finish: what was done (max 4 KB)" })),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  action: Schema.Literals(["plan", "status", "finish"]),
  status: Schema.String,
  rev: Schema.optionalKey(Schema.Number),
  plan_digest: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Schema.String),
})
export type Output = typeof Output.Type

export const description = [
  "Coordinates this orchestrated job (you are its coordinator).",
  'action "plan": propose the next nodes (sub-tasks run as separate jobs, in parallel where `depends_on` allows); the plan file is written and published when your turn ends. End the turn right after a plan.',
  'action "status": the orchestration\'s nodes, states, outcomes, commits and budget.',
  'action "finish": decision "integrated" (the working tree is the merged, tested result) or "abandon".',
  "Each turn must end with a plan or a finish.",
].join("\n")

/** What leaves the zone besides metadata, by the runtime's own boundary (the claim's setting is
 * narrowed by it): the entrypoint says the job's zone (KETE_JOB_ZONE); Kete cloud lets titles and
 * summaries leave; any other zone, or none, keeps them in-zone until its runner's boundary is wired
 * in (O10). */
export function localBoundary(env: Record<string, string | undefined> = process.env): {
  readonly titles: boolean
  readonly summary: boolean
} {
  const cloud = env["OPENCODE_JOB_ZONE"] === "kete_cloud"
  return { titles: cloud, summary: cloud }
}

/** The turn's own record: what it proposed and decided (one process is one turn). */
export interface Turn {
  proposed?: { readonly rev: number; readonly digest: string }
  decided?: "integrated" | "abandon"
}

export interface Deps {
  readonly spec: KeteOrchestrationSpec.Coordinator
  /** The routes' target, or why there is none (fail closed). */
  readonly target: () => KeteOrchestrationClient.Target | string
  /** The working tree's files. In job mode this is the confined driver (kete/job-files.ts:
   * openat2 beneath the tree, no symlinks), so a `.kete-orchestration` the agent made a symlink is
   * refused, never followed. */
  readonly files: Pick<Environment.Files, "write" | "mkdir" | "remove" | "stat">
  /** The working tree's root (the job's repository). */
  readonly directory: string
  readonly boundary: { readonly titles: boolean; readonly summary: boolean }
  readonly turn: Turn
  /** Records the turn's proposal and decision where the entrypoint reads them and the job's tools
   * can't write (KeteOrchestrationTurnState). */
  readonly record: (turn: Turn) => Promise<void>
}

const fail = (message: string) => new ToolFailure({ message })

const failure = (error: unknown): ToolFailure => {
  if (error instanceof KeteOrchestrationClient.OrchestrationError) {
    const d = error.detail
    const issues =
      d.issues && d.issues.length > 0
        ? `\n${KeteOrchestrationPlan.describeIssues(d.issues)
            .map((l) => `- ${l}`)
            .join("\n")}`
        : ""
    const reason = d.reason ? ` [${d.reason}]` : ""
    return fail(`The platform refused it${reason}: ${error.message}${issues}`)
  }
  return fail(error instanceof Error ? error.message : String(error))
}

const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })

/** Runs one call of the tool. */
export const execute = (deps: Deps, input: Input) =>
  Effect.gen(function* () {
    const target = deps.target()
    if (typeof target === "string") return yield* fail(`Orchestration is unavailable in this job: ${target}.`)
    const planFile = path.join(deps.directory, ORCHESTRATION_PLAN_PATH)
    const planDir = path.join(deps.directory, ORCHESTRATION_DIR)

    if (input.action === "status") {
      const view = yield* promise(() => KeteOrchestrationClient.view(target))
      return {
        output: { action: "status" as const, status: view.status },
        content: KeteOrchestrationPrompt.describeView(view),
      }
    }

    if (input.action === "plan") {
      if (deps.spec.final)
        return yield* fail("This is the final turn: it can only finish (integrate what succeeded, or abandon).")
      if (deps.turn.decided) return yield* fail(`This turn already decided (${deps.turn.decided}); it can't plan.`)
      if (!input.nodes || input.nodes.length === 0) return yield* fail('A plan needs "nodes" (1-8).')
      const view = yield* promise(() => KeteOrchestrationClient.view(target))
      const rev = (view.plan?.rev ?? 0) + 1
      const built = KeteOrchestrationPlan.build({
        orchestrationID: deps.spec.id,
        rev,
        notes: input.notes ?? "",
        ...(input.max_parallel === undefined ? {} : { maxParallel: input.max_parallel }),
        nodes: input.nodes,
        defaultAttempts: view.limits.attempts_per_node,
      })
      if (!built.ok) return yield* fail(`The plan is invalid:\n${built.errors.map((e) => `- ${e}`).join("\n")}`)
      const titles: OrchestrationTitles =
        deps.spec.titles === "send" && view.titles === "send" && deps.boundary.titles ? "send" : "omit"
      const checked = yield* promise(() => KeteOrchestrationPlan.check(built.bytes, view, titles))
      if (!checked.ok)
        return yield* fail(
          `The plan would be refused:\n${[...checked.errors, ...KeteOrchestrationPlan.describeIssues(checked.issues)].map((e) => `- ${e}`).join("\n")}`,
        )
      const accepted = yield* promise(() => KeteOrchestrationClient.propose(target, checked.proposal))
      // The platform holds this turn's proposal from here on: the turn edits nothing more.
      deps.turn.proposed = { rev, digest: checked.proposal.plan_digest }
      // The entrypoint publishes a plan bundle only with this record (and only the file with this digest).
      yield* Effect.tryPromise({
        try: () => deps.record(deps.turn),
        catch: (error) =>
          fail(
            `The plan was accepted but its record couldn't be written (${error instanceof Error ? error.message : String(error)}). Call plan again.`,
          ),
      })
      // Only now, the plan file: the turn's bundle is exactly it (the entrypoint's plan bundle).
      // Re-sending the same proposal is a no-op on the platform, so "call plan again" is safe.
      yield* deps.files
        .mkdir(planDir)
        .pipe(
          Effect.mapError((error) =>
            fail(`The plan was accepted but its directory couldn't be made: ${error.message}. Call plan again.`),
          ),
        )
      yield* deps.files
        .write(planFile, built.bytes)
        .pipe(
          Effect.mapError((error) =>
            fail(`The plan was accepted but the plan file couldn't be written: ${error.message}. Call plan again.`),
          ),
        )
      return {
        output: { action: "plan" as const, status: accepted.status, rev, plan_digest: checked.proposal.plan_digest },
        content: [
          `Plan revision ${rev} accepted (${checked.proposal.nodes.length} node(s), ${(checked.cost / 1_000_000).toFixed(2)} USD).`,
          `It is published as ${orchestrationPlanBranch(deps.spec.id, rev)} when this turn ends; the nodes start then.`,
          "End your turn now with a short summary. Don't edit files: a planning turn publishes only the plan file.",
        ].join("\n"),
      }
    }

    // finish
    if (input.decision === undefined) return yield* fail('finish needs "decision": "integrated" or "abandon".')
    if (deps.turn.decided) return yield* fail(`This turn already decided (${deps.turn.decided}).`)
    const summary = deps.boundary.summary ? input.summary : undefined
    const request = OrchestrationDecisionRequest.safeParse({
      decision: input.decision,
      ...(summary === undefined ? {} : { summary }),
    })
    if (!request.success)
      return yield* fail(
        `The summary must be at most ${JOB_SUMMARY_MAX_BYTES} bytes of text without NUL characters; shorten it.`,
      )
    const decided = yield* promise(() => KeteOrchestrationClient.decide(target, request.data))
    deps.turn.decided = input.decision
    yield* Effect.tryPromise({
      try: () => deps.record(deps.turn),
      catch: (error) =>
        fail(
          `The decision was recorded on the platform but not locally (${error instanceof Error ? error.message : String(error)}).`,
        ),
    })
    // The platform discarded any proposal of this turn; no plan file may reach the bundle (a
    // coordinator's bundle with one is published as a plan bundle), whoever wrote it.
    const present = yield* deps.files.stat(planDir).pipe(
      Effect.as(true),
      Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
      Effect.mapError((error) =>
        fail(`The decision was recorded but ${ORCHESTRATION_DIR} couldn't be checked: ${error.message}.`),
      ),
    )
    if (present || deps.turn.proposed) {
      yield* deps.files
        .remove(planDir)
        .pipe(
          Effect.mapError((error) =>
            fail(`The decision was recorded but ${ORCHESTRATION_DIR} couldn't be removed: ${error.message}.`),
          ),
        )
      deps.turn.proposed = undefined
    }
    return {
      output: { action: "finish" as const, status: decided.status, decision: input.decision },
      content:
        input.decision === "integrated"
          ? "Recorded: integrated. The working tree is published as the integration result (one draft pull request) when this turn ends. End your turn now with a short summary."
          : "Recorded: abandon. The orchestration ends as failed; nothing is published. End your turn now.",
    }
  })

/** Whether an `edit` permission check targets `.kete-orchestration` (folded as the bundle rule folds). */
export function touchesOrchestrationDir(resources: ReadonlyArray<string>): boolean {
  return resources.some(
    (resource) =>
      checkOrchestrationBundle(
        [{ path: resource.replaceAll("\\", "/").replace(/^\/+/, ""), mode: "100644", size: 0 }],
        "other",
      ) !== null,
  )
}

/** The permission rule of an orchestrated job: no edit under `.kete-orchestration` (only the tool
 * writes there), and none at all once the turn has proposed a plan (a planning turn changes no code). */
export function applyPermission(turn: Turn | undefined, event: PermissionEvaluation) {
  if (event.action !== "edit" || event.effect === "deny") return
  if (touchesOrchestrationDir(event.resources)) {
    event.effect = "deny"
    event.message = "orchestration: only the orchestrate tool writes .kete-orchestration"
    return
  }
  if (turn?.proposed) {
    event.effect = "deny"
    event.message = "orchestration: this turn proposed a plan; a planning turn changes no code"
  }
}

/** The routes' target in job mode, or why there is none. */
export function jobTarget(
  env: Record<string, string | undefined> = process.env,
  orchestration: KeteJobSecrets.Orchestration | undefined = KeteJobSecrets.orchestration(),
): KeteOrchestrationClient.Target | string {
  const platform = KeteJobMode.endpoints(env).platform
  const key = KeteJobSecrets.gatewayKey()
  if (!orchestration) return "this job is not an orchestration's coordinator turn"
  if (!platform) return "no platform URL"
  if (!key) return "no job key"
  return { platform, jobID: orchestration.jobID, key }
}

/**
 * Installs the tool and its rules for an orchestrated job (called by KeteJobPlugin in job mode). A
 * job without `spec.orchestration` gets nothing; a node's job only the `.kete-orchestration` rule.
 */
export interface InstallOptions {
  /** This job's orchestration (default: what `kete job run` handed over, KeteJobSecrets). */
  readonly orchestration?: KeteJobSecrets.Orchestration
  /** The environment the platform URL and the runtime type come from (default: process.env). */
  readonly env?: Record<string, string | undefined>
  /** The routes' target (default: jobTarget). */
  readonly target?: () => KeteOrchestrationClient.Target | string
  /** Where the turn's record goes (default: kete's state directory). */
  readonly record?: (turn: Turn) => Promise<void>
}

export const install = Effect.fn("KeteOrchestrate.install")(function* (
  ctx: PluginContext,
  options: InstallOptions = {},
) {
  const orchestration = options.orchestration ?? KeteJobSecrets.orchestration()
  if (!orchestration) return
  const env = options.env ?? process.env
  const target = options.target ?? (() => jobTarget(env, orchestration))
  const spec = orchestration.spec
  if (spec.role !== "coordinator") {
    yield* ctx.permission.hook("evaluate", (event) => Effect.sync(() => applyPermission(undefined, event)))
    return
  }
  // Read as an option so KeteJobPlugin keeps no requirement; the plugin host always provides it. If
  // it were missing the coordinator would get no tool, and the platform ends the turn's
  // orchestration (coordinator_no_decision): fail closed, logged.
  const environment = Option.getOrUndefined(yield* Effect.serviceOption(Environment.Service))
  if (!environment) {
    yield* Effect.logError("orchestration: the coordinator's tool can't be installed (no working tree service)")
    return
  }
  const turn: Turn = {}
  const deps: Deps = {
    spec,
    target,
    files: environment.files,
    directory: ctx.location.directory,
    boundary: localBoundary(env),
    turn,
    record:
      options.record ??
      ((t) => KeteOrchestrationTurnState.write(Global.Path.state, { orchestrationID: spec.id, turn: spec.turn, ...t })),
  }
  yield* ctx.permission.hook("evaluate", (event) => Effect.sync(() => applyPermission(turn, event)))

  yield* ctx.tool
    .transform((editor) => {
      editor.add({
        name,
        options: { codemode: false },
        description,
        input: Input,
        output: Output,
        execute: (input) => execute(deps, input),
      })
    })
    .pipe(Effect.orDie)

  // The coordinator's instructions and the state at the turn's start, read once.
  const state: { view?: OrchestrationCoordinatorView; error?: string; read: boolean } = { read: false }
  const readState = Effect.gen(function* () {
    if (state.read) return
    state.read = true
    const resolved = target()
    if (typeof resolved === "string") {
      state.error = resolved
      return
    }
    const result = yield* Effect.tryPromise({
      try: () => KeteOrchestrationClient.view(resolved),
      catch: (error) => error,
    }).pipe(Effect.result)
    if (result._tag === "Success") state.view = result.success
    else state.error = result.failure instanceof Error ? result.failure.message : "unknown error"
  })
  yield* ctx.session.hook("context", (event) =>
    Effect.gen(function* () {
      yield* readState
      event.system.push({ type: "text", text: KeteOrchestrationPrompt.coordinator(spec, state.view, state.error) })
    }),
  )
})
