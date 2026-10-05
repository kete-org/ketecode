---
module: sync
paths: [packages/util/src/kete/sync/**, packages/core/src/kete/sync/**, packages/cli/src/kete/sync.ts]
verified-at: 8a2747cd4d
---
## Quick answers
- What does sync do offline? `core/src/kete/sync/plugin.ts:146` `offline()` = `KeteOffline.active` (env flag or `kete.offline` as loaded now), re-checked on every tick: the cached copy (and its policies and fail-closed guard) is always loaded; the periodic and on-demand sync go through `whenOnline` (skipped while offline, logged once) and each registration tick returns early (`:430`). Turning `kete.offline` on in config pauses both from the next tick; off resumes them. `kete sync` is refused offline (exit 2) except `--status`/`--approve` (`cli/src/kete/sync.ts`).
- Where does `KeteSync.sync` return `signed-out`? `util/src/kete/sync/sync.ts:67`, when no account is readable and no `credential` is given; with a `credential` it never does. `load()` (`sync.ts:49`) and `sync()` (`:63`) both need an account outside job mode; job mode passes `credential: {platform, key, organization?}` (`:12-19`) instead and the account file and OS key store are never read; `load` with a credential and no organization returns undefined.
- Which platform URL does sync use? An account's `platform_url`; in job mode `KETE_PLATFORM_URL` only (`KeteJobMode.endpoints`, `util/src/kete/job-mode.ts:97`), key = the job's gateway key as Bearer. A 401 says "refused the job's key" without `kete login` advice (`client.ts:65-66`).
- What does the fail-closed policy guard need? `state.account` set (`plugin.ts:320`): outside job mode only when an account is read; job mode always sets it (`readAccount`, `:161`), so without a loaded cache edit/shell/webfetch ask first (`guardedWithoutPolicies`, `:116`), message without "Run `kete sync`" (`:322`).
- Is the plugin's first load inline? Yes: the cached copy loads inline at startup (`plugin.ts:191-194`); the periodic sync is forked (`:403`, `Effect.forkScoped`), so it can race a job's first model call. Job mode therefore syncs once in `kete job run` before the server starts (`cli/src/kete/job-sync.ts`; `job-mode` card) and the plugin loads that cache by `KeteJobSecrets.organization`.
- How does job-mode sync fail? Fail closed in `KeteJobSync.first`: failed sync or skill download = `error` (exit 1); missing/unknown `spec.agent` = `refused` (2); 120 s overall deadline (`job-sync.ts:deadline`). Later refreshes keep the last copy on failure, as outside job mode. No platform URL or key in the plugin: logs an error, fetches nothing, guard stays on (`plugin.ts:192,364`).
- Does runtime registration still run in job mode (`KETE_JOB_MODE`)? No —
  `plugin.ts:405`: when `options.registration !== false && KeteJobMode.enabled(runtimeEnvironment)`
  it logs one info line ("runtime registration is off in job mode") instead of forking the
  registration loop; `options.registration === false` (tests) still logs nothing, matching its prior
  behavior. Sync itself (agents/skills/MCP/policies) and MCP-disable/model-filter are unaffected here
  — those are `KeteJobPlugin.Plugin`'s job, not this plugin's; see the `job-mode` card.
- What gets synced from the platform? Agents, skills, MCP servers, organization policies — one response, `GET /api/v1/sync` (docs/platform/sync-v1.md).
- Does `policies: []` count as loaded? Yes. The fail-closed guard (`edit`/`shell`/`webfetch` ask first) is keyed on a loaded cache, not on non-empty `policies` (`core/src/kete/sync/plugin.ts:318-324` vs `:327-335`, where `policies ?? []` is evaluated); an empty list is "loaded, nothing to enforce". Only a missing or unreadable cache triggers the guard.
- How often? Startup, then every 5 minutes in the running server (`core/src/kete/sync/plugin.ts:403`), plus on demand from `kete sync` and after `kete login`.
- Where's the cache? `<config>/managed/<organization id>/agents.json`, written atomically (`util/src/kete/sync/cache.ts:52-61`).
- What does "delegable" map to? `mode: "primary", delegable: true` on the wire → Kete's own `mode: "all"` (`core/src/kete/sync/plugin.ts:402`, ADR 0017, docs/platform/requests/agent-mode-all.md).
- What headers tag a managed agent's model calls? `x-kete-agent-id` / `x-kete-agent-version` (`plugin.ts:69-70,222-234`).

## Purpose
Brings an organization's platform-managed agents, skills, MCP servers and policies into the local runtime, keeps them current on a schedule, enforces the org's policies on permission decisions, and translates the gateway's per-agent error codes into clear, non-retried failures. Implements architecture §44 "Configuration Synchronization" (current implementation: agents, sync v1).

## Entry points
- `core/src/kete/sync/plugin.ts:109` `make(options)` (also takes an optional `environment` override, read by the runtime-registration resolver — see the runtime-registration card) → `:393` `export const Plugin = make()`, registered in `core/src/plugin/internal.ts:308` (`post`, right after `ConfigSkillPlugin`/`ConfigAgentPlugin`/`ConfigCompatibilityPlugin` — a managed agent/skill must replace a local one of the same slug).
- `util/src/kete/sync/sync.ts:63` `KeteSync.sync(options)` — the one-sync primitive shared by the CLI and the plugin's periodic loop.
- `cli/src/kete/sync.ts:9-21` — `kete sync` command handler, delegates to `cli/src/kete/account-flow.ts:105` `AccountFlow.sync()` / `:177` `syncStatus()`.

## Key files
- `util/src/kete/sync/contract.ts` — the v1 response schema (agents, skills, mcp_servers, policies), kept identical to the platform's `packages/shared/src/api/v1/sync.ts` (docs/platform/sync-v1.md).
- `util/src/kete/sync/client.ts:23-63` `fetchAgents()` — `GET /api/v1/sync` with `If-None-Match`; maps 401/429/5xx/other to a typed `SyncError`.
- `util/src/kete/sync/cache.ts:13-24` `Cached` schema, `version: 1 | 2` (2 adds `delegable`); `:52-61` atomic write, `:70-76` Windows rename retry (EPERM/EBUSY/EACCES).
- `util/src/kete/sync/sync.ts:88-130` `attempt()` — a version-1 cache's ETag is never resent (would risk a 304 missing `delegable` forever); every new write is at version 2 (`sync.ts:55-58,76`).
- `util/src/kete/sync/policy.ts:37-59` `evaluate()` — pure: within a policy `deny`/`ask` accumulate, a matching `allow` clears prior matches; across policies the most restrictive result wins; only `enforced` policies decide, `audit_only` ones are reported as "would".
- `util/src/kete/sync/approvals.ts:32-38` `approve()` / `:28-30` `approved()` — SHA-256 of the exact approved stdio command, per server key, in `<org>/approved.json`.
- `util/src/kete/sync/mcp-status.ts:19-45` `status()` — what a synced MCP server needs (`approval`/`oauth`/`credential`/`invalid`) before it can run; `:57-89` `split()` shell-like command splitting without a shell.
- `util/src/kete/sync/skills.ts` — writes managed skill files to `<config>/managed/<org>/skills/<slug>/`, verified per-file SHA-256, staged-then-swapped, executable bit stripped (file header, lines 1-8).
- `core/src/kete/sync/plugin.ts:160-190` agent transform — replaces same-slug local agents entirely, applies global rules then managed rules (last match wins), and adds `ask` rules to non-managed agents for a managed MCP tool their own rules would allow silently.
- `core/src/kete/sync/plugin.ts:451` `apply()` — fills a managed agent's fields, including the `mode: "all"` delegable mapping (line 402).
- `core/src/kete/sync/plugin.ts:222-265` gateway agent-error handling: `model.request` hook adds the `x-kete-agent-*` headers; `http.response` hook rewrites the error body's message, sets `x-should-retry: false`, and debounce-triggers a resync on the three "stale" codes; `retry` hook vetoes retry for a refused session.
- `core/src/kete/sync/plugin.ts:275-316` `permission.hook("evaluate", …)` — enforces org policies on top of agent rules; fails closed (`guardedWithoutPolicies`, line 116) for `edit`/`shell`/`webfetch` while signed in without policies loaded.
- `core/src/kete/sync/mcp.ts:19-36` `map()` — synced server → `Mcp.ServerConfig` (stdio → `LocalConfig` disabled until approved; http/sse → `RemoteConfig`, `oauth: false` unless the server's credential type is `oauth`).
- `core/src/kete/sync/plugin.ts:360-362` job-mode gate: skips the registration loop entirely and logs one info line when `options.registration !== false && KeteJobMode.enabled(runtimeEnvironment)` (`job-mode` card); `:363-386` the registration loop itself — resolves `kete.runtime.type`/`KETE_RUNTIME_TYPE` via `KeteRuntimeRegistration.resolveRuntimeType` every tick (config change picked up without restart) and skips (logs an error) rather than registers on an unknown value; see the runtime-registration card for the resolver itself.

## Data flow
Server start (or `kete sync`, or right after `kete login`) → `KeteSync.load()` reads the last cached copy for the signed-in account (no network) → `plugin.ts:141-158` `refresh()` loads approvals/skills-on-disk and warns on any MCP mapping note → `ctx.agent.transform`/`ctx.skill.transform`/`ctx.mcp.transform` apply the cached response to the in-memory agent/skill/MCP lists → in parallel, `sync.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)` (`plugin.ts:353`) calls `KeteSync.sync()` → `client.fetchAgents()` with `If-None-Match` → 304: nothing changes except skill files are still reconciled; 200: `KeteSyncCache.write()` replaces the cache file, `diff()` computes added/updated/removed, `refresh()` reruns, then `ctx.agent.reload()`/`ctx.skill.reload()`/`ctx.mcp.reload()` fire → a gateway `http.response` with a stale-agent error code additionally offers to a debounced `resync` queue (`plugin.ts:372-376`) that runs one `sync` 500ms after the last error.

## Data and APIs used
- Platform API: `GET /api/v1/sync` with `Authorization: Bearer <key>` and `If-None-Match` (docs/platform/sync-v1.md); never the database (CLAUDE.md §3).
- Filesystem: `<config>/managed/<org id>/{agents.json, approved.json, skills/<slug>/}` (all atomic writes, mode 0700/0600).
- Gateway response headers: `x-kete-error-code` (`plugin.ts:71,245`), values in `agentErrors` (`plugin.ts:74-77`): `kete_agent_budget_exceeded` (budget), `kete_agent_paused`/`kete_agent_not_found`/`kete_agent_model_not_allowed` (stale, triggers resync).

## Rules that must not break
- `KeteAgentSync.Plugin` must stay registered after `ConfigAgentPlugin` and `ConfigSkillPlugin` in `post` (`internal.ts:308` comment) — a managed agent/skill must win over a local one with the same slug.
- Policies only ever tighten: `deny`/`ask` accumulate, `allow` is an explicit exception, and across policies the most restrictive wins; nothing here can allow what an agent's own rules deny (`policy.ts:7-10`).
- Fail closed while signed in without loaded policies: `edit`/`shell`/`webfetch` ask first (`plugin.ts:116,320-324`).
- A stdio MCP server never runs until its exact command is approved, and a changed command needs approval again (`mcp-status.ts:26-33`, `approvals.ts`).
- No secret is ever synced: OAuth servers sign in via `kete mcp auth <key>`; `api_key`/`service_account` servers stay disabled until the contract defines delivery (`mcp-status.ts:47-49`).
- A version-1 cache's ETag must never be resent after the `delegable` field existed, to avoid a 304 that permanently drops it (`sync.ts:55-58`).
- Offline or on any sync error, the last cached copy stays in use; the cache is never deleted on error (`sync.ts:43-45`, `plugin.ts:343-347`).

## Testing
- Core (plugin, agent mapping, gateway errors, policy enforcement): `bun run test ./test/kete/agent-sync.test.ts`, `./test/kete/policy-sync.test.ts`, `./test/kete/skill-mcp-sync.test.ts` inside `packages/core/` (isolates HOME/XDG — CLAUDE.md §8).
- Util (contract, cache, client, sync, skills, policy pure logic): `bun test ./test/kete/sync.test.ts`, `./test/kete/sync-skills.test.ts`, `./test/kete/sync-policy.test.ts` inside `packages/util/`.
- CLI (`kete sync`, MCP status/approval flow): `bun test ./test/kete/sync.test.ts`, `./test/kete/sync-mcp.test.ts` inside `packages/cli/`.

## Changes
- docs/upstream-patches.md "Platform-managed agents" (feature/agent-sync) — core files, `ConfigAgentPlugin.expandPermissions` export, `cli/src/index.ts` sync handler.
- docs/upstream-patches.md "Gateway agent errors" (feature/agent-request-tagging) — `http.response`/`retry` hooks, no upstream edits.
- docs/upstream-patches.md "Skills and MCP servers" (feature/skill-mcp-sync) — `util/src/kete/sync/skills.ts`, `core/src/kete/sync/mcp.ts`, `util/src/kete/sync/mcp-status.ts`, `approvals.ts`.
- docs/platform/requests/agent-mode-all.md — `delegable` field and the `mode: "all"` mapping (cache format version 2); ADR 0017 is on the platform side.

## Gotchas
- `cache.ts:14-16` comment explains exactly why the ETag isn't resent for a v1 cache — re-verify this on any cache schema change.
- `plugin.ts:262` only the three "stale" codes trigger a resync; the budget code does not (an over-budget agent isn't fixed by syncing).
- `account-flow.ts` (see the `account-login` card) also contains `sync()`/`syncStatus()`/`approve()` — the actual `AccountFlow` orchestration for `kete sync` lives there, not in `cli/src/kete/sync.ts`, which is only the command wiring.
- `mcp.ts:2-3` — the runtime's MCP client speaks Streamable HTTP only, so a synced `sse` server is registered anyway but with a warning note.
- When syncing upstream: `git grep` for the tool-action names (`shell`, `edit`, `webfetch`; MCP tools as `<server>_<tool>`) staying in sync with `McpTool.name`, per docs/upstream-patches.md "Skills and MCP servers" closing note.
