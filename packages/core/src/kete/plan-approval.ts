// Plan approval (parity B4, docs/tasks/2026-11-04-plan-approval, docs/permissions.md#plan-approval). In
// Plan mode the agent ends with `present_plan`; the user approves it in a form, and the session leaves
// Plan mode for Accept-edits or Default (and the read-only `plan` agent for the default agent), so the
// agent implements the plan in the same turn. The runner re-reads the session's agent and the permission
// mode re-reads its metadata at every step (session/context.ts `select`, kete/permission-mode.ts).
//
// Only the user's answer raises the session's permissions: the model can't answer forms. The tool is
// offered only to a root session in Plan mode and refuses everywhere else, including unattended runs,
// which never ask (ADR 0008).

export * as KetePlanApproval from "./plan-approval.js"

import { ToolFailure } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Agent as AgentSchema } from "@opencode/schema/agent"
import { Effect, Option, Schema } from "effect"
import { Agent } from "../agent.js"
import { Form } from "../form.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KetePermissionMode } from "./permission-mode.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

export const id = "kete.plan-approval"
export const name = "present_plan"
/** The question form's `metadata.kete`, telling plan approval apart from the question tool. */
export const FORM_KIND = "plan-approval"
/** Characters of a plan the form shows. */
export const MAX_PLAN = 64 * 1024

const PLAN_AGENT = AgentSchema.ID.make("plan")
const BUILD_AGENT = AgentSchema.ID.make("build")

export const description = [
  "Present your implementation plan to the user for approval. Use this in Plan mode when the plan is ready, instead of asking the user to switch modes or agents.",
  "Give the whole plan as Markdown: what you'll change (files), the steps in order, and how you'll verify it. If the user approves, Plan mode ends and you continue in this turn with edits allowed: implement the approved plan. If they want changes, you get their feedback and stay in Plan mode: revise the plan and present it again.",
].join("\n\n")

/** Added to Plan mode requests: upstream's Plan reminder tells the agent to wait for the user to switch agents. */
export const reminder =
  "When your plan is ready, call the present_plan tool with the full plan. The user approves it there, and you then implement it in this session. Don't ask the user to switch modes or agents."

export type Decision = "accept-edits" | "default" | "revise"

export interface Answer {
  readonly decision: Decision
  readonly feedback?: string
}

/** The user's reply: an answer, or a dismissal (with a message from a client that can't ask, e.g. `kete run`). */
export type Reply = { readonly kind: "answer"; readonly answer: Answer } | { readonly kind: "cancelled"; readonly message?: string }

export const LABELS = {
  "accept-edits": "Approve and let it edit (Accept edits)",
  default: "Approve, with the usual checks (Default)",
  revise: "Keep planning",
} as const satisfies Record<Decision, string>

/** A question-form answer: one of the labels, or the user's own words (feedback, so keep planning). */
export function decide(value: unknown): Answer {
  const text = typeof value === "string" ? value.trim() : Array.isArray(value) ? value.map(String).join(", ").trim() : ""
  for (const decision of Object.keys(LABELS) as Decision[]) if (text === LABELS[decision]) return { decision }
  return text ? { decision: "revise", feedback: text.slice(0, 4000) } : { decision: "revise" }
}

export interface Deps {
  /** Asks the user. */
  readonly ask?: (input: { sessionID: string; plan: string; messageID: string; callID: string }) => Effect.Effect<Reply>
}

const Input = Schema.Struct({
  plan: Schema.String.annotate({ description: "The full plan, in Markdown." }),
})

const Output = Schema.Struct({
  approved: Schema.Boolean,
  mode: Schema.String,
  feedback: Schema.String.pipe(Schema.optionalKey),
})

const fail = (message: string) => new ToolFailure({ message })

export function make(deps: Deps = {}) {
  return define({
    id,
    effect: Effect.fn("KetePlanApproval.Plugin")(function* (ctx) {
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const forms = Option.getOrUndefined(yield* Effect.serviceOption(Form.Service))
      const permission = yield* Permission.Service
      const fallback = KetePermissionMode.parse(process.env.KETE_PERMISSION_MODE) ?? "default"
      const lookup = (sessionID: string) => sessions.get(sessionID as SessionSchema.ID).pipe(Effect.option)

      /** Whether the session may present a plan: a root session, in Plan mode, not unattended. */
      const offered = Effect.fnUntraced(function* (sessionID: string) {
        const session = yield* lookup(sessionID)
        if (Option.isNone(session) || session.value.parentID !== undefined) return false
        const mode = yield* KetePermissionMode.resolveMode({ session: lookup, fallback }, sessionID as SessionSchema.ID)
        if (mode !== "plan") return false
        const unattended = yield* KeteUnattendedPolicy.resolve(lookup, sessionID as SessionSchema.ID).pipe(
          Effect.map((state) => state.kind === "unattended"),
          Effect.orElseSucceed(() => true),
        )
        return !unattended
      })

      // A question form (kind `question`), so every client shows it and `kete run` answers it with a message.
      const ask =
        deps.ask ??
        ((input: { sessionID: string; plan: string; messageID: string; callID: string }) =>
          Effect.gen(function* () {
            if (!forms) return { kind: "cancelled", message: "Plan approval needs a client that can ask questions." } as Reply
            const state = yield* forms
              .ask({
                sessionID: input.sessionID as SessionSchema.ID,
                title: "Approve this plan?",
                metadata: { kind: "question", tool: { messageID: input.messageID, id: input.callID }, kete: FORM_KIND },
                fields: [
                  {
                    key: "q0",
                    type: "string",
                    title: "Plan",
                    description: input.plan,
                    options: (Object.keys(LABELS) as Decision[]).map((decision) => ({ value: LABELS[decision], label: LABELS[decision] })),
                    custom: true,
                  },
                ],
              })
              .pipe(Effect.orDie)
            if (state.status === "answered") return { kind: "answer", answer: decide(state.answer.q0) } as Reply
            return { kind: "cancelled", ...(state.status === "cancelled" && state.message ? { message: state.message } : {}) } as Reply
          }))

      /** The agent the session runs: its own, else the default. */
      const current = (agent: AgentSchema.ID | undefined) => (agent ? Effect.succeed(agent) : agents.select().pipe(Effect.map((item) => item.id)))

      /** Where approval switches the `plan` agent to: the default agent, or `build` when the default is `plan`. */
      const target = Effect.fnUntraced(function* () {
        const selected = (yield* agents.select()).id
        if (selected !== PLAN_AGENT) return selected
        if (yield* agents.get(BUILD_AGENT)) return BUILD_AGENT
        return yield* fail("Your default agent is the Plan agent and there's no build agent to switch to: pick an agent yourself, then switch the permission mode.")
      })

      /** Leaves Plan mode: the mode on the (root) session, other metadata kept, and the `plan` agent for the default one. */
      const leave = Effect.fnUntraced(function* (sessionID: string, mode: "accept-edits" | "default") {
        // The user may have changed the mode while the question was open; never override that.
        if (!(yield* offered(sessionID))) return yield* fail("The session isn't in Plan mode any more, so the approval changed nothing.")
        const session = yield* sessions.get(sessionID as SessionSchema.ID)
        const switchTo = (yield* current(session.agent)) === PLAN_AGENT ? yield* target() : undefined
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: { ...session.metadata, [KetePermissionMode.metadataKey]: mode },
        })
        if (!switchTo) return session.agent
        yield* sessions.switchAgent({ sessionID: session.id, agent: switchTo })
        return switchTo
      })

      // One open plan question per session, so a stale second answer can't override the first.
      const open = new Set<string>()

      yield* ctx.tool
        .transform((editor) =>
          editor.add({
            name,
            options: { codemode: false },
            description,
            input: Input,
            output: Output,
            execute: (input, context) =>
              Effect.gen(function* () {
                if (!(yield* offered(context.sessionID)))
                  return yield* fail("present_plan is only available in Plan mode, in your own session (not a subagent or an unattended run).")
                const plan = input.plan.trim()
                if (plan === "") return yield* fail("The plan is empty. Write the full plan and call present_plan again.")
                if (plan.length > MAX_PLAN)
                  return yield* fail(`The plan is longer than ${MAX_PLAN} characters. Shorten it (keep files, steps and checks) and call present_plan again.`)
                yield* permission
                  .assert({
                    action: "question",
                    resources: ["*"],
                    sessionID: context.sessionID as SessionSchema.ID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })))
                if (open.has(context.sessionID)) return yield* fail("A plan is already waiting for the user's answer. Wait for it.")
                open.add(context.sessionID)
                const reply = yield* ask({ sessionID: context.sessionID, plan, messageID: context.messageID, callID: context.id }).pipe(
                  Effect.ensuring(Effect.sync(() => open.delete(context.sessionID))),
                )
                // Like the question tool: a plain dismissal ends the step; one with a message is feedback.
                if (reply.kind === "cancelled") {
                  if (reply.message !== undefined)
                    return yield* fail(`The plan wasn't approved: ${reply.message} You're still in Plan mode.`)
                  return yield* Effect.die(new QuestionTool.CancelledError())
                }
                const answer = reply.answer
                if (answer.decision === "revise") {
                  const feedback = answer.feedback
                  return {
                    output: { approved: false, mode: "plan", ...(feedback ? { feedback } : {}) },
                    content: [
                      {
                        type: "text" as const,
                        text: `The user wants changes to the plan.${feedback ? ` Their feedback:\n${feedback}` : " They gave no details: ask what to change."}\nYou're still in Plan mode: revise the plan, then present it again.`,
                      },
                    ],
                  }
                }
                const agent = yield* leave(context.sessionID, answer.decision)
                return {
                  output: { approved: true, mode: answer.decision },
                  content: [
                    {
                      type: "text" as const,
                      text: `The user approved the plan. Plan mode is off: the permission mode is now ${answer.decision === "accept-edits" ? "Accept edits" : "Default"}${agent ? `, and you're the ${agent} agent` : ""}. Implement the approved plan now, step by step, and verify it as planned.`,
                    },
                  ],
                }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: `present_plan failed: ${String(error)}`, error }),
                ),
              ),
          }),
        )
        .pipe(Effect.orDie)

      // Offer the tool (and its reminder) only where it can work.
      yield* ctx.session.hook("context", (event) =>
        Effect.gen(function* () {
          if (!(name in event.tools)) return
          if (!(yield* offered(event.sessionID))) {
            delete event.tools[name]
            return
          }
          event.system.push({ type: "text", text: reminder })
        }).pipe(Effect.catchCause(() => Effect.sync(() => void delete event.tools[name]))),
      )
      for (const hook of ["compaction", "generate"] as const)
        yield* ctx.session.hook(hook, (event) => Effect.sync(() => void delete event.tools[name]))
    }),
  })
}

export const Plugin = make()
