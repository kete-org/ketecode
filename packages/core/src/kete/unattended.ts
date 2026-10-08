// ADR 0008: an unattended run (a session family where `kete.unattended` resolves via
// kete/unattended-policy.ts's `resolve`) never waits on a person. Two plugins, in hook order:
//
// - `PolicyPlugin`, early in `pre` (right after KeteBudgetRule, before KetePermissionMode): an
//   "allow" that only came from a saved "always" approval is recomputed from the session's and
//   agent's rules alone (D3, ignoring saved approvals the way permission-ceiling.ts's ceiling does
//   for ancestors); then an "ask" whose every resource matches the run's policy becomes "allow".
// - `Plugin`, last in `post` (after ConfigPolicyPlugin): any "ask" still standing becomes "deny" —
//   another hook's "allow → ask" (permission mode, the ceiling, an org policy) always ends denied,
//   never allowed. It also watches `session.execution.started` and interrupts a session that runs
//   past the run's time limit mid-step. It installs kete/audit.ts's read-only audit hooks last, so
//   they see this plugin's own late "ask becomes deny" decision (D1 B, docs/upstream-patches.md
//   "Unattended runs": audit hooks ride on this plugin's id, no new upstream edit).
//
// `KeteRunChecks` (run-checks.ts) calls `check` before every step of an unattended family instead of
// KeteBudget: it requires both a budget and a time limit and refuses the step once either is spent,
// and (kete/audit.ts) writes the run's `run started` audit line first, fail closed.

export * as KeteUnattended from "./unattended.js"

import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { define } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { Agent as AgentSchema } from "@opencode/schema/agent"
import type { ConfigKete } from "@opencode/schema/config/kete"
import { KeteUnattendedSchema } from "@opencode/schema/kete/unattended"
import { SessionError } from "@opencode/schema/session-error"
import { Global } from "@opencode/util/global"
import { DateTime, Duration, Effect, FiberMap, Option, Stream } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import { StepFailedError } from "../session/error.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { KeteAudit } from "./audit.js"
import { KeteBudget } from "./budget.js"
import { KetePermissionCeiling } from "./permission-ceiling.js"
import { KeteSandboxActions } from "./sandbox/actions.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

/** Longest family cost walk; mirrors unattended-policy.ts's ancestor-chain guard. */
const MAX_DEPTH = 32

export interface Limits {
  /** USD; the stricter of the policy's `budget` and `kete.budget.session`. */
  readonly budget?: number
  /** The policy's `timeout`, or an explicitly configured `kete.subagents.timeout` (0 doesn't count). */
  readonly timeout?: Duration.Duration
  readonly missing: ReadonlyArray<"budget" | "time limit">
}

export function limits(policy: KeteUnattendedPolicy.Policy, kete: ConfigKete.Info | undefined): Limits {
  const budgets = [policy.budget, kete?.budget?.session].filter((value): value is number => value !== undefined)
  const budget = budgets.length > 0 ? Math.min(...budgets) : undefined

  const explicit = kete?.subagents?.timeout
  const minutes = policy.timeout ?? (explicit !== undefined && explicit > 0 ? explicit : undefined)
  const timeout = minutes !== undefined ? Duration.minutes(minutes) : undefined

  const missing: Array<"budget" | "time limit"> = []
  if (budget === undefined) missing.push("budget")
  if (timeout === undefined) missing.push("time limit")
  return { budget, timeout, missing }
}

/** What `check` needs; `make` builds this from the real services. */
export interface Lookup {
  readonly session: KeteUnattendedPolicy.Get
  readonly children: (parentID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionSchema.Info>>
  readonly config: Effect.Effect<ConfigKete.Info | undefined>
  /** Epoch millis. */
  readonly now: Effect.Effect<number>
}

const familyCost = Effect.fnUntraced(function* (lookup: Lookup, root: SessionSchema.Info) {
  let total = root.cost as number
  let frontier: ReadonlyArray<SessionSchema.ID> = [root.id]
  for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth++) {
    const next: SessionSchema.ID[] = []
    for (const id of frontier) {
      for (const child of yield* lookup.children(id)) {
        total += child.cost as number
        next.push(child.id)
      }
    }
    frontier = next
  }
  return total
})

function refused(missing: Limits["missing"]) {
  return new StepFailedError({
    error: SessionError.Error.make({ type: "unattended", message: KeteUnattendedSchema.refused(missing) }),
  })
}

function stoppedDeadline(timeout: Duration.Duration) {
  return new StepFailedError({
    error: SessionError.Error.make({
      type: "unattended",
      message: KeteUnattendedSchema.timeLimit(Duration.toMinutes(timeout)),
    }),
  })
}

function stoppedBudget(budget: number, spent: number) {
  return new StepFailedError({
    error: SessionError.Error.make({
      type: "unattended",
      message: KeteUnattendedSchema.budget(KeteBudget.usd(budget), KeteBudget.usd(spent)),
    }),
  })
}

/** Pure over `lookup`; the four required-limit and stop conditions in ADR 0008. A no-op for an
 * interactive family (defensive: the runner only calls this for an unattended one). */
export const check = Effect.fnUntraced(function* (
  lookup: Lookup,
  input: { readonly sessionID: SessionSchema.ID; readonly agent: AgentSchema.ID },
) {
  const state = yield* KeteUnattendedPolicy.resolve(lookup.session, input.sessionID)
  if (state.kind === "interactive") return
  const policy = state.invalid === undefined ? state.policy : KeteUnattendedPolicy.emptyPolicy
  const kete = yield* lookup.config
  const effective = limits(policy, kete)
  if (effective.missing.length > 0) return yield* Effect.fail(refused(effective.missing))
  const now = yield* lookup.now
  const deadline = DateTime.toEpochMillis(state.root.time.created) + Duration.toMillis(effective.timeout!)
  if (now >= deadline) return yield* Effect.fail(stoppedDeadline(effective.timeout!))
  const cost = yield* familyCost(lookup, state.root)
  if (cost >= effective.budget!) return yield* Effect.fail(stoppedBudget(effective.budget!, cost))
})

/** Why an unattended family's run ended, when it didn't simply succeed; `undefined` under both limits.
 * Shares `check`'s three comparisons (missing limit, deadline, family cost) so the audit log's "run
 * ended" reason (kete/audit.ts) always agrees with why the runner actually stopped the run. */
export const stopReason = Effect.fnUntraced(function* (lookup: Lookup, sessionID: SessionSchema.ID) {
  const state = yield* KeteUnattendedPolicy.resolve(lookup.session, sessionID)
  if (state.kind === "interactive") return undefined
  const policy = state.invalid === undefined ? state.policy : KeteUnattendedPolicy.emptyPolicy
  const kete = yield* lookup.config
  const effective = limits(policy, kete)
  if (effective.missing.length > 0) return "refused"
  const now = yield* lookup.now
  const deadline = DateTime.toEpochMillis(state.root.time.created) + Duration.toMillis(effective.timeout!)
  if (now >= deadline) return "time_limit"
  const cost = yield* familyCost(lookup, state.root)
  if (cost >= effective.budget!) return "budget"
  return undefined
})

/** Resolves the services once; the returned checker runs before each step of an unattended family. */
export const make = Effect.gen(function* () {
  const store = yield* SessionStore.Service
  const config = yield* Config.Service
  const lookup: Lookup = {
    session: (id) => store.get(id).pipe(Effect.map(Option.fromNullishOr)),
    children: (parentID) => store.list({ parentID }),
    config: Effect.map(config.entries(), (entries) => Config.latest(entries, "kete")),
    now: Effect.sync(() => Date.now()),
  }
  return Effect.fn("KeteUnattended.check")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: AgentSchema.ID
  }) {
    yield* check(lookup, input)
  })
})

/** Location nodes the checker needs, for the runner's dependency list. */
export const nodes = [SessionStore.node, Config.node] as const

/** What the early hook needs to recompute a saved-approval "allow" (D3). */
export interface PolicyLookup {
  readonly session: KeteUnattendedPolicy.Get
  readonly agent: (agentID: string | undefined) => Effect.Effect<{ readonly permissions: Permission.Ruleset } | undefined>
}

/**
 * Early `evaluate` hook, pure over `lookup`: an unattended family's saved-approval "allow" is
 * treated as "ask" (D3), then an "ask" the run's policy allows becomes "allow". Never touches "deny".
 */
export const applyPolicy = Effect.fnUntraced(function* (lookup: PolicyLookup, event: PermissionEvaluation) {
  const state = yield* KeteUnattendedPolicy.resolve(lookup.session, event.sessionID)
  if (state.kind !== "unattended") return
  const policy = state.invalid === undefined ? state.policy : KeteUnattendedPolicy.emptyPolicy

  if (event.effect === "allow") {
    const session = yield* lookup.session(event.sessionID)
    const agent = yield* lookup.agent(event.agent ?? (Option.isSome(session) ? session.value.agent : undefined))
    const rules: Permission.Ruleset =
      agent === undefined
        ? [{ action: "*", resource: "*", effect: "deny" }]
        : Permission.merge(agent.permissions, (Option.isSome(session) ? session.value.permissions : undefined) ?? [])
    if (KetePermissionCeiling.decide(event.action, event.resources, rules) !== "allow") event.effect = "ask"
  }

  if (event.effect === "ask" && KeteUnattendedPolicy.allows(policy, event.action, event.resources)) {
    event.effect = "allow"
    // The run's policy is the person's approval in advance; the sandbox's last hook turns this into
    // network access if the decision is still "allow" at the end (kete/sandbox.ts).
    if (event.action === "shell") KeteSandboxActions.markPolicyAllowed(event.metadata)
  }
})

/** What `applyLate` needs to recognize a Kete-configuration target (D2). */
export interface ConfigLookup {
  readonly globalConfig: string
}

/**
 * Late `evaluate` hook, pure over `get`: in an unattended family, editing Kete configuration is
 * always denied (D2, checked first — an "allow" from any earlier hook is overridden, not just an
 * "ask"); otherwise any "ask" still standing becomes "deny". Nothing here ever produces "allow".
 */
export const applyLate = Effect.fnUntraced(function* (
  get: KeteUnattendedPolicy.Get,
  event: PermissionEvaluation,
  lookup: ConfigLookup,
) {
  const state = yield* KeteUnattendedPolicy.resolve(get, event.sessionID)
  if (state.kind !== "unattended") return
  if (event.effect !== "deny" && KeteUnattendedPolicy.configTarget(event.action, event.resources, lookup)) {
    event.effect = "deny"
    event.message = "unattended run: editing Kete configuration (.kete/, kete.json, the global config) is not allowed"
    return
  }
  if (event.effect !== "ask") return
  event.effect = "deny"
  event.message =
    event.action === "question"
      ? "unattended run: no one to answer questions"
      : "unattended run: not allowed by this run's policy"
})

export const PolicyPlugin = define({
  id: "kete.unattended.policy",
  effect: Effect.fn("KeteUnattended.PolicyPlugin")(function* (ctx: PluginContext) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const lookup: PolicyLookup = {
      session: (id) => sessions.get(id).pipe(Effect.option),
      agent: (agentID) => agents.resolve(agentID),
    }
    yield* ctx.permission.hook("evaluate", (event) => applyPolicy(lookup, event))
  }),
})

/** Also stops a session that runs past the run's time limit mid-step, and installs the audit hooks
 * (kete/audit.ts) last, so they see this plugin's own late "ask becomes deny" decision. */
export const Plugin = define({
  id: "kete.unattended",
  effect: Effect.fn("KeteUnattended.Plugin")(function* (ctx: PluginContext) {
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const global = yield* Global.Service
    const get: KeteUnattendedPolicy.Get = (id) => sessions.get(id).pipe(Effect.option)

    yield* ctx.permission.hook("evaluate", (event) => applyLate(get, event, { globalConfig: global.config }))

    const timerLookup: TimerLookup = {
      session: get,
      config: Effect.map(config.entries(), (entries) => Config.latest(entries, "kete")),
      interrupt: (sessionID) => sessions.interrupt(sessionID).pipe(Effect.asVoid),
    }
    const timers = yield* FiberMap.make<SessionSchema.ID, void>()
    yield* bus.subscribe(SessionEvent.Execution.Started).pipe(
      Stream.runForEach((event) =>
        watch(timerLookup, timers, event.data.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to watch an unattended run's time limit", { cause }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    const auditLookup: Lookup = {
      session: get,
      children: (parentID) => sessions.list({ parentID }).pipe(Effect.map((result) => result.data)),
      config: Effect.map(config.entries(), (entries) => Config.latest(entries, "kete")),
      now: Effect.sync(() => Date.now()),
    }
    yield* KeteAudit.install(ctx, {
      session: get,
      dataDir: global.data,
      interrupt: (sessionID) => sessions.interrupt(sessionID).pipe(Effect.asVoid),
      stopReason: (sessionID) => stopReason(auditLookup, sessionID),
    })
  }),
})

/** What `watch` needs to schedule and act on a session's run-time deadline. */
export interface TimerLookup {
  readonly session: KeteUnattendedPolicy.Get
  readonly config: Effect.Effect<ConfigKete.Info | undefined>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/**
 * Forks, in `timers` keyed by session ID, a sleep until the family's deadline, then interrupts
 * `sessionID`. A no-op outside an unattended family or without a time limit.
 */
export const watch = Effect.fnUntraced(function* (
  lookup: TimerLookup,
  timers: FiberMap.FiberMap<SessionSchema.ID, void>,
  sessionID: SessionSchema.ID,
) {
  const state = yield* KeteUnattendedPolicy.resolve(lookup.session, sessionID)
  if (state.kind !== "unattended") return
  const policy = state.invalid === undefined ? state.policy : KeteUnattendedPolicy.emptyPolicy
  const kete = yield* lookup.config
  const effective = limits(policy, kete)
  if (effective.timeout === undefined) return
  const deadline = DateTime.toEpochMillis(state.root.time.created) + Duration.toMillis(effective.timeout)
  const sleep = Duration.millis(Math.max(0, deadline - Date.now()))
  const timeout = effective.timeout
  yield* FiberMap.run(
    timers,
    sessionID,
    Effect.gen(function* () {
      yield* Effect.sleep(sleep)
      yield* lookup.interrupt(sessionID)
      yield* Effect.logWarning("unattended run: session stopped, it reached its run time limit", {
        sessionID,
        minutes: Duration.toMinutes(timeout),
      })
    }),
  )
})
