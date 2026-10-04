# Handoff: Job mode piece A2: sync from the job's gateway key (docs/jobs.md §8 item 6)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-01 scout

(Summary pasted by the coordinator.)

- Q1 → docs enough: yes (shape) / no — missing: where sync returns signed-out and that the fail-closed policy guard needs `state.account` (sync card; plugin line numbers drifted ~5). Sync sends the account key as Bearer (`util/src/kete/sync/sync.ts:38-51`, `client.ts:23-63`, skills `skills.ts:175-191`); cache `<config>/managed/<org>/…`; `load()` also needs an account (`sync.ts:30-35`); plugin `core/src/kete/sync/plugin.ts:140-146,160,323,358`; the guard only applies when `state.account` is set (`:284-286`). Smallest change: a `credential?: {platform, key}` option on `KeteSync.Options`; in job mode the plugin builds it from `KeteJobSecrets.gatewayKey()` and the env platform URL and sets `state.account` so the guard applies; job-mode 401 text without `kete login`.
- Q2 → docs enough: partly — missing: spec.agent is a slug; first sync not awaited; the gateway pins `x-kete-agent-id` for job keys (job-mode / gateway cards). Agents replace by slug and add `x-kete-agent-id` (`plugin.ts:165-238`) — required for job keys (ADR 0020 rule 9: else 403), so without sync every job model call would fail. Skills, policies apply; MCP already disabled by the job plugin. The sync is forked, so `kete job run` can race it.
- Q3 → docs enough: no — missing: platform job-key status (job-mode card). Platform job keys / job-scoped sync are NOT built. No header needed (the platform scopes by key kind). Test with the existing TS fakes (`util/test/kete/sync.test.ts`, `core/test/kete/agent-sync.test.ts`).
- Q4 → docs enough: no — missing: job-mode sync failure handling (sync, job-mode cards). Today failures keep the cache silently; a job has none and would run with no policies. Recommendation: fail closed — the first sync is required in job mode; refuse if it fails or spec.agent isn't synced; keep last-copy fallback for later refreshes.
- Q5 → docs enough: yes / missing: sync ignores the job-mode URL rule (sync card). Sync uses the account's `platform_url` (`sync.ts:53,66`); job mode must use `KETE_PLATFORM_URL` like `gateway.ts:447-455`.

## 2026-10-01 coordinator

- spec.md approved by the user (2026-10-01), with fail-closed on a failed first sync or a missing agent. Tooling as before (general-purpose builder; Docker/Colima only if Linux checks are needed; ~4 GB free — run `colima ssh -- sudo fstrim -a` if it drops).

## 2026-10-01 planner

- Done: plan.md written (Large; no upstream edits; no endpoint, so no protocol/client regeneration). Cards checked with stale-cards: all current.
- Docs enough: no — missing: sync card line refs drifted (+5 from `plugin.ts:107` on: guard `:284-288`, sync loop `:323-358`, `apply` `:406`); card doesn't say `load()`/`sync()` both require an account or that the plugin's initial load is inline while the periodic sync is forked (sync card).
- Docs enough: no — missing: plugin activation timing — internal plugins activate lazily per location in a forked fiber (`core/src/plugin/supervisor.ts:225-236`); `agent.list`/`agent.get`/`session.create` don't await `Plugin.awaitActivation`, only prompt/LLM/shell/command do (`session/prompt.ts:38`, `session/runner/llm.ts:68`) (job-mode or a new plugins card; pitfalls candidate).
- Docs enough: no — missing: `session.create` doesn't validate `agent` (`core/src/session.ts:273`), so an unknown agent isn't caught there (cli card).
- Docs enough: no — missing: `httpURL` and the job-mode URL rule are private to `gateway.ts:449-474`; the CLI has no direct `@opencode/core` dependency (`packages/cli/package.json`), so shared job-mode helpers must live in util (job-mode/gateway cards).
- Docs enough: yes — job-secrets overlay, secrets message shape (`job-serve.ts:50-54`, `job-standalone.ts:105-107`), unattended hook order (`unattended.ts:1-13`), test fakes.
- Decisions for the user (plan.md): D1 first sync in `kete job run`'s process before the server starts, org id to the child over the fd-3 message; D2 failed sync = error(1), missing agent = refused(2); D3 `spec.agent` required in job mode; D4 `KETE_PLATFORM_URL` required in job mode; D5 a skill download failure on the first sync fails the job; D6 job-mode guard message without "Run `kete sync`".
- Risk: `job-socket.subprocess.test.ts` (A1) breaks without a fake `/api/v1/sync` — the plan extends it. Setting `KETE_PLATFORM_URL` in that test also turns on the gateway's `/api/v1/models` and `/me` calls (404 from the fake → warnings only; verify).

## 2026-10-01 coordinator

- User approved plan decisions D1–D6 as written (2026-10-01). Build started.

## 2026-10-01 builder

- Done: plan steps 1–11 implemented as written, no upstream files edited. **No check could be run: the Bash tool was disabled in this session, so typecheck, tests, lint and `upstream:check` are all UNRUN.** Everything below is unverified; the next step is to run the Verification table in plan.md.
- Files changed (src): util `kete/http-url.ts` (new), `kete/job-mode.ts` (`endpoints`, URL variable constants), `kete/job-secrets.ts` (`setOrganization`/`organization`; imports `./sync/cache.js`, no cycle expected), `kete/sync/{sync,client,cache}.ts`; core `kete/gateway.ts` (uses `KeteHttpURL`/`KeteJobMode.endpoints`), `kete/sync/plugin.ts`; cli `kete/job-sync.ts` (new), `job.ts`, `job-standalone.ts`, `job-serve.ts`.
- Files changed (tests): util `sync.test.ts`, `job-mode.test.ts`, `job-secrets.test.ts`; core `agent-sync.test.ts`, `policy-sync.test.ts`; cli `job-sync.test.ts` (new), `job-serve.test.ts`, `job-standalone.test.ts`, `job-socket.subprocess.test.ts`. Docs: `docs/jobs.md` (contracts.md and cards left to the librarian).
- Decisions / small deviations: (1) `KeteJobSync.first` checks `spec.agent` absent (refused) before any network call, and the platform-URL error before that; plan listed sync first. (2) In the plugin, job mode with no platform URL/key logs an error and skips fetching (the sync effect returns `undefined`, handled), guard stays on. (3) Job-mode `syncOptions` is `{config, data, native: undefined}` from `Global.Path`, so `KeteAccount.defaults()` (OS key store) is never called in job mode. (4) The secrets-message field is `organization`; `job-serve` `Deps` gained `setOrganization`. (5) `KeteSync.load` option type is `Pick<Options, keyof KeteAccount.Options | "credential">`.
- Risks to check when running: type of `start`'s third param in `agent-sync.test.ts` (`Pick<Parameters<typeof KeteAgentSync.make>[0] & {}, ...>`); `as never` casts in the AC4 test (`applyLate` fed a hand-built event and `get`); the subprocess test's fake serving `/api/v1/sync` plus 404s for `/api/v1/models`/`/me`; `job-socket` AC for the managed agent's `x-kete-agent-id` on the real chat request. `gateway.test.ts` job cases must pass unchanged.
- Open: Linux/Docker run of the subprocess test not attempted.

## 2026-10-01 coordinator (checks)

- Subagents had no shell, so the coordinator ran the checks. Typecheck util/core/cli PASS; Kete tests util 167/0, core 253/0, cli 164/0 (1 skip); lint 0/0; upstream:check passed.
- Fixed a test bug in `cli/test/kete/job-socket.subprocess.test.ts`: `setup(name, undefined)` fell back to the default agent `"developer"`, so the "no agent" case ran a real job and timed out. `setup`/`runRefused` now take `null` for "no agent".

## 2026-10-01 reviewer → coordinator

- Reviewer verdict: approve, minors only. Fixed: the first sync now has an overall 120 s deadline and takes the job fiber's interrupt signal (`job-sync.ts` `deadline`, `signal`; `job.ts` passes `Effect.promise`'s signal); 2 tests added. Left as is: the D6 guard hint (approved), JobRun's optional agent outside job mode (unchanged behaviour). Cards → librarian at close.
