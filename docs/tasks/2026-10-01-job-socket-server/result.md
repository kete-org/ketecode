# Result: Job mode piece A1: kete's server on a unix socket, secrets by descriptor

## What changed
- `kete serve --socket <path>` (job mode only; job mode refuses any TCP listener) via `server/src/kete/socket-listen.ts`: 0700 parent re-checked, only a stale socket unlinked, socket 0600, ≤ 103-byte path, ready line `unix://<path>`.
- `cli/src/kete/job-standalone.ts`: `kete job run`'s own server in a fresh private dir under a non-world-writable (or sticky) runtime base; the client fetches with `unix:`; the child's stderr forwarded and its last line kept on failure; an explicit guard against any TCP fallback.
- Secrets: `KETE_JOB_GATEWAY_KEY_FD` read once (size cap, timeout, closed on every path) → one JSON message on fd 3 to the serve child (`KETE_JOB_SECRETS_FD`); write-once in-memory key holder (`util/src/kete/job-secrets.ts`); password never in either environment.
- D2: in job mode the descriptor key is the only gateway key, and gateway/platform URLs come only from the entrypoint's environment (`core/src/kete/gateway.ts`).
- `cli/src/kete/dumpable.ts`: `prctl(PR_SET_DUMPABLE, 0)` via `bun:ffi` in both processes before any secret, read back, refuse on failure (Linux).
- Auth: constant-time password compare; `?auth_token=` refused in job mode.
- Entrypoint: the key on a pipe as fd 3, no `KETE_GATEWAY_KEY`; fake kete and TestCredentials updated (fail on an unreadable environ).
- Upstream (marked, recorded): `server/src/{options,process,auth}.ts`, `server/src/middleware/authorization.ts`, `cli/src/server-process.ts`, `cli/src/commands/commands.ts`, `cli/src/commands/handlers/serve.ts`.

## Checks
| Check | Result |
|---|---|
| `bun turbo typecheck` | 37/37 |
| lint, `upstream:check` | PASS |
| Kete tests util / cli / server / core | 162 / 156 / 37 / 249 pass, 0 fail |
| protocol/client `check:generated` | clean |
| `verify --base main` (pre-fix build) | 0 new failures in util, server, core, tui, cli |
| Entrypoint Go unit + integration | PASS, 13/13 |
| Linux container e2e (root+SYS_PTRACE / root / non-root) | 9/9 each |

Reviews: upstream-guard approve; security review approve (1 major — job-mode URLs from config — and 6 minor, all fixed).

## Acceptance criteria
- [x] AC1 — `job-socket.subprocess.test.ts` and the Linux e2e (no TCP listener; session over the socket).
- [x] AC2 — e2e environ checks, `job-secrets`/`job-preflight` tests, TestCredentials.
- [x] AC3 — Linux e2e (`/proc` ownership, EACCES without SYS_PTRACE, PR_GET_DUMPABLE read-back).
- [x] AC4 — `job-auth.test.ts`, `constant-time` tests.
- [x] AC5 — existing suites; `verify --base main`.
- [x] AC6 — entrypoint integration 13/13.
- [x] AC7 — the checks table.

## Remaining (piece A)
A2 sync from the gateway key (next); then the image PR 2; then A3 (`openat2` for kete's own files, the entrypoint-owned audit/result sink).

## Metrics
- Agents used: scout, planner, general builder, reviewer, upstream-guard, librarian
- Time: ~6 h (incl. a disk-space stop)
