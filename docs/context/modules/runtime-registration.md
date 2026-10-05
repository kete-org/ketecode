---
module: runtime-registration
paths: [packages/util/src/kete/runtime-registration.ts]
verified-at: 604889ab32
---
## Quick answers
- Is the runtime registered offline? No: `core/src/kete/sync/plugin.ts:410` skips registration when offline mode is on.
- Does the cloud-job runtime image register? No — the call site (`core/src/kete/sync/plugin.ts:360-362`)
  skips the whole registration loop and logs one info line when job mode
  (`KETE_JOB_MODE`) is on; this module itself is unchanged (still never reads the flag) — see the
  `sync`/`job-mode` cards.
- What does this register, and where? The local runtime installation, `PUT /api/v1/runtimes/{installation_id}` on the platform (`runtime-registration.ts:131`).
- How often? At startup when due (version/key/organization/**runtime type** changed, or a day passed), then daily while running (call site: `core/src/kete/sync/plugin.ts:359-382`).
- What's sent? `runtime_type`, `version`, `os`, `arch`, `device_name` — nothing else (`runtime-registration.ts:134-141`).
- Where's the installation id stored? `<data>/installation.json`, random UUID, created once (`runtime-registration.ts:79-105`).
- How is the runtime type chosen (ADR 0005)? `resolveRuntimeType(configured, environment)` (`runtime-registration.ts:33-43`): the `kete.runtime.type` config value if set, else `OPENCODE_RUNTIME_TYPE` (read from `environment`; internal name `runtimeTypeVariable`, external/message name `"KETE_RUNTIME_TYPE"`), else `"local"`. An unknown value at either source is `{ kind: "invalid", source, value }` (value truncated to 50 chars) rather than guessed — the caller skips that registration tick and logs an error (never in this module, which never throws). The schema (`packages/schema/src/config/kete.ts`) carries the same three literals separately since it can't depend on `util`; a parity test in `packages/core/test/kete/policy-sync.test.ts` keeps them matched.
- Does a runtime-type change alone trigger re-registration? Yes — `runtime_type` is part of the `registered` snapshot and compared in `due` (`runtime-registration.ts:60-73,118-125`); a missing field (an `installation.json` written before this existed) is treated as `"local"`.
- Who resolves the type — this module or the caller? The caller (`core/src/kete/sync/plugin.ts`) and `cli/src/kete/account-flow.ts`'s `whoami()` each call `resolveRuntimeType`; `register()` itself only takes the already-resolved `Options.runtimeType` (defaulting to `"local"` if omitted) and never reads config or env directly.

## Purpose
Lets the organization see which runtime installations it runs, where, and at which version (architecture §43 "Runtime Registration"). Implements the "current implementation" described in architecture §44 as part of sync v1. Never blocks or fails anything else — registration is best-effort and self-throttling.

## Entry points
- `runtime-registration.ts:78` `register(options): Promise<Outcome>` — the only public entry point; reads the account, decides if registration is due, PUTs if so, never throws.
- Call site: `core/src/kete/sync/plugin.ts:47` import, `:355-369` — wrapped in `Effect.tryPromise`, logged (not fatal) on failure, `Effect.repeat(Schedule.spaced(options.registration?.every ?? "1 day"))`, `Effect.forkScoped` so it can't delay startup. Disabled entirely when the plugin is built with `options.registration === false` (tests).

## Key files
- `runtime-registration.ts:16-17` `runtimeTypes = ["local", "kete_cloud", "enterprise_private"] as const`, `RuntimeType = (typeof runtimeTypes)[number]` — all three are live (ADR 0005), not just `"local"`.
- `runtime-registration.ts:20` `runtimeTypeVariable = "OPENCODE_RUNTIME_TYPE"` — the internal (env-bridged) name; user-facing messages and the schema description say `KETE_RUNTIME_TYPE`.
- `runtime-registration.ts:22-43` `ResolvedRuntimeType` union and `resolveRuntimeType(configured, environment)` — config wins, then the env var (empty string counts as unset), else `"local"`; unknown values are `invalid`, never guessed; `truncate()` (line 26) caps a reported bad value at 50 chars.
- `runtime-registration.ts:60-73` `State` schema — `installation_id` (UUID) plus the last `registered` snapshot (`at`, `version`, `organization`, `key_id`, optional `runtime_type`), used to decide whether a re-registration is due.
- `runtime-registration.ts:99-105` `installation()` — reads or creates `<data>/installation.json` (mode 0600, atomic write via `writeState`, lines 90-96).
- `runtime-registration.ts:118-125` the "due" check: no prior registration, or version/organization/key_id/**runtime_type** (missing treated as `"local"`) changed, or `options.every` (default `DAY` = 24h) has elapsed, or the stored timestamp is unparsable.
- `runtime-registration.ts:131-154` the PUT itself: 10s timeout (`timeout`, line 77), `redirect: "error"`, response body always drained (`response.body?.cancel()`, line 147) even on success.
- `runtime-registration.ts:136-139` every outgoing field is sanitized/truncated before being sent (version stripped to `[0-9A-Za-z.+-]`, arch to `[a-z0-9_]`, both capped at 50/20 chars; device name capped at 100).

## Data flow
`KeteAgentSync.Plugin` starts → (unless `registration: false`) each tick resolves the runtime type via `resolveRuntimeType(Config.latest(entries, "kete")?.runtime?.type, environment)` (`core/src/kete/sync/plugin.ts:363`) — `invalid` → `Effect.logError` and skip this tick's registration entirely, never call `register()` — `ok` → forks a scoped loop calling `register({...syncOptions, version: ctx.app.version, runtimeType: resolved.type})` → `register()` reads the signed-in account (`KeteAccount.read`); not signed in → `{kind: "signed-out"}`, no request → reads/creates the installation id → compares against the last `registered` snapshot to decide if due → not due → `{kind: "skipped", installation}` → due → reads the account key, `PUT`s `/api/v1/runtimes/{installation_id}` with the five fields → on success, `writeState()` records the new `registered` snapshot (including `runtime_type`) → `{kind: "registered", installation}`; on network error, non-2xx, or a missing key → `{kind: "failed", installation, error}`, logged as a warning by the caller and retried on the next scheduled tick (daily by default).

## Data and APIs used
- Platform API: `PUT /api/v1/runtimes/{installation_id}`, `Authorization: Bearer <account key>` (`runtime-registration.ts:131-133`) — never the database (CLAUDE.md §3).
- Filesystem: `<data>/installation.json` (mode 0700 dir / 0600 file, atomic write-then-rename, `runtime-registration.ts:90-96`).
- `KeteAccount` (`./account.js`) for the signed-in account and its key.
- Config: `kete.runtime.type` (`packages/schema/src/config/kete.ts`'s `ConfigKete.Runtime`), read by the caller, not by this module.
- Environment: `OPENCODE_RUNTIME_TYPE` (bridged from `KETE_RUNTIME_TYPE`), read via the caller-supplied `environment` map, not `process.env` directly (testability).

## Rules that must not break
- Never collects more than `runtime_id` (the installation id)/`user_id`-equivalent via the key/`organization_id`/`runtime_type`/`runtime_version`/`os`/`architecture`/device name — "avoid collecting unnecessary device information" (architecture §43, lines 1428-1444). No code, prompts, paths or secrets are ever sent (file header, lines 1-5).
- `register()` must never throw or block startup — every failure path returns a typed `Outcome`, and the caller only logs (`runtime-registration.ts:112`, `plugin.ts:373-379`). `resolveRuntimeType()` likewise never throws; an unresolvable value is a data result (`invalid`), not an exception.
- An unknown runtime type is never guessed at — the caller must skip registration for that tick rather than fall back silently (CLAUDE.md §10; enforced at the call site, `plugin.ts:364-370`, not inside this module).
- A 404 (older platform without the endpoint) is treated as a normal failure, retried the next day, not a fatal error (`runtime-registration.ts:148-154` comment).
- An unchanged runtime (including an unchanged runtime type) registers at most once a day; the client — not just the server — enforces this via the `due` check (`runtime-registration.ts:118-125`), so a restarting CLI doesn't spam the endpoint.

## Testing
- `packages/util/test/kete/sync-policy.test.ts` — despite the filename, this is where `KeteRuntimeRegistration` is exercised: signed-out, first registration, unchanged/skipped, version-change re-registration, failure path, plus `resolveRuntimeType` (config-wins, env fallback, empty-env-as-unset, default, invalid at both sources, truncation, and a hand-written literal-list-matches-the-schema check), re-registration on a type-only change, and an old-shape `installation.json` (no `runtime_type`) read as `"local"`: `bun test ./test/kete/sync-policy.test.ts` inside `packages/util/`.
- Core call site: `packages/core/test/kete/policy-sync.test.ts` (config-set type, env-set type, config-beats-env, unknown env → zero registrations) — `bun run test ./test/kete/policy-sync.test.ts` inside `packages/core/`.
- CLI `whoami` runtime line: `packages/cli/test/kete/login.test.ts` (`-t whoami`).
- No `runtime-registration.test.ts` file exists; do not search for one.

## Changes
- Introduced with docs/upstream-patches.md "Platform-managed agents" (feature/agent-sync) as part of sync v1's runtime-registration piece; call site documented in architecture §44 "Current implementation: agents (sync v1)", last bullet (lines 1499-1502).
- ADR 0005 (Runtime type from configuration, 2026-09-28, `docs/tasks/2026-09-28-runtime-type`): added `runtimeTypes`/`resolveRuntimeType`/`runtimeTypeVariable`, `runtime_type` in the `registered` snapshot and `due` check; the call site (`sync/plugin.ts`) resolves the type from config/env every tick instead of hard-coding `"local"`; `kete whoami` (`cli/src/kete/account-flow.ts`) prints it.

## Gotchas
- `platformOS()` (`runtime-registration.ts:107-109`) collapses anything that isn't darwin/linux/win32 to `"other"` rather than sending a raw, potentially identifying platform string.
- The `due` check treats an unparsable stored timestamp (`Number.isNaN(Date.parse(last.at))`) as due, so a corrupted `installation.json`'s `registered` block self-heals on the next tick instead of wedging registration off forever.
- `runtimeType` is threaded through as an option (`Options.runtimeType`, default `"local"` when omitted) — this module itself never reads config or env; both call sites (`core/src/kete/sync/plugin.ts`, `cli/src/kete/account-flow.ts`'s `whoami()`) call `resolveRuntimeType()` themselves and pass the resolved value in.
- Two literal lists exist (`runtimeTypes` here and `ConfigKete.Runtime`'s `Schema.Literals` in `packages/schema/src/config/kete.ts`) because `packages/util` can't depend on `packages/schema`; kept in sync by a parity test in `packages/core/test/kete/policy-sync.test.ts` (core depends on both) plus typecheck at the call site.
- `kete whoami` only reads the *global* config (`cli/src/kete/account-flow.ts`'s `globalConfig()`); a project-level `kete.runtime.type` is seen by the registration call site (which reads full `Config.entries()`) but not by `whoami` — the two can disagree by design (documented in the schema description).
