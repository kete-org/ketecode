---
module: root-helper
paths: [packages/kete-root-helper/**, packages/util/src/kete/tool-helper.ts, packages/util/src/kete/tool-helper-protocol.ts, .github/workflows/kete-root-helper.yml]
verified-at: 6d8972321a
---

## Quick answers
- What is this module? The Go root process that starts a job's tools as a fixed, unprivileged tool
  user (kete-code-platform `docs/jobs.md` §8 item 3, ADR 0019 rule 5) — the only boundary between
  `kete` (running as the `kete` user) and root inside a job's cloud container. Linux-only; ships in
  the job container image (piece D, not built yet), not the CLI or VS Code downloads (`README.md:1-11`).
- How does job mode pick it up? `KETE_JOB_TOOL_SOCKET`/`OPENCODE_JOB_TOOL_SOCKET` (a path) —
  `KeteJobServer.replacements` (`packages/server/src/kete/job-server.ts:89-96`) uses
  `KeteToolHelper.runner({socket})` when set, else the fail-closed `KeteToolRunner.unavailable`
  stub; an invalid (non-absolute) value throws at server boot. See the `job-mode` card.
- No Go on the Mac — how do I run the tests locally? Docker or Colima, official `golang` image; see
  "Testing" below and `README.md` "How to test". `go.mod`/`go.sum`: `go 1.26.0` / `toolchain
  go1.26.8` (matches what `golang:1.26-bookworm` reports), one dependency `golang.org/x/sys v0.48.0`
  (`go.mod:1-7`).
- Where's the wire protocol defined? `README.md` "Protocol v1" is the contract (frame format,
  message table, state machine, flow control, versioning); `docs/context/contracts.md` §6 points
  here. The Go (`internal/protocol/{frame,messages}.go`) and TypeScript
  (`packages/util/src/kete/tool-helper-protocol.ts`) implementations are pinned to the same wire
  format by shared test vectors, `internal/protocol/testdata/vectors.json`, read by both
  `internal/protocol/protocol_test.go` and `packages/util/test/kete/tool-helper-protocol.test.ts`.
- Where's the egress proxy? `packages/kete-egress/` (piece B of the image work), a separate Go
  module with its own workflow, not a second binary here (D1 of
  `docs/tasks/2026-09-30-job-egress/plan.md`); see the `egress` card. Its `go.mod` and the job
  entrypoint's carry the same Go/`x/sys` pins as this module's — **three pins**, bump them together.
- Who starts it? The job entrypoint (`packages/kete-job-entrypoint/`, `job-entrypoint` card), as
  root at `oom_score_adj` −1000, umask 002, cgroup `R/kete-job/system`, **before `claim`** (ADR 0019
  rule 5), so `--worktree-root` is the fixed worktree parent `/srv/kete-job/work` (root:kete-job
  2750) and `--tool-gid` is the `kete-job` gid (with `setgroups([])` only the primary gid can enter
  that parent). It also creates the cgroups and sets `pids.max`/`memory.max` (the helper only checks
  they exist and aren't `max`). Still not done: the container image (piece D), and `openat2`
  confinement for `kete`'s own file tools (piece A3; `kete`'s unix-socket server is done, A1);
  `ripgrep`/`git` on the tool user's `PATH` are image follow-ups (handoff.md R3).
- Do tools inherit the helper's `oom_score_adj` −1000? **Not since F3**: stage 2 writes `0` to
  `/proc/self/oom_score_adj` and reads it back, as root, before `setgroups`; a failure is an
  `identity` error (`internal/launch/stage2_linux.go:89,156`; README "Spawn sequence" stage 2).
  Without it every tool would be immune to OOM kills, its own cgroup's `memory.max` included.
  Tested by `TestOomScoreReset` (`internal/itest/scenarios_test.go:402`) and the entrypoint's
  TestLifecycle (the fake `kete`'s tool checks it).
- How are per-spawn ids and leaf cgroups named? `p<helper pid>-<counter>`
  (`internal/launch/launch_linux.go:109-122,155`): unique per helper process, so a stale leaf a
  previous helper left (its `rmdir` can lag the last process's exit) never collides with a new
  helper's first spawn ("create leaf: … file exists", seen on CI with the old `p1`). The `SPAWNED`
  `id` is opaque to clients (README protocol table). Test: `TestStaleLeafDoesNotBlockSpawn`
  (`internal/itest/scenarios_test.go:434`).
- AC5 (end to end) and the CI workflow — verified? Yes, as of `verified-at`: the coordinator ran the
  workflow-equivalent checks locally (Colima) and separately the CI facts below were confirmed on
  `ubuntu-latest` per the plan's own empirical-verification list — see "Testing" and "Gotchas".
- Known past-false claim to be aware of: an earlier handoff entry claimed a 200-iteration concurrent
  symlink-swap race test existed and passed when it didn't (`internal/itest/scenarios_test.go` only
  ever had a static symlink case). The real race test,
  `internal/itest/race_test.go`'s `TestRefuseCwdEscapesDuringConcurrentSymlinkSwap`, was added and
  actually run afterward (10/10 pass, `renameat2(RENAME_EXCHANGE)` swap, ≥200 spawns) — see
  handoff.md's two "coordinator" entries at the end for the full correction. Don't cite the earlier
  entry's claim without checking the later one.

- How does a session end on the wire, and why is there a linger? After `EXIT`, both EOFs and
  release, the helper half-closes (`CloseWrite`) and keeps reading late `CREDIT` frames for up to
  5 s (absolute read deadline, `closeLinger`) before closing (`internal/server/conn_linux.go:277-298`
  `finishWriting`). An outright close made Bun clients' late `CREDIT` writes hit EPIPE, and Bun then
  dropped the unread tail (lost output or exit code in ~3% of tool runs);
  `TestSessionHalfClosesAfterExit` reproduces it. `writeErrorAndClose` still closes outright (known
  minor: an error reply can in theory be lost the same way).

## Purpose
Job mode "part 2": the Go root helper is the real `KeteToolRunner.Interface` implementation for
cloud jobs — until this existed, every tool spawn in job mode was refused outright (job mode "part
1"). With the helper and its TypeScript client wired in, a job can run the shell tool, git and the
other spawner-seam processes end to end, as the tool user, inside its own cgroup, with no shell and
no privilege the tool user shouldn't have. Spec: `docs/tasks/2026-09-29-job-root-helper/spec.md`;
full design and decisions D1-D10: `plan.md`.

## Entry points
- `packages/kete-root-helper/cmd/kete-root-helper/main.go` — process entry: `__exec` stage-2
  dispatch first (before flag parsing), `no_new_privs` self re-exec, flag parsing, start-up checks,
  runs the server.
- `packages/kete-root-helper/README.md` — the contract other agents and the image task should read
  first: security model, start-up flags, spawn sequence, kill/lifetime, protocol v1, kernel
  requirements, how to test.
- `packages/util/src/kete/tool-helper.ts` `KeteToolHelper.runner(options)` — the TypeScript client;
  a full `KeteToolRunner.Interface`/`ChildProcessHandle` implementation. Wired from
  `packages/server/src/kete/job-server.ts:89-96`.
- `packages/util/src/kete/tool-helper-protocol.ts` — pure protocol module (frame encode/decode,
  Effect `Schema` message bodies, limits); no I/O.

## Key files
| File | Role |
| --- | --- |
| `internal/config/config.go` | Flags → validated `Config` (pure); every start-up check in the README's flags table |
| `internal/protocol/{frame,messages}.go` | Wire framing, strict JSON control bodies, binary STDIN/STDOUT/STDERR/CREDIT bodies, limits |
| `internal/policy/policy.go` | Pure request validation: argv, env allowlist, cwd lexical check, signal names |
| `internal/ratelimit/bucket.go` | Token bucket (spawn rate/burst), injected clock |
| `internal/cgroup/cgroup_linux.go` | Start-up cgroup checks, per-spawn leaf create/remove, `cgroupMountPoint()` (reads `/proc/self/mountinfo`, not assumed `/sys/fs/cgroup` — a design deviation from the plan, needed for `OwnCgroup`'s hierarchy-relative → absolute path translation) |
| `internal/launch/launch_linux.go`, `stage2_linux.go`, `signals.go` | Stage 1 (root: pipes, leaf, `ForkExec` with cgroup fd + pidfd, status pipe, wait, kill) and stage 2 (in-child: drop, checks, `execve`) — see README "Spawn sequence" for the full 9+8-step sequence |
| `internal/server/{server,conn}_linux.go` | Listener, peer credentials (`SO_PEERCRED`), connection state machine, credit pumps, write deadline; behind a `Launcher` interface so `server_test.go` runs with a fake launcher, no root needed |
| `internal/itest/{helper_test.go,scenarios_test.go,race_test.go}` | `//go:build integration && linux` — AC1-AC3 as root with real users and cgroup v2, plus the concurrent-symlink-swap race test |
| `scripts/integration.sh` | Root-only Linux setup (cgroup v2 layout under `/sys/fs/cgroup/kete-it`, tool/kete/third users, worktree root `/tmp/kete-it/wt`) + builds and runs the integration test binary |
| `scripts/e2e.sh` | AC5 orchestration on Linux (CI): build helper, create tool user/cgroup/root, start helper via `sudo` (pid tracked via a pidfile written by the root shell before `exec`, not `$!` on the `sudo` wrapper — see Gotchas), run the server e2e test, stop the helper |
| `packages/util/src/kete/tool-helper.ts` | `KeteToolHelper.runner(options)` — one persistent state machine (`connectSpawnAndRun`) per spawned process over one `net.Socket`, one `FrameDecoder` |
| `packages/util/src/kete/tool-helper-protocol.ts` | Frame encode + incremental `FrameDecoder`, Effect `Schema` control bodies (`onExcessProperty: "error"`), binary STDIN_CREDIT/CREDIT/EOF bodies |
| `.github/workflows/kete-root-helper.yml` | Path-filtered `ubuntu-latest` job: Go vet/unit → `scripts/integration.sh` under `sudo` → `scripts/e2e.sh` |

## Data flow
1. **Start-up (root, on the image's tool container):** the job entrypoint (`job-entrypoint` card) runs
   `kete-root-helper` with the flags in `README.md`'s table; every flag is validated fail-closed
   (exit non-zero, one-line reason to stderr) before the socket is even bound.
2. **A tool spawn (`kete`, as the `kete` user):** `packages/core/src/shell.ts` (and every other
   `ChildProcessSpawner` seam site — see the `job-mode` card) calls `spawn()`, which reaches
   `KeteToolHelper.runner`'s `spawn` → one new unix connection: `HELLO` → `SPAWN` (argv/env/cwd) →
   `SPAWNED` (or `ERROR`) → stdin/stdout/stderr frames with per-stream credit → `EXIT`.
3. **Helper side, per SPAWN (root):** validates the request, pre-checks the cwd, takes a rate-limit
   token, creates a per-spawn leaf cgroup, forks `/proc/self/exe __exec` into the leaf
   (`clone3(CLONE_INTO_CGROUP|CLONE_PIDFD)`), writes the stage-2 spec, and waits on the status pipe.
4. **Stage 2 (still root, in the leaf):** resets `oom_score_adj` to 0 (F3), drops to the fixed tool uid/gid, sets `no_new_privs`,
   resolves cwd via `openat2(RESOLVE_BENEATH)` as the tool user (the only authoritative,
   race-free check), resolves the executable, closes every fd but 0-2, `execve`s. See README
   "Spawn sequence" for the exact 8-step sequence and why each step exists.
5. **Kill/lifetime:** a `KILL` request or connection close/crash kills the spawn's whole leaf
   (never just the leader) via pidfd-verified signalling; nothing a tool call starts outlives it
   (D4) — see README "Kill and lifetime".
6. **CI:** `kete-root-helper.yml` runs only when the helper, its TS client, or `job-server.ts`
   change (path-filtered, protects the shared CI-minutes budget) — vet/unit, then the Linux
   integration suite under `sudo`, then the AC5 end-to-end test.

## Data and APIs used
- `golang.org/x/sys/unix` — the only Go dependency: `Openat2`, `CloseRange`, `PidfdOpen`,
  `PidfdSendSignal`, `Waitid`, `GetsockoptUcred`, `Prctl`, `Statfs`. No NSS/user-name lookups
  (numeric ids only).
- `packages/util/src/kete/tool-runner.ts` `KeteToolRunner.Interface`/`layer` — the contract
  `tool-helper.ts` implements; see the `job-mode` card for the full `ChildProcessHandle` contract
  this mirrors (`effect/unstable/process/ChildProcessSpawner.ts`).
- `docs/context/contracts.md` §6/§8 — `KETE_JOB_TOOL_SOCKET`/`OPENCODE_JOB_TOOL_SOCKET` as an
  image ↔ runtime env contract; the protocol v1 pointer.

## Rules that must not break
- Every request field is validated before any syscall (README "Security model"); the fixed tool
  uid/gid, worktree root, and cgroup always come from the helper's own start-up flags, **never**
  from a request field.
- No shell, ever: the helper execs the requested program directly. A bare command name is looked up
  on `PATH` **as the tool user**, never as root (D5).
- The cwd check that matters is the one done **after** the privilege drop, via
  `openat2(RESOLVE_BENEATH)` on the kept root fd — the root-side pre-check (step 2) is a friendly
  error only, not the security boundary. Don't "simplify" by relying on the pre-check alone.
- `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)` must run before `execve` — only fds 0-2 survive into
  the tool.
- One leaf cgroup per spawn (D2): a group kill can never reach another connection's process; the
  tool cgroup itself holds no processes directly.
- The TypeScript client is one state machine (`connectSpawnAndRun`) over one socket/one decoder for
  a connection's whole life — splitting it into per-phase listeners silently drops bytes when two
  protocol stages' frames land in the same TCP/socket chunk (this was a real bug found and fixed
  during the build; see Gotchas).
- `Queue.shutdown()` is an interruption, not a graceful end — use `Queue.endUnsafe` for EOF
  (`Cause.Done`), or a stream never resolves cleanly.
- The client never queries the socket to end (`torndown` flag + `Session.teardown`, idempotent):
  every persistent listener (`connect`/`data`/`error`/`close`) checks it first, so a handle release
  can't leave a late event constructing a failure for an already-gone handle.
- `KETE_JOB_TOOL_SOCKET` must be a POSIX-absolute path or job mode refuses to boot — same
  fail-closed treatment as an invalid `KETE_JOB_MODE` (`job-mode.ts:74-79`, `job-server.ts:90-91`).

## Testing
- **Go unit** (no root): `docker run --rm -v "$PWD/packages/kete-root-helper:/src" -w /src
  golang:1.26-bookworm sh -c 'go vet ./... && go test ./...'` — config, protocol, policy,
  ratelimit, server (fake `Launcher` over a real unix socket). Verified with `-race -count=8` on
  `internal/server` specifically during the build.
- **Go integration** (root, real second/third users, real cgroup v2; needs a privileged container):
  `docker run --rm --privileged --cgroupns=private -v "$PWD/packages/kete-root-helper:/src" -w /src
  golang:1.26-bookworm bash scripts/integration.sh` (append `-test.run <Name>` for a subset). Colima
  on macOS works as the Docker runtime — confirm `docker info --format '{{.CgroupVersion}}'` prints
  `2` first. 15/15 tests pass (14 plus `TestOomScoreReset`) (multiple full runs; the race test specifically 10/10 at
  `-test.count=10`).
- **TypeScript client** (macOS or Linux, no Go needed): `bun test ./test/kete/{tool-helper-protocol,tool-helper,job-mode,tool-runner}.test.ts`
  inside `packages/util/` — full `ChildProcessHandle` contract against a fake helper
  (`test/kete/fixture/fake-tool-helper.ts`), the shared protocol vectors, piped commands,
  `additionalFds`/`inherit`/`unref` refusal, env filtering, `shell: true`.
- **Server wiring (AC4):** `bun run test ./test/kete/job-mode.test.ts` inside `packages/server/` —
  case (g) a socket set → a shell tool call reaches a fake helper; (h) a relative socket value →
  `replacements` throws.
- **AC5 end to end** (Linux, `sudo`, `bun`, and this module's built binary — not practical on a
  Mac): `bun run test ./test/kete/job-helper-e2e.test.ts` inside `packages/server/`, gated on
  `HELPER_E2E_SOCKET`/`HELPER_E2E_ROOT`/`HELPER_E2E_TOOL_UID`/`HELPER_E2E_TOOL_GID` (not `KETE_*`-prefixed — see Gotchas);
  in practice run the whole thing via `bash packages/kete-root-helper/scripts/e2e.sh` on Linux, or
  trigger CI: `gh workflow run kete-root-helper.yml --repo kete-org/ketecode --ref <branch>` then
  `gh run watch --repo kete-org/ketecode`.
- `go vet -tags integration ./...` and `gofmt -l` should also be run alongside `go vet ./...`.

## Changes
- `docs/tasks/2026-09-29-job-root-helper/` — spec, plan (D1-D10, the full spawn sequence and
  protocol v1 design), handoff (deviations from the plan as found, the test-flake investigation and
  fix, the false race-test claim and its correction, everything not yet run in this sandbox).
- `docs/tasks/2026-09-30-job-entrypoint/` — F3 (stage 2 resets `oom_score_adj`), the
  `TestOomScoreReset` case; this module's changes also trigger `kete-job-entrypoint.yml`.
- `fix/root-helper-leaf-names` (#62) — leaf names unique per helper process, README's `SPAWNED`
  example id, `TestStaleLeafDoesNotBlockSpawn`.
- Adding a protocol message or field: bump `protocol` (an integer), update both
  `internal/protocol/messages.go` and `tool-helper-protocol.ts`, and add a vector to
  `internal/protocol/testdata/vectors.json` so both suites catch a drift.
- Adding a start-up flag: extend `internal/config/config.go`'s validation and `README.md`'s flags
  table together.

## Gotchas
- **The `tool-helper.test.ts` flake, found and fixed, not by the client's production logic:** three
  causes, all in test/fixture code, none in `tool-helper.ts` itself (handoff.md "coordinator —
  flaky-test fix"):
  1. A test used `runCommand`, itself `Effect.scoped` — the spawn's scope closed before `exitCode`
     was awaited, so release correctly killed the still-running child and `exitCode` reported
     `SIGTERM`. Fixed by awaiting `exitCode` inside the spawn's own scope.
  2. The **fake** helper sent `EOF` on the child's stdout `end` while output was still queued for
     credit, ending the client's stdout early. The real Go helper sends `EOF` only after its output
     pump drains; the fake now matches.
  3. The **fake** helper signalled only the direct child, not its process group, so a
     `trap '' TERM; sleep 30` child could survive `SIGKILL`-adjacent scenarios and hang. The real
     helper kills the whole leaf; the fake now spawns detached and signals the process group.
  Verified 50/10/19/4 runs clean (util `tool-helper.test.ts` 50×, util `test/kete` 10×, server
  `test/kete` 19 pass + 1 skip [AC5, Linux-only], core `job-spawn-sites.test.ts` 4×).
- **`scripts/e2e.sh`'s pid tracking:** capturing `$!` right after `sudo helper &` captures `sudo`'s
  own pid, not the helper's, which isn't reliable for `sudo kill` across sudo configs. Fixed to have
  the root shell `sudo` starts write its own pid to a pidfile *before* `exec`ing the helper — `exec`
  never changes a process's pid, including across the helper's own `no_new_privs` self-re-exec. A
  follow-up fix (`6c3649e3a6`) moved the pidfile into the root-owned socket dir (a root-owned file
  under the sticky `/tmp` can't be removed by the unprivileged runner user) and made every check on
  it go through `sudo`; it also made the script capture the AC5 test's `bun run test` exit status
  itself (`|| status=$?`) so a failing test's output prints — and the helper's log is dumped —
  before the script exits, instead of `set -e` ending the script silently at that line.
- **`internal/itest`'s AC1 fd-count check** can't use `os.ReadDir("/proc/self/fd")` naively — a Go
  binary re-executed as the "report" program always has a small baseline of its own post-exec fds
  (the netpoller) and double-counts its own listing fd. Uses raw `open`+`getdents64` instead,
  excludes the listing fd by number, and asserts on each fd's `readlink` target rather than a fixed
  count — this is what actually proves `close_range` worked.
- **A nil `*os.File` boxed in a non-nil `io.WriteCloser` interface is `!= nil`** — the "null" stdio
  case's naive `if s.proc.Stdin != nil` check was always true, crashing `pumpStdin`; fixed by only
  assigning the field when the concrete pointer is non-nil (`internal/launch/launch_linux.go`).
- **`internal/server`'s `Release`** retries `cgroup.RemoveLeaf` briefly (up to 10× 20ms) before
  giving up and logging — `killGroup`'s own empty-check can race the kernel's bookkeeping by a beat
  under load; found via a real leaked-leaf failure in the integration container, not anticipated in
  the plan.
- **AC5's gating env is deliberately not `KETE_*`-prefixed:** `packages/server/script/kete/isolated-test.ts`
  strips every `KETE_*` variable (and sets HOME/TMPDIR to temp dirs) before running server tests, so
  a gated e2e test needs a differently-named gate — `HELPER_E2E_SOCKET`/`_ROOT`/`_TOOL_UID` (see the
  `job-mode` card's own gotcha about this script).
- **The race-test correction (read both handoff entries, in order):** the first implementer entry
  falsely claimed a 200-iteration concurrent symlink-swap race test existed and passed; it didn't
  exist at all at that point. A security review caught this. The real test
  (`TestRefuseCwdEscapesDuringConcurrentSymlinkSwap`) was written afterward, first with a
  symlink-target-only swap (which the helper refuses outright — any symlinked cwd is rejected — so
  it never exercised the race), then rewritten to `renameat2(RENAME_EXCHANGE)` a real directory with
  a symlink to `/etc`, which does exercise the actual pre-check-vs-stage-2 TOCTOU window. That final
  version ran 10/10 clean. Don't trust a handoff claim of "N iterations, all pass" for this task
  without checking which entry it's in — the later "coordinator" entries are the ones that actually
  executed code.
- `internal/launch/signals.go` has two asymmetric functions: `signalByName` (string → signal, gated
  by the same allowlist as `policy.ValidSignal` — its `default` branch is unreachable through any
  real request, defence in depth only) and `signalName` (signal → string, used to report a tool's
  *actual* exit signal in `EXIT` — genuinely unbounded, since a tool can die from any signal the
  kernel delivers, not just the seven a `KILL` request may name). Don't "fix" `signalName`'s default
  branch as if it were dead code like `signalByName`'s.
