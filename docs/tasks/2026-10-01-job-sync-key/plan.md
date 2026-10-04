# Plan: Job mode piece A2: sync from the job's gateway key (docs/jobs.md §8 item 6)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Size: Large** (security-sensitive: a credential path and a fail-closed policy guard; changes the
§6d entrypoint ↔ `kete job run` behaviour — `KETE_PLATFORM_URL` and `spec.agent` become required in
job mode). **Upstream files edited: none** — every changed path contains `kete`. No server endpoint,
so no protocol/client regeneration. Spec approved 2026-10-01; decisions D1–D6 below need the user's
nod before the build (D3 and D4 change what a job needs).

## Cards read
- docs/context/modules/sync.md (verified-at a90d57e2d8, stale: no — line refs drifted ~5, see handoff)
- docs/context/modules/job-mode.md (verified-at e8079c109b, stale: no)
- docs/context/modules/gateway.md, cli.md, unattended.md (stale: no; only job-mode parts used)
- docs/context/contracts.md §6d, §7; commands.md; pitfalls.md

## Design (the choices, with reasons)

**1. `credential` on KeteSync.** `KeteSync.Options` gains
`credential?: { platform: string; key: string; organization?: string }`. With it, `sync()` and
`load()` never call `KeteAccount.read`/`KeteAccount.key`; the Bearer is `credential.key`, the base
URL `credential.platform` (both for `GET /api/v1/sync` and, unchanged code path, the skill-file
fetches in `skills.ts`, which already take `platform`/`key` as input). The cache is still
`<config>/managed/<org>/agents.json`; without an account the org is unknown until the first 200, so
`credential.organization` (a GUID) is how a later call finds its cache and ETag: absent → no cache
read, fetch without `If-None-Match`, write under the response's org; present and different from the
response's org → remove the old copy (same rule as the account path). `load()` with a credential
returns `undefined` when `organization` is absent, else `{ cached }` (return type becomes
`{ account?: KeteAccount.Account; cached }`; `account-flow.ts` uses only `.cached`). Internally
`attempt()` takes a resolved source `{ platform, key, organization?, kind: "account" | "job" }`; the
account path builds it after the existing missing-key check (message unchanged). `"signed-out"` is
never returned with a credential.

**2. 401 wording.** `KeteSyncClient.fetchAgents` input gains `credential?: "account" | "job"`
(default `"account"`, message unchanged). `"job"` → `The platform refused the job's key (<detail>)<ref>.`
— no `kete login` advice; code stays `"unauthorized"`. `skills.ts`'s 401 is already the generic
"refused the skill files" (no login advice) — unchanged.

**3. One URL rule, no duplication.** Move `httpURL` out of `core/src/kete/gateway.ts:469-474` into a
new `util/src/kete/http-url.ts` (`KeteHttpURL.normalize`), and add
`KeteJobMode.endpoints(env) → { gateway: string | undefined; platform: string | undefined }` in
`util/src/kete/job-mode.ts`, reading `OPENCODE_GATEWAY_URL`/`OPENCODE_PLATFORM_URL` (new exported
constants `gatewayURLVariable`/`platformURLVariable` there). `gateway.ts` keeps its exported
`urlVariable`/`platformVariable` names but defines them from those constants, uses
`KeteHttpURL.normalize` everywhere it used `httpURL`, and its `configured()` job branch
(`gateway.ts:449-455`) becomes `{ url: endpoints.gateway, key: job.key, platform: endpoints.platform, signedIn: false }`.
Util, not core, because the CLI (which has no direct `@opencode/core` dependency) needs it too.

**4. Who runs the first sync, and how `kete job run` waits — the parent, before the server starts.**
`kete job run` (job mode) already holds the job key in memory after preflight. New
`cli/src/kete/job-sync.ts` `KeteJobSync.first(...)` runs `KeteSync.sync({ credential })` in the
parent, **after `JobConnection.resolve` and before `KeteJobStandalone.start`**, checks
`spec.agent` against the response's agent slugs, and maps the outcome to the job result. On success
it passes the organization id to the `kete serve` child in the existing fd-3 secrets message (new
field `organization`), and the child's sync plugin loads exactly that cache inline at activation.
Why this over the alternatives:
- *A server endpoint* (sync status / readiness): needs edits to upstream `server/src/api.ts`/
  `handlers.ts`, protocol + client regeneration, and a polling loop — and still races plugin
  activation (`agent.list`/`agent.get` don't await `Plugin.awaitActivation`; only prompt/LLM do —
  `core/src/session/prompt.ts:38`, `session/runner/llm.ts:68`).
- *Sync in the child's `KeteJobServe.prepare` before the ready line:* the child doesn't know
  `spec.agent`, a failure surfaces only as "could not start the job's server: <last stderr line>"
  (always `error`, never `refused`), and the plugin would still need the org from somewhere.
- *A plugin readiness signal:* plugins activate lazily per location, forked
  (`core/src/plugin/supervisor.ts:225-236`); nothing a client can observe without a new endpoint.
- The parent approach needs no endpoint, no upstream edit, no polling; the refusal happens before a
  server or session exists; the data the parent checked is the file the child serves (no second
  fetch deciding differently — the child's first periodic tick is a 304). The child's plugin load is
  already inline in the plugin's effect (`plugin.ts:160-163`), and the prompt awaits activation, so
  the agent and policies are in place before the first model call.
Network: the parent is the same uid as the child, which already reaches the platform through
`HTTPS_PROXY` (gateway prices/`me`), so no firewall change.

**5. Mapping to the result** (`job.ts` `report(...)`, like preflight/connection refusals):
- `KETE_PLATFORM_URL` unset/invalid → `error` (1): `Job mode: KETE_PLATFORM_URL is not an http(s) URL; the job's agent can't be synced.`
- sync `failed` (network, 401 job key refused, 5xx, invalid response) → `error` (1):
  `Job mode: the first sync with the platform failed: <SyncError message>` (D2).
- any managed skill failed to download (`outcome.skills.failed.length > 0`) → `error` (1) (D5).
- `spec.agent` absent → `refused` (2) (D3). `spec.agent` not among the synced slugs → `refused` (2):
  `spec.agent "<slug>" is not among <org name>'s synced agents.` (lists up to 10 slugs).
Nothing is spawned and no session is created on any of these.

**6. The child's plugin in job mode** (`core/src/kete/sync/plugin.ts`, gate on
`KeteJobMode.enabled(runtimeEnvironment)`):
- Credential per call: `{ platform: KeteJobMode.endpoints(env).platform, key: jobKey(), organization: state.cached?.response.organization.id ?? jobOrganization() }`;
  `jobKey`/`jobOrganization` default to `KeteJobSecrets.gatewayKey`/`KeteJobSecrets.organization`,
  injectable via a new `make({ job: { key?, organization? } })` option (like `gateway.ts:146,153`).
  Missing platform or key → no fetch; log an error once per attempt; state stays fail closed.
- Never reads the account file: `readAccount` in job mode returns
  `{ organization: state.cached?.response.organization.name ?? "the job's organization" }` — so
  `state.account` is always set and the guard (`plugin.ts:284-288`) applies: no cache → `edit`/
  `shell`/`webfetch` allow→ask, which `KeteUnattended.applyLate` turns into deny (unattended
  `PolicyPlugin` runs earlier, in `pre`, so `spec.policy.allow` can't undo it). The guard's message in
  job mode says the policies aren't loaded, without "Run `kete sync`" (D6).
- Load at startup: `KeteSync.load({ ...base, credential })` with the org from the holder (inline, as
  today). Later refreshes (5-min schedule, stale-agent resync) unchanged: on failure keep the last
  copy and warn.
- Registration stays off (`plugin.ts:360-362`).

**7. Secrets message.** `job-standalone.ts` `secretsMessage` adds `organization` (required in job
mode, a GUID). `job-serve.ts` `Message` schema adds `organization: Schema.String`; `prepare` checks
it with the same GUID rule `cache.ts:25` uses (export `KeteSyncCache.validOrganization` or reuse
`directory()`'s check) and calls a new write-once `KeteJobSecrets.setOrganization` (validated,
second call throws), next to the key overlay (same lifetime rationale; header comment updated).
Not a secret, but this is the established internal parent→child channel (not a contract).

## Files
| File | Read / change | Why |
|---|---|---|
| packages/util/src/kete/sync/sync.ts | change | `credential` option; `attempt()` on a resolved source; `load()` with credential |
| packages/util/src/kete/sync/client.ts | change | `credential: "account" \| "job"` → job-mode 401 wording |
| packages/util/src/kete/sync/skills.ts | read | confirm skill fetches use the passed `platform`/`key` (`:58-62,175-191`); no change expected |
| packages/util/src/kete/sync/cache.ts | change (small) | export the GUID check (`:25-32`) for `job-serve.ts` |
| packages/util/src/kete/sync/contract.ts | read | `SyncResponse` shape for test fixtures |
| packages/util/src/kete/account.ts | read | `Options` (`:32-43`) |
| packages/util/src/kete/http-url.ts | **new** | `KeteHttpURL.normalize` (moved from gateway.ts) |
| packages/util/src/kete/job-mode.ts | change | `gatewayURLVariable`/`platformURLVariable`, `endpoints(env)` |
| packages/util/src/kete/job-secrets.ts | change | `setOrganization`/`organization` write-once overlay |
| packages/core/src/kete/gateway.ts | change | use util URL helper + `KeteJobMode.endpoints` in the job branch; no behaviour change |
| packages/core/src/kete/sync/plugin.ts | change | job-mode credential, no account read, signed-in guard, `job` test option |
| packages/core/src/kete/unattended.ts | read | `applyLate` (`:213-233`) for the AC4 test |
| packages/cli/src/kete/job-sync.ts | **new** | `KeteJobSync.first` — first sync + agent check → result |
| packages/cli/src/kete/job.ts | change | call `KeteJobSync.first` between `JobConnection` and `KeteJobStandalone.start`; pass `organization` |
| packages/cli/src/kete/job-standalone.ts | change | `organization` in `StartOptions`/`secretsMessage` |
| packages/cli/src/kete/job-serve.ts | change | `organization` in `Message`, validated, stored |
| packages/cli/src/kete/job-preflight.ts | read | the key's lifetime in the parent |
| packages/util/test/kete/sync.test.ts | change | credential cases (fake `platform()` at `:40-70`) |
| packages/util/test/kete/job-mode.test.ts, job-secrets.test.ts | change | `endpoints`, `setOrganization` |
| packages/core/test/kete/agent-sync.test.ts | change | job-mode agent applied + headers |
| packages/core/test/kete/policy-sync.test.ts | change | job-mode fail closed (+ `applyLate` → deny) |
| packages/core/test/kete/unattended-service.test.ts | read | how `applyLate` and `get` are wired (`:140-150`) |
| packages/core/test/kete/gateway.test.ts | run | job-mode URL cases must still pass after the move |
| packages/cli/test/kete/job-sync.test.ts | **new** | outcome → result mapping |
| packages/cli/test/kete/job-serve.test.ts, job-standalone.test.ts | change | `organization` in the message |
| packages/cli/test/kete/job-socket.subprocess.test.ts | change | real CLI: fake platform `/api/v1/sync`, `spec.agent`, header check, 401 case |
| docs/jobs.md, docs/context/contracts.md | change | §6d / "Job mode": `KETE_PLATFORM_URL`, `spec.agent` required, first sync |

## Steps
1. **util URL helper.** Create `util/src/kete/http-url.ts` with `normalize(raw)` = today's
   `gateway.ts:469-474` body. In `job-mode.ts` add `gatewayURLVariable = "OPENCODE_GATEWAY_URL"`,
   `platformURLVariable = "OPENCODE_PLATFORM_URL"` (+ `…PublicName` via `KeteEnv.publicName`) and
   `endpoints(env)`. In `gateway.ts` define `urlVariable`/`platformVariable` from them, delete the
   local `httpURL`, use `KeteHttpURL.normalize`, and make the job branch use `KeteJobMode.endpoints`.
   Run `core` `gateway.test.ts` — must be unchanged.
2. **client.ts:** `credential?: "account" | "job"` on `fetchAgents`; job 401 message per Design 2.
3. **sync.ts:** add `Credential`/`credential`; refactor per Design 1. Keep the account path's
   behaviour and messages byte-identical (AC5). Header comment: mention the job-mode credential.
4. **cache.ts:** export `validOrganization(id)` (the existing GUID regex) and use it in `directory()`.
5. **job-secrets.ts:** `setOrganization(id)` (write-once, throws if invalid via
   `KeteSyncCache.validOrganization` — or a local GUID regex if importing sync from job-secrets
   would create a cycle; check) and `organization()`.
6. **plugin.ts:** per Design 6. Keep non-job behaviour identical; the job path is one
   `const job = KeteJobMode.enabled(runtimeEnvironment)` branch building `syncOptions()` per call
   and a job-mode `readAccount`. Update the header comment (job mode paragraph).
7. **job-standalone.ts / job-serve.ts:** `organization` in the message (Design 7); `prepare` fails
   with `Job mode: <fd var> did not hold a valid organization id.` on a bad value.
8. **job-sync.ts (new, Kete-owned, pure over deps):**
   `first(input: { key; spec: { agent?: string }; environment; config; data; fetch? })` →
   `{ kind: "ok"; organization: string } | { kind: "error" | "refused"; message: string }`, per
   Design 5. Calls `KeteSync.sync({ config, data, native: undefined, credential: { platform, key }, fetch })`
   — `native: undefined` so nothing touches the OS keychain (which job mode refuses).
9. **job.ts:** after the `JobConnection` refusal block, in job mode only:
   `const synced = yield* Effect.promise(() => KeteJobSync.first({ key: preflight.gatewayKey, spec, environment: process.env, config: Global.Path.config, data: Global.Path.data }))`;
   `error` → `report(errorResult(...))`, `refused` → `report(refusedResult(...))`, return; pass
   `organization: synced.organization` to `KeteJobStandalone.start`. Update the header comment.
10. **Tests** (below). 11. **Docs:** `docs/jobs.md` "Job mode" (first sync, `KETE_PLATFORM_URL`
    and `spec.agent` required in job mode, outcomes); `contracts.md` §6d note (librarian).

## Tests per AC (existing fakes)
- **AC1** — `util/test/kete/sync.test.ts`: with `credential` and **no account file**: the fake
  `platform()` sees `Bearer <job key>` on `/api/v1/sync` and on the skill-files route; the cache is
  written under the response's org; a second call with `organization` sends `If-None-Match`; a 401
  gives `failed` with "refused the job's key" and no "kete login". `core/test/kete/agent-sync.test.ts`
  (or policy-sync): job mode via `environment: { OPENCODE_JOB_MODE: "1", OPENCODE_PLATFORM_URL: fake.url }`,
  `job: { key: () => jobKey, organization: () => org }`, plus an account file pointing at a *second*
  fake and `kete.platform.url` config entry → only the job fake is called, with the job key.
  `util/test/kete/job-mode.test.ts`: `endpoints()` normalises / drops non-http values.
- **AC2** — `agent-sync.test.ts`: job mode, cache pre-written by `KeteSync.sync({credential})` →
  the synced slug replaces the local agent and the `model.request` hook sets `x-kete-agent-id`/
  `-version` (reuse the file's existing header test helper); synced skill registered; a policy
  denies. Real-process: `job-socket.subprocess.test.ts` — the fake serves `/api/v1/sync` (copy a
  minimal `SyncResponse` with one agent `developer`, model `{provider:"deepseek", model_id:"test-chat"}`,
  ETag header), spec gains `agent: "developer"`, env gains `KETE_PLATFORM_URL`; assert the chat
  request carried `x-kete-agent-id`, and sync saw `Bearer <fd key>` (never `envKey`).
- **AC3** — `cli/test/kete/job-sync.test.ts`: failed sync (401, 500, network) → `error`; skill
  failure → `error`; no platform URL → `error`; `spec.agent` absent / not synced → `refused`; ok →
  org id. Subprocess test: platform 401 → stdout result `outcome: "error"`, exit 1, no
  chat-completions request, no `--socket` child; unknown `spec.agent` → `refused`, exit 2.
  `job-serve.test.ts`/`job-standalone.test.ts`: message carries and validates `organization`.
- **AC4** — `policy-sync.test.ts`: job mode, platform down (no cache), no account file →
  `edit`/`shell`/`webfetch` allow → `ask`; then run `KeteUnattended.applyLate` (wired as in
  `unattended-service.test.ts:140-150` with an unattended `get`) on those events → `deny`; `read`
  stays allow.
- **AC5** — existing `util` sync tests, `core` agent/policy/skill-mcp sync tests and `cli`
  sync/login tests pass unchanged.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `packages/util`: `bun test ./test/kete/sync.test.ts ./test/kete/job-mode.test.ts`; `packages/core`: `bun run test ./test/kete/agent-sync.test.ts ./test/kete/gateway.test.ts` |
| AC2 | `packages/core`: `bun run test ./test/kete/agent-sync.test.ts ./test/kete/skill-mcp-sync.test.ts`; `packages/cli`: `bun test ./test/kete/job-socket.subprocess.test.ts` |
| AC3 | `packages/cli`: `bun test ./test/kete/job-sync.test.ts ./test/kete/job-serve.test.ts ./test/kete/job-standalone.test.ts ./test/kete/job-socket.subprocess.test.ts` |
| AC4 | `packages/core`: `bun run test ./test/kete/policy-sync.test.ts ./test/kete/unattended-service.test.ts` |
| AC5 | `packages/util`: `bun test ./test/kete`; `packages/core`: `bun run test ./test/kete`; `packages/cli`: `bun test ./test/kete` |
| AC6 | `bun run typecheck` in util/core/cli; `bun run lint` (root); `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`. Linux run of the subprocess test (built binary, `JOBSOCK_E2E_BIN`) in Docker/Colima if time allows — say if skipped. |

## Cards to update after the build
- sync — credential option, job-mode path, job 401 message, cache org without an account, refreshed line refs (handoff gaps).
- job-mode — A2 done: first sync in the parent, `organization` in the secrets message, `KeteJobSecrets.organization`, `spec.agent`/`KETE_PLATFORM_URL` required, status line.
- cli — `kete job run` job-mode order: preflight → spec → connection → first sync → server.
- gateway — URL helper moved to `util/src/kete/http-url.ts` / `KeteJobMode.endpoints`.
- unattended — note the job-mode fail-closed path (sync guard + `applyLate`).
- contracts.md §6d; docs/jobs.md "Job mode".

## Decisions for the user
- **D1 (mechanism):** first sync in `kete job run`'s own process before its server starts; org id to
  the child over the existing fd-3 message. No endpoint, no upstream edit. (Recommended.)
- **D2:** a failed first sync (incl. 401) is `error` (1); a missing/unknown agent is `refused` (2).
- **D3:** in job mode `spec.agent` is **required** (refused without it) — the gateway pins a job key
  to one agent (ADR 0020 rule 9), so a default agent would only fail later with a 403.
- **D4:** in job mode `KETE_PLATFORM_URL` is **required** (else `error`) — the entrypoint already sets it (§6d).
- **D5:** a managed skill that fails to download on the first sync fails the job (`error`), fail closed.
- **D6:** the job-mode guard message drops "Run `kete sync`" (no account to sync with).
