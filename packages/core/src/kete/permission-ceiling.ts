// A subagent can never do more than the agents above it. Upstream evaluates a child session's
// requests against the child agent's rules only (plus the session's), so a read-only parent that
// may start `general` got a child that edits files and runs commands. This plugin caps each
// decision at what every ancestor session's agent would get for the same request, with
// deny < ask < allow: a parent's deny denies the child, and a parent's ask makes the child ask.
// It only ever tightens, like kete/permission-mode.ts. Saved "always" approvals count for
// ancestors as they do for the child, so approving once doesn't lead to asking forever.

export * as KetePermissionCeiling from "./permission-ceiling.js"

import type { Permission as PermissionSchema } from "@opencode/schema/permission"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Effect, Option } from "effect"
import { Agent } from "../agent.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PermissionSaved } from "../permission/saved.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { Wildcard } from "../util/wildcard.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

type Effect = PermissionSchema.Effect

const rank: Record<Effect, number> = { deny: 0, ask: 1, allow: 2 }

/** The stricter of two decisions. */
export function stricter(a: Effect, b: Effect): Effect {
  return rank[a] <= rank[b] ? a : b
}

/** What `rules` decide for a request over `resources`: deny if any resource is denied, ask if any asks. */
export function decide(action: string, resources: ReadonlyArray<string>, rules: Permission.Ruleset): Effect {
  const effects = resources.map((resource) => Permission.evaluate(action, resource, rules).effect)
  if (effects.includes("deny")) return "deny"
  if (effects.includes("ask")) return "ask"
  return "allow"
}

/** Longest ancestor chain followed; a deeper chain is a cycle or corruption and fails closed. */
const MAX_DEPTH = 32

/** What the ceiling needs to look up; the plugin passes the runtime's services. */
export interface Lookup {
  readonly session: (sessionID: SessionSchema.ID) => Effect.Effect<Option.Option<SessionSchema.Info>>
  readonly agent: (agentID: string | undefined) => Effect.Effect<Agent.Info | undefined>
  /** Saved "always" approvals, as allow rules. */
  readonly approved: Effect.Effect<Permission.Ruleset>
  /** The session's unattended run policy (kete/unattended-policy.ts), as allow rules; `[]` when interactive. */
  readonly policy: (sessionID: SessionSchema.ID) => Effect.Effect<Permission.Ruleset>
}

/** The strictest decision any ancestor of `sessionID` gets for the request; "allow" for a root session. */
export const ceiling = Effect.fnUntraced(function* (
  lookup: Lookup,
  sessionID: SessionSchema.ID,
  action: string,
  resources: ReadonlyArray<string>,
) {
  const session = yield* lookup.session(sessionID)
  let parentID: SessionSchema.ID | undefined = Option.isSome(session) ? session.value.parentID : undefined
  let result: Effect = "allow"
  if (parentID === undefined) return result
  const approved = yield* lookup.approved
  // An unattended run's policy allows its root, so its ancestors (subagents ahead of it) get the
  // same allowance; without this a policy-allowed "ask" would be denied in subagents.
  const policy = yield* lookup.policy(sessionID)
  for (let depth = 1; parentID !== undefined; depth++) {
    if (depth > MAX_DEPTH) return "deny" as Effect
    const parent: Option.Option<SessionSchema.Info> = yield* lookup.session(parentID)
    // A missing ancestor can't be checked; upstream denies everything for a missing agent, too.
    if (Option.isNone(parent)) return "deny" as Effect
    // Resolved like Permission's own rules: no agent on the session means the default agent.
    const agent = yield* lookup.agent(parent.value.agent)
    const rules: Permission.Ruleset =
      agent === undefined
        ? [{ action: "*", resource: "*", effect: "deny" }]
        : Permission.merge(agent.permissions, parent.value.permissions ?? [])
    // Deny rules win over saved approvals, as in Permission.evaluateInput.
    const own = decide(action, resources, rules)
    result = stricter(result, own === "deny" ? "deny" : decide(action, resources, [...rules, ...approved, ...policy]))
    if (result === "deny") return result
    parentID = parent.value.parentID
  }
  return result
})

/** Applies the ceiling to one `evaluate` hook event. */
export const apply = Effect.fnUntraced(function* (
  lookup: Lookup,
  event: {
    readonly sessionID: SessionSchema.ID
    readonly action: string
    readonly resources: ReadonlyArray<string>
    effect: Effect
    message?: string
  },
) {
  if (event.effect === "deny") return
  const next = stricter(event.effect, yield* ceiling(lookup, event.sessionID, event.action, event.resources))
  if (next === event.effect) return
  event.effect = next
  if (next === "deny")
    event.message = `Permission denied: a subagent can't ${event.action} where the agent that started it can't.`
})

export const Plugin = {
  id: "kete.permission-ceiling",
  effect: Effect.fn("KetePermissionCeiling.Plugin")(function* (ctx: PluginContext) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const saved = yield* PermissionSaved.Service
    const location = yield* Location.Service
    const getForPolicy: KeteUnattendedPolicy.Get = (sessionID) => sessions.get(sessionID).pipe(Effect.option)
    const lookup: Lookup = {
      session: (sessionID) => sessions.get(sessionID).pipe(Effect.option),
      agent: (agentID) => agents.resolve(agentID),
      approved: saved
        .list({ projectID: location.project.id })
        .pipe(
          Effect.map((items) =>
            items.map((item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" })),
          ),
        ),
      policy: (sessionID) =>
        KeteUnattendedPolicy.resolve(getForPolicy, sessionID).pipe(
          Effect.map((state) =>
            state.kind === "unattended" && state.invalid === undefined
              ? (state.policy.allow ?? [])
                  .filter((rule) => !Wildcard.match("budget", rule.action) && !Wildcard.match("question", rule.action))
                  .map((rule): Permission.Rule => ({ action: rule.action, resource: rule.resource, effect: "allow" }))
              : [],
          ),
        ),
    }
    yield* ctx.permission.hook("evaluate", (event) => apply(lookup, event))
  }),
}
