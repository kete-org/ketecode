# Spec: Job mode piece A1: kete's server on a unix socket, secrets by descriptor

- Task: `docs/tasks/2026-10-01-job-socket-server` · Size: large · Created: 2026-10-01
- Status: built and reviewed (2026-10-01)

## Goal
In a cloud job, the real `kete` can run inside the container's firewall: its server listens on a
unix socket only the `kete` user can reach, and the per-run password and the gateway key reach it
through file descriptors, never environment variables. This removes the entrypoint's interim
environment-variable gateway key and unblocks the image PR (PR 2). Piece A1 of the runtime gaps
(user decision, 2026-10-01: A1 → A2 sync from the gateway key → image PR 2 → A3 file confinement
and audit sink). Requirements: kete-code-platform `docs/jobs.md` §8 item 3.

## Scope
- **Socket server (job mode only):** `kete serve` gains a unix-socket listener (e.g. `--socket
  <path>`): unlinks a stale socket, listens in a directory the caller made `0700`, and prints its
  ready line as `{"url":"unix://<path>"}`. In job mode the standalone server `kete job run` starts
  uses it, in a fresh `0700` directory under the `kete` user's runtime dir (short path, ≤ 108
  bytes); `kete job run`'s client talks to it over Bun `fetch` with `unix:`. No TCP listener exists
  in job mode. Outside job mode, `kete serve`, `--standalone`, ACP and the background service keep
  TCP unchanged.
- **Per-run password by descriptor (job mode):** the standalone child gets its password through an
  inherited pipe, not `KETE_PASSWORD`; it never appears in either process's environment.
- **Gateway key by descriptor (job mode):** `KETE_JOB_GATEWAY_KEY_FD=<n>` tells `kete job run` to read
  the key once from that fd and close it; it forwards the key to the serve child the same way; the
  child feeds it to the gateway client as an in-memory overlay (never `process.env`). Job mode with
  neither this nor an account refuses to start with a clear error; an environment-variable key is
  ignored in job mode. The entrypoint switches to passing the key as fd 3 (its launcher already
  supports extra fds) and stops setting `KETE_GATEWAY_KEY`.
- **Non-dumpable:** in job mode, both `kete` processes call `prctl(PR_SET_DUMPABLE, 0)` before
  reading any secret (via `bun:ffi` libc, like the existing process-lock FFI) and refuse to start if
  it fails on Linux.
- **Auth hardening:** constant-time password comparison everywhere; the `?auth_token=` query
  credential refused in job mode.
- **Entrypoint and tests:** the entrypoint passes the key by fd and checks no `KETE_GATEWAY_KEY`
  reaches `kete`; its fake `kete` and integration tests follow; the egress firewall needs no
  exception for `kete`'s own server.

## Out of scope
- A2: sync from the gateway key (jobs still use the default agent until then).
- A3: `openat2` for `kete`'s own file tools; the entrypoint-owned audit/result sink.
- PR 2: the image and the end-to-end test with the real `kete`.

## Acceptance criteria
- [x] AC1: In job mode, `kete job run` starts its server on a unix socket in a 0700 dir and runs a
  session over it; no TCP port is listened on (test: list the process's sockets).
- [x] AC2: The password and gateway key appear in no `/proc/<pid>/environ` of either `kete` process,
  and in no log; a key set as an environment variable is ignored in job mode (tests).
- [x] AC3: Both `kete` processes are non-dumpable in job mode on Linux (`/proc/<pid>/status` or
  `PR_GET_DUMPABLE`), and start fails if `prctl` fails (tests; Linux in a container).
- [x] AC4: `?auth_token=` is refused in job mode; passwords compare in constant time (tests).
- [x] AC5: Outside job mode, `kete serve`, `--standalone`, ACP and the background service behave as
  before (existing tests).
- [x] AC6: The entrypoint's integration suite passes with the key by fd (13/13), and asserts no
  `KETE_GATEWAY_KEY` in `kete`'s environment.
- [x] AC7: typecheck, Kete tests and the touched packages' suites, lint, `upstream:check`,
  `verify --base main`; protocol/client regenerated if any endpoint changes.

## Risks and constraints
- **Upstream edits:** `server/src/process.ts`, `cli/src/server-process.ts`, `cli/src/services/standalone.ts`,
  `serve` command flags, `server/src/auth.ts` are upstream — minimal marked edits.
- **Linux-only behaviour** (prctl, unix-socket permissions) must be tested in a container; macOS
  keeps working for the non-job paths.
- `sun_path` length limits the socket path; Windows has no job mode.
