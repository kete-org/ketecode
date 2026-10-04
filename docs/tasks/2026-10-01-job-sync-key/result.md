# Result: Job mode piece A2: sync from the job's gateway key (docs/jobs.md §8 item 6)

## What changed
- `packages/util/src/kete/http-url.ts` (new): the http(s) URL rule, moved out of `core/src/kete/gateway.ts` so the CLI can share it.
- `packages/util/src/kete/job-mode.ts`: job-mode endpoints (`KETE_PLATFORM_URL`) via the shared URL rule.
- `packages/util/src/kete/job-secrets.ts`: the fd-3 secrets message carries the synced organization id.
- `packages/util/src/kete/sync/{sync,client,cache}.ts`: a `credential: {platform, key}` option; with it, sync reads no account and no key store, sends the job key as Bearer, and a 401 names the job's key (no `kete login` advice).
- `packages/core/src/kete/gateway.ts`: uses the util URL helper.
- `packages/core/src/kete/sync/plugin.ts`: in job mode, sync uses the job key and `KETE_PLATFORM_URL`, treats the job as signed in so the fail-closed policy guard applies, and drops "Run `kete sync`" from the guard message (D6).
- `packages/cli/src/kete/job-sync.ts` (new): `KeteJobSync.first`, the first sync before the server starts; `spec.agent` required and synced; 120 s overall deadline; takes the job's interrupt signal.
- `packages/cli/src/kete/{job,job-standalone,job-serve}.ts`: wire the first sync (D1) and pass the organization to the server child.
- Tests: `util/test/kete/{sync,job-mode,job-secrets}.test.ts`, `core/test/kete/{agent-sync,policy-sync}.test.ts`, `cli/test/kete/job-sync.test.ts` (new), `cli/test/kete/{job-serve,job-standalone,job-socket.subprocess}.test.ts`.
- Docs: `docs/jobs.md`; context cards and `contracts.md` §6d (librarian).

## Checks
| Check | Result |
|---|---|
| typecheck util / core / cli | PASS |
| Kete tests util | 167 pass / 0 fail |
| Kete tests core | 253 pass / 0 fail |
| Kete tests cli | 166 pass / 1 skip / 0 fail (after the deadline fix) |
| `bun run lint` | 0 warnings, 0 errors |
| `upstream:check` | passed (no upstream files touched) |
| `verify --base main` | 0 new failures (core 30 failures also on `main`: ripgrep / shell syntax) |
| Linux root-only parts of `job-socket.subprocess.test.ts` | not run (macOS host) |

## Acceptance criteria
- [x] AC1 — `util/test/kete/sync.test.ts` "KeteSync with a job's credential" (job key as Bearer, no account; 401 message); `cli/test/kete/job-sync.test.ts` (URL from `KETE_PLATFORM_URL`, Bearer job key).
- [x] AC2 — `core/test/kete/agent-sync.test.ts` "KeteAgentSync in job mode"; `job-socket.subprocess.test.ts:381` asserts `x-kete-agent-id` on the real chat request.
- [x] AC3 — `job-socket.subprocess.test.ts` "kete job run's first sync (piece A2)": refused key → error 1, unknown agent → refused 2, no agent → refused 2, no server and no chat request in each; `job-sync.test.ts` covers failures, skill downloads and the interrupt.
- [x] AC4 — `core/test/kete/policy-sync.test.ts` "organization policies in job mode".
- [x] AC5 — existing sync, agent-sync, policy-sync and gateway tests pass unchanged; `verify --base main` 0 new failures.
- [x] AC6 — see Checks.

## Deviations
- Missing `spec.agent` is refused before any network call.
- Job-mode sync never calls `KeteAccount.defaults()` (`native: undefined`).
- Review fix: the first sync has an overall 120 s deadline and carries the job fiber's interrupt.
- Test fix: the subprocess test's "no agent" case passed `undefined`, which took the default `"developer"`; it now uses `null`.

## Cards updated
cli, gateway, job-mode, sync; `contracts.md` §6d (see librarian report in handoff).

## Metrics
- Agents used: scout, planner, implementer, verifier (no shell; coordinator ran checks), reviewer, librarian
- Scout lookups: 5, docs enough: 1 (20%)
- Tokens / cost (from /usage): n/a
- Time: ~1 day
