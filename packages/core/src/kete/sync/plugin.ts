// Platform-managed agents (docs/platform/sync-v1.md, kete-code-platform ADR 0008).
//
// When signed in with `kete login`, the organization's agents are synced into
// <config>/managed/<organization id>/agents.json (@opencode/util/kete/sync) at startup and every
// 5 minutes (also by `kete sync` and after `kete login`), and served from that cache:
// - A managed agent replaces a local agent with the same slug entirely. The plugin is registered
//   after ConfigAgentPlugin, so it has the last word.
// - Its permissions are the default base, then the local global rules, then the managed rules:
//   the last matching rule wins, so the organization's rules override the user's.
// - Its model is the Kete gateway's (`kete/<model_id>`), and every model call it makes carries
//   `x-kete-agent-id` and `x-kete-agent-version`, which the gateway uses for per-agent budgets.
// - The description ends with "Managed by <organization>", which clients that list agents show.
// - An agent the platform marks delegable is `all` (ADR 0017): the sync contract only ever sends
//   `mode: "primary"` plus `delegable: true`, mapped to Kete's `mode: "all"` in `apply` below.
// Offline or on a platform error the last cached copy stays in use and a warning is logged; the
// cache is never deleted on errors. Not signed in: nothing changes.
//
// Skills and MCP servers the synced agents name come with them (sync v1 `skills`, `mcp_servers`):
// - Skills are written to <config>/managed/<organization id>/skills/<slug>/ (@opencode/util/kete/
//   sync/skills) and registered from there; a managed skill replaces a local one with the same slug.
// - MCP servers are registered as mapped in ./mcp.ts; a stdio server stays disabled until its exact
//   command is approved (`kete sync --approve <key>`). An agent that isn't managed asks before using
//   a managed server's tools where its own rules would allow them without asking.
//
// Organization policies (sync v1 `policies`, @opencode/util/kete/sync/policy) are enforced on the
// permission `evaluate` hook, on top of every agent's rules and the user's configuration: an
// enforced policy turns an allowed request into a prompt or a denial and never loosens anything;
// audit-only ones are logged. The hook only runs for requests nothing denied yet. Fail closed: while
// signed in without the organization's policies (never synced, or the cache is unreadable), edits,
// shell commands and web requests ask first.
//
// The runtime installation registers with the platform (@opencode/util/kete/runtime-registration)
// at startup when due and daily after, so the organization sees which runtimes it runs.
//
// Agent errors from the gateway (x-kete-error-code, docs/gateway.md §2.7) are made clear and final:
// the response's error message is replaced with Kete's (the TUI and the web UI show that message),
// `x-should-retry: false` is added and the retry hook vetoes retries. An agent the gateway reports
// as paused, unknown or on a model it no longer allows is out of date here, so a sync runs at once
// (debounced) and the agent list follows the platform.
//
// Job mode (KETE_JOB_MODE, job mode piece A2): the account is never read. The credential is the
// job's gateway key (KeteJobSecrets) and the entrypoint's KETE_PLATFORM_URL; the cache loaded at
// startup is the organization's that `kete job run`'s first sync wrote (KeteJobSecrets.organization).
// The job counts as signed in to its key's organization, so without the policies (no cache) the guard
// above applies and unattended mode (unattended.ts) turns its `ask` into a denial. Later refreshes
// keep the last copy on failure, as above.

export * as KeteAgentSync from "./plugin.js"

import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import type { Document } from "@opencode/schema/config"
import { KeteAccount } from "@opencode/util/kete/account"
import { KeteRuntimeRegistration } from "@opencode/util/kete/runtime-registration"
import { KeteSyncPolicy } from "@opencode/util/kete/sync/policy"
import { Brand } from "@opencode/util/kete/brand"
import { KeteSyncApprovals } from "@opencode/util/kete/sync/approvals"
import type { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { KeteSyncSkills } from "@opencode/util/kete/sync/skills"
import { KeteSync } from "@opencode/util/kete/sync/sync"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import { Global } from "@opencode/util/global"
import { Duration, Effect, Exit, Queue, Schedule, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigAgentPlugin } from "../../config/plugin/agent.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"
import { Wildcard } from "../../util/wildcard.js"
import { KeteSyncMcp } from "./mcp.js"
import type { PluginInternal } from "../../plugin/internal.js"
import { Provider } from "../../provider.js"
import { KeteGateway } from "../gateway.js"
import { KeteOffline } from "../offline.js"

export const agentIDHeader = "x-kete-agent-id"
export const agentVersionHeader = "x-kete-agent-version"
export const errorCodeHeader = "x-kete-error-code"

/** Gateway agent errors (kete-code-platform apps/gateway/src/errors/errors.ts). */
export const agentErrors = {
  budget: "kete_agent_budget_exceeded",
  stale: ["kete_agent_paused", "kete_agent_not_found", "kete_agent_model_not_allowed"],
} as const

/** The message the user sees for a gateway agent error, or undefined for any other error code. */
export function agentErrorMessage(code: string, agentName: string | undefined) {
  const agent = agentName ? `“${agentName}”` : "This agent"
  if (code === agentErrors.budget)
    return `Agent budget reached: ${agent} has used its monthly budget. Ask an admin in your organization to raise it in the ${Brand.displayName} portal.`
  if ((agentErrors.stale as readonly string[]).includes(code))
    return `Agent unavailable: ${agent} was paused or changed by your organization. It is being removed from your agents; choose another agent.`
  return undefined
}

/** The provider error body with its message replaced; the rest of the body (type, code, details) is kept. */
export function rewriteErrorBody(text: string, message: string) {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "object" && parsed.error !== null)
    return JSON.stringify({ ...parsed, error: { ...parsed.error, message } })
  return JSON.stringify({ error: { message } })
}

/** A local runtime's environment kind, for policies limited to some environments. */
export const environment = "development"

/** What asks first while the organization's policies aren't loaded (fail closed). */
export const guardedWithoutPolicies: ReadonlySet<string> = new Set(["edit", "shell", "webfetch"])

export function make(
  options: {
    readonly interval?: Duration.Input
    readonly account?: KeteSync.Options
    /** Runtime registration; tests turn it off or point it elsewhere. */
    readonly registration?: { readonly every: Duration.Input } | false
    /** Where KETE_RUNTIME_TYPE is read from; tests point this elsewhere. */
    readonly environment?: Record<string, string | undefined>
    /** Job mode's key and organization; default to the in-memory overlay (job-secrets.ts). Tests inject these. */
    readonly job?: {
      readonly key?: () => string | undefined
      readonly organization?: () => string | undefined
    }
  } = {},
) {
  const interval = options.interval ?? "5 minutes"
  // Named apart from the `environment` export above (an environment *kind*, for policies).
  const runtimeEnvironment = options.environment ?? process.env
  return define({
    id: "kete.agent.sync",
    effect: Effect.fn(function* (ctx) {
      const config = yield* Config.Service
      const global = yield* Global.Service
      const jobMode = KeteJobMode.enabled(runtimeEnvironment)
      // Offline mode (--offline, KETE_OFFLINE or kete.offline): the cache is loaded, nothing is sent.
      const offline = KeteOffline.enabled(runtimeEnvironment, Config.latest(yield* config.entries(), "kete"))
      const jobKey = options.job?.key ?? KeteJobSecrets.gatewayKey
      const jobOrganization = options.job?.organization ?? KeteJobSecrets.organization
      // Job mode never touches the OS key store (`native: undefined`; job mode refuses to spawn it).
      const syncOptions =
        options.account ??
        (jobMode ? { config: Global.Path.config, data: Global.Path.data, native: undefined } : KeteAccount.defaults())
      const state = {
        cached: undefined as KeteSyncCache.Cached | undefined,
        globalRules: [] as readonly Agent.Info["permissions"][number][],
        /** Approved stdio commands, and the skills fully on disk, for the cached organization. */
        approvals: {} as Record<string, string>,
        skills: new Set<string>(),
        /** Signed in (to this organization name) according to the account file. */
        account: undefined as { readonly organization: string } | undefined,
        /** Audit-only matches already logged, so a busy session doesn't repeat them. */
        audited: new Set<string>(),
      }
      // Job mode never reads the account file: the job is always "signed in" to its key's
      // organization, so the fail-closed guard below applies until the policies are loaded.
      const readAccount = jobMode
        ? Effect.sync(() => ({ organization: state.cached?.response.organization.name ?? "the job's organization" }))
        : Effect.tryPromise(() => KeteAccount.read(syncOptions)).pipe(
            Effect.map((account) => (account ? { organization: account.organization.name } : undefined)),
            // An unreadable account file counts as signed in to an unknown organization: fail closed.
            Effect.catch(() => Effect.succeed({ organization: "your organization" })),
          )
      const missingCredential = `${Brand.displayName} job mode has no platform URL or gateway key to sync managed agents with`
      const jobCredential = (): KeteSync.Credential | undefined => {
        const platform = KeteJobMode.endpoints(runtimeEnvironment).platform
        const key = jobKey()
        if (!platform || !key) return undefined
        return { platform, key, organization: state.cached?.response.organization.id ?? jobOrganization() }
      }
      state.account = yield* readAccount
      const refresh = Effect.fn("KeteAgentSync.refresh")(function* (cached: KeteSyncCache.Cached | undefined) {
        state.cached = cached
        if (!cached) return
        const organization = cached.response.organization.id
        state.approvals = yield* Effect.promise(() => KeteSyncApprovals.read(syncOptions.config, organization))
        state.skills = yield* Effect.promise(() => KeteSyncSkills.present(syncOptions.config, organization))
        for (const server of cached.response.mcp_servers ?? []) {
          const mapped = KeteSyncMcp.map(server, state.approvals)
          if (mapped.note)
            yield* Effect.logWarning(`${Brand.displayName} MCP server ${server.key}: ${mapped.config.disabled ? "disabled, " : ""}${mapped.note}`)
        }
      })

      // The last synced copy, for the signed-in account (job mode: the first sync's organization,
      // which `kete job run` made before this server started). Unreadable is logged, never fatal.
      const startupCredential = jobMode ? jobCredential() : undefined
      if (jobMode && !startupCredential) yield* Effect.logError(missingCredential)
      yield* Effect.tryPromise(() =>
        jobMode && !startupCredential ? Promise.resolve(undefined) : KeteSync.load({ ...syncOptions, credential: startupCredential }),
      ).pipe(
        Effect.flatMap((loaded) => refresh(loaded?.cached)),
        Effect.catch((cause) => Effect.logWarning(`${Brand.displayName} managed agents unavailable`, { cause })),
      )

      yield* ctx.agent.transform((editor) => {
        const cached = state.cached
        if (!cached) return
        // Transforms are synchronous; Config.entries() reads the loaded config in memory. Should it
        // ever suspend, the rules read last time stay in use rather than failing the agent list.
        const entries = Effect.runSyncExit(config.entries())
        if (Exit.isSuccess(entries))
          state.globalRules = ConfigAgentPlugin.expandPermissions(globalPermissions(entries.value), global.home)
        const globalRules = state.globalRules
        for (const managed of cached.response.agents) {
          // Start from nothing: no field of a local agent with the same slug survives.
          editor.remove(Agent.ID.make(managed.slug))
          editor.update(Agent.ID.make(managed.slug), (agent) =>
            apply(agent, managed, cached.response.organization.name, globalRules),
          )
        }
        // Agents that aren't managed ask before a managed MCP tool their own rules would allow silently;
        // a rule that denies or asks stays as it is.
        const managedAgents = new Set(cached.response.agents.map((agent) => agent.slug))
        const tools = (cached.response.mcp_servers ?? []).flatMap((server) =>
          server.tools.map((tool) => `${server.key}_${tool.name}`),
        )
        for (const agent of editor.list()) {
          if (managedAgents.has(agent.id)) continue
          const silent = tools.filter((tool) => Permission.evaluate(tool, "*", agent.permissions).effect === "allow")
          if (silent.length > 0)
            editor.update(agent.id, (current) => {
              current.permissions.push(...silent.map((action) => ({ action, resource: "*", effect: "ask" as const })))
            })
        }
      })

      yield* ctx.skill.transform((editor) => {
        const cached = state.cached
        if (!cached) return
        for (const skill of cached.response.skills ?? []) {
          // Only skills whose files are on disk: a failed download leaves the previous copy, or none.
          if (!state.skills.has(skill.slug)) continue
          editor.remove(skill.slug)
          editor.add(
            Skill.Info.make({
              id: Skill.ID.make(skill.slug),
              name: Skill.Name.make(skill.name),
              description: skill.description
                ? `${skill.description} · Managed by ${cached.response.organization.name}`
                : `Managed by ${cached.response.organization.name}`,
              path: AbsolutePath.make(
                path.join(KeteSyncSkills.skillDirectory(syncOptions.config, cached.response.organization.id, skill.slug), "SKILL.md"),
              ),
              content: skill.instructions,
            }),
          )
        }
      })

      yield* ctx.mcp.transform((editor) => {
        const cached = state.cached
        if (!cached) return
        for (const server of cached.response.mcp_servers ?? [])
          editor.set(server.key, KeteSyncMcp.map(server, state.approvals).config)
      })

      const gateway = { providerID: KeteGateway.providerID }
      yield* ctx.session.hook(
        "model.request",
        (evt) =>
          Effect.sync(() => {
            if (evt.model.providerID !== KeteGateway.providerID) return
            const managed = state.cached?.response.agents.find((agent) => agent.slug === evt.agent)
            if (!managed) return
            evt.headers[agentIDHeader] = managed.id
            evt.headers[agentVersionHeader] = String(managed.version)
          }),
        gateway,
      )

      // Sessions whose last gateway response was an agent error: their retry is vetoed.
      const refused = new Set<string>()
      const resync = yield* Queue.sliding<void>(1)
      yield* ctx.session.hook(
        "http.response",
        (evt) =>
          Effect.gen(function* () {
            refused.delete(evt.sessionID)
            if (evt.model.providerID !== KeteGateway.providerID) return
            const code = evt.response.headers.get(errorCodeHeader)
            if (!code) return
            const managed = state.cached?.response.agents.find((agent) => agent.slug === evt.agent)
            const message = agentErrorMessage(code, managed?.name)
            if (!message) return
            const body = yield* Effect.promise(() => evt.response.text().catch(() => ""))
            const headers = new Headers(evt.response.headers)
            headers.set("x-should-retry", "false")
            headers.delete("content-length")
            headers.delete("content-encoding")
            evt.response = new Response(rewriteErrorBody(body, message), {
              status: evt.response.status,
              statusText: evt.response.statusText,
              headers,
            })
            refused.add(evt.sessionID)
            yield* Effect.logWarning(`${Brand.displayName} gateway refused the agent`, { agent: evt.agent, code })
            if ((agentErrors.stale as readonly string[]).includes(code)) yield* Queue.offer(resync, undefined)
          }),
        gateway,
      )
      yield* ctx.session.hook(
        "retry",
        (evt) =>
          Effect.sync(() => {
            if (refused.has(evt.sessionID)) evt.decision = { retry: false }
          }),
        gateway,
      )

      yield* ctx.permission.hook("evaluate", (event) =>
        Effect.gen(function* () {
          if (event.effect === "deny") return
          const cached = state.cached
          if (!cached) {
            if (!state.account || event.effect !== "allow" || !guardedWithoutPolicies.has(event.action)) return
            event.effect = "ask"
            event.message = jobMode
              ? `${Brand.displayName} hasn't loaded ${state.account.organization}'s policies, so it asks first.`
              : `${Brand.displayName} hasn't loaded ${state.account.organization}'s policies yet, so it asks first. Run \`${Brand.cliName} sync\` to load them.`
            return
          }
          const organization = cached.response.organization.name
          const result = KeteSyncPolicy.evaluate(
            cached.response.policies ?? [],
            { action: event.action, resources: event.resources, agent: event.agent, environment },
            Wildcard.match,
          )
          for (const item of result.audit) {
            const key = `${item.policy.id}\n${event.action}\n${item.resource}`
            if (state.audited.has(key)) continue
            if (state.audited.size >= 500) state.audited.clear()
            state.audited.add(key)
            yield* Effect.logInfo(`${Brand.displayName} audit-only policy would ${item.effect === "deny" ? "block" : "ask for"} a request`, {
              policy: item.policy.name,
              action: event.action,
              resource: item.resource,
              sessionID: event.sessionID,
            })
          }
          const decision = result.enforced
          if (!decision) return
          const reason = decision.rule.description ? ` (${decision.rule.description})` : ""
          if (decision.effect === "deny") {
            event.effect = "deny"
            event.message = `Blocked by ${organization}'s policy “${decision.policy.name}”${reason}.`
            return
          }
          if (event.effect === "allow") {
            event.effect = "ask"
            event.message = `${organization}'s policy “${decision.policy.name}” needs your approval for this${reason}.`
          }
        }),
      )

      // Job mode: no key or platform URL to sync with means nothing to fetch; the guard stays on.
      const run = Effect.suspend((): Effect.Effect<KeteSync.Outcome | undefined, unknown> => {
        if (!jobMode) return Effect.tryPromise(() => KeteSync.sync(syncOptions))
        const credential = jobCredential()
        if (!credential) return Effect.logError(missingCredential).pipe(Effect.as(undefined))
        return Effect.tryPromise(() => KeteSync.sync({ ...syncOptions, credential }))
      })
      const sync = run.pipe(
        Effect.tap(() => readAccount.pipe(Effect.map((account) => void (state.account = account)))),
        Effect.flatMap((outcome) => {
          if (!outcome) return Effect.void
          const skillsChanged =
            outcome.kind !== "signed-out" &&
            outcome.kind !== "failed" &&
            (outcome.skills.written.length > 0 || outcome.skills.removed.length > 0)
          if (outcome.kind === "updated" || skillsChanged) {
            const cached = outcome.kind === "updated" || outcome.kind === "unchanged" ? outcome.cached : state.cached
            return refresh(cached).pipe(
              Effect.andThen(
                Effect.logInfo(`${Brand.displayName} managed agents, skills and MCP servers updated`, {
                  agents: outcome.kind === "updated" ? outcome.changes : undefined,
                  skills: outcome.kind === "updated" || outcome.kind === "unchanged" ? outcome.skills : undefined,
                }),
              ),
              Effect.andThen(ctx.agent.reload()),
              Effect.andThen(ctx.skill.reload()),
              Effect.andThen(ctx.mcp.reload()),
            )
          }
          if (outcome.kind === "unchanged" && outcome.skills.failed.length > 0)
            return Effect.logWarning(`${Brand.displayName} some managed skills could not be downloaded`, {
              failed: outcome.skills.failed,
            })
          if (outcome.kind === "failed")
            return Effect.logWarning(
              `${Brand.displayName} managed agents could not be synced; using the last copy`,
              { error: outcome.error.message, cached: outcome.cached !== undefined },
            )
          return Effect.void
        }),
        Effect.catch((cause) => Effect.logWarning(`${Brand.displayName} managed agent sync failed`, { cause })),
      )
      // Startup, then every `interval`. Forked, so a slow platform never delays startup. Offline mode
      // sends nothing: the copy loaded above (and so its policies and the fail-closed guard) stays as it is.
      if (offline) yield* Effect.logInfo(`${Brand.displayName} offline: platform sync paused, using the cached copy`)
      else yield* sync.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)

      if (offline) {
        // No runtime registration while offline either.
      } else if (options.registration !== false && jobMode) {
        yield* Effect.logInfo(`${Brand.displayName} runtime registration is off in job mode`)
      } else if (options.registration !== false) {
        // Resolved on every tick, so a config change is picked up without a restart.
        const register = Effect.gen(function* () {
          const entries = yield* config.entries()
          const resolved = KeteRuntimeRegistration.resolveRuntimeType(Config.latest(entries, "kete")?.runtime?.type, runtimeEnvironment)
          if (resolved.kind === "invalid") {
            yield* Effect.logError(`${Brand.displayName} runtime registration skipped: unknown runtime type`, {
              source: resolved.source,
              value: resolved.value,
            })
            return
          }
          const outcome = yield* Effect.tryPromise(() =>
            KeteRuntimeRegistration.register({ ...syncOptions, version: ctx.app.version, runtimeType: resolved.type }),
          )
          yield* outcome.kind === "failed"
            ? Effect.logWarning(`${Brand.displayName} runtime registration failed; retrying later`, { error: outcome.error })
            : outcome.kind === "registered"
              ? Effect.logInfo(`${Brand.displayName} runtime registered`, { installation: outcome.installation })
              : Effect.void
        }).pipe(Effect.catch((cause) => Effect.logWarning(`${Brand.displayName} runtime registration failed`, { cause })))
        // At startup when due (the client skips an unchanged runtime registered within a day), then daily.
        yield* register.pipe(Effect.repeat(Schedule.spaced(options.registration?.every ?? "1 day")), Effect.forkScoped)
      }
      // On demand after a stale-agent error; a burst of errors starts one sync.
      yield* Stream.fromQueue(resync).pipe(
        Stream.debounce("500 millis"),
        Stream.runForEach(() => sync),
        Effect.forkScoped({ startImmediately: true }),
      )
    }),
  } satisfies PluginInternal.InternalPlugin)
}

export const Plugin = make()

/** Global `permissions` from the loaded config documents, in load order (as ConfigAgentPlugin reads them). */
function globalPermissions(entries: readonly { type: string }[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((document) => document.info.permissions ?? [])
}

/** Fills a freshly created agent with the managed definition. */
export function apply(
  agent: Parameters<Parameters<Agent.Editor["update"]>[1]>[0],
  managed: KeteSyncCache.Cached["response"]["agents"][number],
  organization: string,
  globalRules: readonly Agent.Info["permissions"][number][],
) {
  const base = Agent.Info.default(Agent.ID.make(managed.slug))
  agent.name = Agent.Name.make(managed.name)
  agent.description = managed.description
    ? `${managed.description} · Managed by ${organization}`
    : `Managed by ${organization}`
  agent.mode = managed.mode === "primary" && managed.delegable === true ? "all" : managed.mode
  agent.system = managed.instructions
  agent.model = { id: Model.ID.make(managed.model.model_id), providerID: Provider.ID.make(KeteGateway.providerID) }
  agent.hidden = false
  agent.permissions = [...base.permissions, ...globalRules, ...managed.permissions]
}
