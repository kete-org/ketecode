# Result: Job mode piece A3: openat2 confinement and entrypoint-owned audit/result sink

## What changed
- `packages/util/src/kete/linux-ffi.ts` (new): libc via `bun:ffi` — `openat2` (437) and `getdents64` (217 x86_64 / 61 arm64) by syscall number, per-arch flag tables, errno names; musl or glibc.
- `packages/util/src/kete/confined-fs.ts` (new): opens the worktree root, fail-closed probe (non-Linux, unsupported arch, ENOSYS → refuse), every file operation with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS` and `*at` calls on held dirfds.
- `packages/util/src/kete/job-fs-util.ts` (new): FSUtil wrapper — in-tree content reads, listings, realPath and scan/glob/globUp through the confined layer (walks never enter or report symlinks; caps 200k entries / depth 64); writes refused; metadata passes (N4).
- `packages/util/src/kete/job-audit-sink.ts` (new): `KETE_JOB_AUDIT_FD`, write-once sink, timed serialized writer, relay.
- `packages/core/src/kete/job-files.ts` (new): the job-mode `Environment` files driver.
- `packages/core/src/kete/audit.ts`: storage seam; in job mode the audit goes to the pipe with byte caps (19 MB detail + 1 MB reserve, 20 MB hard stop; N3).
- `packages/server/src/kete/job-server.ts`: three replacements (Environment driver, FSUtil wrapper, `FileSystemSearch` with fff off).
- `packages/cli/src/kete/{job-preflight,job-serve,job-standalone,job,job-run}.ts`: early openat2 check; `kete job run` relays the audit pipe (N1), no `audit_log` in the job result (N2), `audit_failed` when the relay fails (including during the final poll).
- Go entrypoint (`internal/{entry,layout,job,itest,fakeplatform}`): fd 4 audit pipe, root-owned audit file, 20,000,000-byte cap, uploads it; no upload with a fixed note when empty or over cap (N5).
- Tests: util `{confined-fs,confined-fs-linux,job-fs-util,job-fs-util-linux,job-audit-sink}`, core `{job-files,job-files-linux,audit-sink,job-fs-sites}`, server `job-files-wiring`, cli job-run/socket updates, Go `TestAuditOverLimit`, e2e lifecycle planted-symlink steps and export scan.
- Docs: `docs/jobs.md`, `contracts.md` §6/§6d, `docs/upstream-patches.md` (no upstream edits), READMEs, cards (librarian).

## Checks
| Check | Result |
|---|---|
| typecheck util / core / server / cli; `bun turbo typecheck` | PASS |
| Kete tests (macOS) | util 211 pass / 14 skip (Linux-only), core 266, server 39, cli 172 / 1 skip — 0 fail |
| Linux real openat2 (`oven/bun:1.4.2` arm64 glibc; alpine musl as root) | PASS (confined-fs, job-fs-util, job-files, job-files-wiring, job-mode, job-socket.subprocess, job-run) |
| Go gofmt / vet / `go test -race`; integration | PASS |
| Image e2e no-agent, lifecycle (planted symlink refused, audit via pipe), ac5 | PASS (arm64) |
| lint; `upstream:check` | PASS |
| `verify --base main` | 0 new failures |
| x86_64 Linux tests and e2e | on the PR's CI |

## Acceptance criteria
- [x] AC1 — `confined-fs-linux`, `job-fs-util-linux`, `job-files-linux` (conformance suite against the job driver), `job-files-wiring` (read tool refuses a planted symlink, write works); e2e lifecycle symlink steps.
- [x] AC2 — `confined-fs.test.ts` with the syscall stubbed to ENOSYS; darwin socket test asserts the refusal.
- [x] AC3 — `audit-sink.test.ts`, `job-audit-sink.test.ts`; `job-socket.subprocess` (audit on fd 4, no audit file); relay-failure tests → `audit_failed`.
- [x] AC4 — Go `job_test`/`scenarios_test` (`TestAuditOverLimit`); e2e lifecycle uploads the piped audit; export scan finds no audit file in kete's data dir.
- [x] AC5 — existing file-tool and audit tests unchanged and passing; `verify --base main`.
- [x] AC6 — see Checks.

## Deviations and known limits
- Early openat2 check in `KeteJobServe.prepare` (clear error instead of a stack line); the server still checks at boot.
- Review fix: on relay failure the child's fd 4 isn't closed (needs an upstream spawner change); the parent interrupts with `audit_failed` immediately and the child's writer times out within 10 s.
- Residual (in `docs/jobs.md`): metadata calls follow links; a walk rooted outside the tree can spend CPU through a link before results are dropped; `globUp` swallows walk errors like upstream.

## Cards updated
See the librarian entry in handoff.md.

## Metrics
- Agents used: scout, planner, general builder, reviewer (2 rounds), librarian
- Scout lookups: 4, docs enough: 1 (25%)
- Tokens / cost: n/a
- Time: ~1 day
