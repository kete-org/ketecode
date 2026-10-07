// A session's permission mode, and Kete Code's safe defaults for interactive sessions.
//
// Upstream's default agent allows every action (`"*": allow`) except reads of `.env` files and
// paths outside the workspace. Kete Code layers its safe defaults on top of that here, on the
// permission service's `evaluate` hook, instead of editing upstream's agent defaults: when an
// allow comes only from that catch-all rule, the session's mode decides whether the request
// still runs without asking. A rule that names the action (from an agent, the user's or
// project's `permission` config, the session, or a saved "always" approval) is an explicit
// choice and is kept — except in "ask" and "plan" modes, which are explicit choices too.
//
// Modes (session metadata `kete.permissionMode`, inherited from the root session; sessions
// without it use `KETE_PERMISSION_MODE`, then "default"):
//   default      edits allowed; read-only and test/build shell commands allowed; every other shell
//                command, high-risk command (kete/shell-risk.ts) and web fetch/search asks.
//   accept-edits the same as default today (edits are already allowed by default); kept as an
//                explicit name for clients that offer it.
//   auto         edits and shell commands allowed, web fetch/search allowed; high-risk and
//                unparseable shell commands still ask. Not a bypass.
//   ask          asks before every edit, shell command and web fetch/search, even explicitly allowed ones.
//   plan         read-only: edits are denied; shell commands other than read-only ones are denied;
//                web fetch/search as default.
//
// It only ever tightens: the permission service decides deny before this hook runs, the result
// is never looser than the decision it was given, and organization and configuration policies
// (kete/sync/plugin.ts, config/plugin/policy.ts) run after it and can still deny. Unattended
// runs (kete/unattended.ts) keep their own fail-closed policy: the safe defaults don't apply in an
// unattended family, though an explicit "ask" or "plan" mode still tightens.

export * as KetePermissionMode from "./permission-mode.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Permission as PermissionSchema } from "@opencode/schema/permission"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"
import { Effect, Option } from "effect"
import { Agent } from "../agent.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PermissionSaved } from "../permission/saved.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteShellRisk } from "./shell-risk.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

export const metadataKey = KetePermissionModes.metadataKey
export const modes = KetePermissionModes.modes
export type Mode = KetePermissionModes.Mode

type Decision = PermissionSchema.Effect

/** The actions "ask" mode asks before: file edits (edit, write, patch), shell commands, web fetches and searches. */
export const guarded: ReadonlySet<string> = new Set(["edit", "shell", "webfetch", "websearch"])

const network: ReadonlySet<string> = new Set(["webfetch", "websearch"])

export const parse = KetePermissionModes.parse

const rank: Record<Decision, number> = { deny: 0, ask: 1, allow: 2 }
const stricter = (a: Decision, b: Decision): Decision => (rank[a] <= rank[b] ? a : b)

/** One resource of a request, as this module sees it. */
export interface Resource {
  /** The command or path. */
  readonly value: string
  /** True when the only rule allowing it is upstream's catch-all `"*": allow`. */
  readonly defaulted: boolean
}

export interface Input {
  readonly mode: Mode
  readonly action: string
  readonly resources: ReadonlyArray<Resource>
  /** Whether the session belongs to an unattended run (kete/unattended-policy.ts). */
  readonly unattended: boolean
}

export interface Outcome {
  readonly effect: Decision
  readonly message?: string
}

const PLAN_EDIT = "Plan mode is read-only: switch to another permission mode to edit files."

/**
 * What `input.mode` allows for one request, before the decision it was given: `allow` means "no
 * objection". The caller takes the stricter of this and the given decision, so it can never loosen.
 */
export function decide(input: Input): Outcome {
  const { mode, action } = input
  if (mode === "ask") return guarded.has(action) ? { effect: "ask", message: "Ask mode: approve each edit, command and web request." } : { effect: "allow" }
  if (mode === "plan") {
    if (action === "edit") return { effect: "deny", message: PLAN_EDIT }
    if (action === "shell") {
      for (const resource of input.resources) {
        const risk = KeteShellRisk.classify(resource.value)
        if (risk.risk !== "read")
          return { effect: "deny", message: `Plan mode is read-only: \`${short(resource.value)}\` ${risk.reason}.` }
      }
      return { effect: "allow" }
    }
  }
  if (input.unattended) return { effect: "allow" }
  if (action === "shell") {
    let result: Outcome = { effect: "allow" }
    for (const resource of input.resources) {
      if (!resource.defaulted) continue
      const risk = KeteShellRisk.classify(resource.value)
      const asks = risk.risk === "high" || (risk.risk === "other" && mode !== "auto")
      if (!asks) continue
      const message =
        risk.risk === "high"
          ? `High-risk command: \`${short(resource.value)}\` ${risk.reason}.`
          : `\`${short(resource.value)}\` ${risk.reason}.`
      if (result.effect === "allow" || risk.risk === "high") result = { effect: "ask", message }
    }
    return result
  }
  if (network.has(action) && mode !== "auto" && input.resources.some((resource) => resource.defaulted))
    return { effect: "ask", message: "Kete Code asks before web requests." }
  return { effect: "allow" }
}

function short(value: string) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > 120 ? line.slice(0, 117) + "..." : line
}

/** Applies `decide` to an `evaluate` hook event: only ever tightens. */
export function tighten(event: { effect: Decision; message?: string }, outcome: Outcome) {
  const next = stricter(event.effect, outcome.effect)
  if (next === event.effect) return
  event.effect = next
  if (outcome.message !== undefined) event.message = outcome.message
}

/** Longest ancestor chain followed when looking for the root session's mode. */
const MAX_DEPTH = 32

export interface Lookup {
  readonly session: (sessionID: SessionSchema.ID) => Effect.Effect<Option.Option<SessionSchema.Info>>
  readonly agent: (agentID: string | undefined) => Effect.Effect<Agent.Info | undefined>
  /** Saved "always" approvals, as allow rules. */
  readonly approved: Effect.Effect<Permission.Ruleset>
  /** The mode for sessions without one. */
  readonly fallback: Mode
}

/** The mode of the root-most session in `sessionID`'s family that has one, else the fallback. */
export const resolveMode = Effect.fnUntraced(function* (lookup: Lookup, sessionID: SessionSchema.ID) {
  let found: Mode | undefined
  let current: SessionSchema.ID | undefined = sessionID
  for (let depth = 0; current !== undefined && depth <= MAX_DEPTH; depth++) {
    const session: Option.Option<SessionSchema.Info> = yield* lookup.session(current)
    if (Option.isNone(session)) break
    const mode = parse(session.value.metadata?.[metadataKey])
    if (mode !== undefined) found = mode
    current = session.value.parentID
  }
  return found ?? lookup.fallback
})

const catchAll = (rule: Permission.Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"

/** Applies the session's mode to one `evaluate` hook event. */
export const apply = Effect.fnUntraced(function* (
  lookup: Lookup,
  event: {
    readonly sessionID: SessionSchema.ID
    readonly agent?: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    effect: Decision
    message?: string
  },
) {
  if (event.effect === "deny" || !guarded.has(event.action)) return
  const mode = yield* resolveMode(lookup, event.sessionID)
  // Nothing to tighten: "ask" already asks, and only Plan mode denies.
  if (event.effect === "ask" && mode !== "plan") return
  if (mode === "auto" && event.action !== "shell") return
  if ((mode === "default" || mode === "accept-edits") && event.action === "edit") return
  const session = yield* lookup.session(event.sessionID)
  const unattended =
    (yield* KeteUnattendedPolicy.resolve(lookup.session, event.sessionID)).kind === "unattended"
  // The rules the permission service used, to tell a catch-all allow from an explicit one.
  const info = Option.getOrUndefined(session)
  const agent = yield* lookup.agent(event.agent ?? info?.agent)
  const rules = [...Permission.merge(agent?.permissions ?? [], info?.permissions ?? []), ...(yield* lookup.approved)]
  const resources = event.resources.map((value) => ({
    value,
    defaulted: catchAll(Permission.evaluate(event.action, value, rules)),
  }))
  tighten(event, decide({ mode, action: event.action, resources, unattended }))
})

export const Plugin = define({
  id: "kete.permission-mode",
  effect: Effect.fn(function* (ctx) {
    const raw = process.env.KETE_PERMISSION_MODE
    const fallback = parse(raw) ?? "default"
    if (raw !== undefined && raw !== "" && !parse(raw))
      yield* Effect.logWarning("ignoring KETE_PERMISSION_MODE: expected one of " + modes.join(", "), { value: raw })
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const saved = yield* PermissionSaved.Service
    const location = yield* Location.Service
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
      fallback,
    }
    yield* ctx.permission.hook("evaluate", (event) => apply(lookup, event))
  }),
})
