# Plan: Job mode part 2: the Go root helper and its tool-runner client

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task — needs the user's approval of this plan before building.** Security-critical (the
> helper is the only boundary between `kete` and root), a new versioned contract (the helper socket
> protocol, `KETE_JOB_TOOL_SOCKET` added to the image ↔ runtime env contract), a new toolchain (Go)
> and a new CI workflow. **Upstream edits: none.** Every changed or new file is under a Kete-owned
> path (`packages/kete-root-helper/`, `packages/*/src/kete/`, `packages/*/test/kete/`,
> `.github/workflows/kete-root-helper.yml`, Kete docs), so no `kete_change` markers and no
> `docs/upstream-patches.md` entry. The upstream seam is unchanged: `CrossSpawnSpawner.node` is still
> replaced from the Kete-owned `job-server.ts`; only the runner passed to `KeteToolRunner.layer`
> changes.

Requirements source: kete-code-platform `docs/jobs.md` §8 item 3 (lines 383-419) and ADR 0019 rule
5 (`docs/adr/0019-container-host-fly-machines.md` lines 84-127). Decisions needing the user are in
§7 (D1–D10); the plan assumes the recommended option for each.

## Cards read
- docs/context/modules/job-mode.md (verified-at a90d57e2d8, stale: no)
- docs/context/modules/kete-tools-ci.md (verified-at 178e4149d9, stale: no)
- docs/context/modules/brand-env.md (Quick answers only: the `KETE_*` → `OPENCODE_*` bridge is prefix-based, `env.ts:34-51`, so `KETE_JOB_TOOL_SOCKET` needs no bridge code)
- docs/context/{INDEX,commands,pitfalls,decisions,contracts}.md

## Files

The implementer reads ONLY these. "Read" rows are for semantics to mirror; don't change them.

| File | Read / change | Why |
|---|---|---|
| `../kete-code-platform/docs/jobs.md` lines 364-441 | read | The requirement (§8 item 3). Outside this repo; read-only. |
| `../kete-code-platform/docs/adr/0019-container-host-fly-machines.md` lines 84-127 | read | ADR 0019 rule 5, the helper's interface rules. Read-only. |
| `node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect/src/unstable/process/ChildProcess.ts` | read | `Command` (Standard/Piped), `CommandOptions` (cwd, env, extendEnv, shell, detached, stdin/stdout/stderr forms, additionalFds, killSignal/forceKillAfter), `Signal` names. |
| `node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect/src/unstable/process/ChildProcessSpawner.ts` | read | `ChildProcessHandle` fields, `makeHandle`, `make`, `ExitCode`, `ProcessId`. |
| `packages/util/src/cross-spawn-spawner.ts` | read | The semantics the client must mirror: `env()` (extendEnv, `undefined` → inherit), `stdin()`/`stdio()` config normalisation, `setupStdin`, `setupOutput` (Sink → `Stream.transduce`, `all` = merge), the 1 s post-exit output deadline (`spawn`, ~line 300), `stop()` (killSignal default SIGTERM, forceKillAfter → SIGKILL), the release logic, `exitCode` failing on a signal with "Process interrupted due to receipt of signal: '…'", and the `PipedCommand` branch (lines ~500-545). |
| `packages/core/src/shell.ts` lines 250-330 | read | How the shell tool spawns: `ChildProcess.make(shell, args, {cwd, env: {...process.env, TERM, …}, stdin: "ignore", detached: true, forceKillAfter: 3s})` and consumes `handle.all`. Drives env filtering (D6) and group kill (D2). |
| `packages/util/src/kete/tool-runner.ts` | change | Header comment: the real runner now exists (`tool-helper.ts`); `Interface`/`unavailable`/`layer` unchanged. |
| `packages/util/src/kete/job-mode.ts` | change | Add `toolSocketVariable = "OPENCODE_JOB_TOOL_SOCKET"`, `toolSocketPublicName`, `toolSocket(env)`; neutral `message()` wording (D9). |
| `packages/util/src/kete/tool-helper-protocol.ts` | new | Pure protocol: constants, frame encode/incremental decode, message types, JSON body schemas (Effect `Schema`), limits. No I/O. |
| `packages/util/src/kete/tool-helper.ts` | new | `KeteToolHelper.runner({ socket, … }): KeteToolRunner.Interface` — the client (node:net unix socket). |
| `packages/server/src/kete/job-server.ts` | change | `replacements(options, mode, env = process.env)`: socket set → `KeteToolRunner.layer(KeteToolHelper.runner({socket}))`; unset → `unavailable`; invalid → throw at boot. |
| `packages/server/script/kete/isolated-test.ts` | read | It **drops every `KETE_*` variable** and sets HOME/TMPDIR to temp dirs — the AC5 test's gating env must use non-`KETE_` names. |
| `packages/server/test/kete/job-mode.test.ts` | change | Harness to reuse; add case (g): job mode with a socket → a shell tool call reaches a fake helper (AC4 wiring); keep (a) (no socket → refused). |
| `packages/server/test/kete/job-helper-e2e.test.ts` | new | AC5: embedded server in job mode + the real helper; shell tool runs `id -u` as the tool user. Runs only when `HELPER_E2E_SOCKET` is set. |
| `packages/util/test/kete/job-mode.test.ts` | change | `toolSocket()` parsing; new message wording. |
| `packages/util/test/kete/tool-runner.test.ts` | change | New message wording. |
| `packages/util/test/kete/tool-helper-protocol.test.ts` | new | Framing/decoding, limits, the shared vectors file. |
| `packages/util/test/kete/tool-helper.test.ts` | new | Full `ChildProcessHandle` contract against the fake helper (AC4). |
| `packages/util/test/kete/fixture/fake-tool-helper.ts` | new | A TS fake helper (node:net server speaking protocol v1, spawning locally with `Bun.spawn` as the current user; records requests; configurable errors/delays). Test-only. |
| `packages/core/test/kete/job-spawn-sites.test.ts` | change (only if it flags the new files) | If `tool-helper.ts`/`tool-helper-protocol.ts` match a pattern (they mention `ChildProcessSpawner`), classify them `implementation` ("the job-mode tool runner client; spawns nothing locally"). |
| `packages/kete-root-helper/go.mod`, `go.sum` | new | Module `github.com/kete-org/ketecode/packages/kete-root-helper`; `go 1.26` + `toolchain go1.26.x` (D8); one dependency `golang.org/x/sys`. `go.sum` generated in the container (`go mod tidy`). |
| `packages/kete-root-helper/.gitignore` | new | `dist/`. |
| `packages/kete-root-helper/README.md` | new | The contract: security model, start-up flags, protocol v1 (framing, types, state machine, limits, errors), the spawn sequence, kernel requirements, how to test. |
| `packages/kete-root-helper/cmd/kete-root-helper/main.go` | new | Entry: `__exec` dispatch to stage 2; no_new_privs self re-exec; flag parsing → `config`; start-up checks; run `server`. |
| `packages/kete-root-helper/internal/config/config.go` + `config_test.go` | new | Flags → validated `Config` (pure). |
| `packages/kete-root-helper/internal/protocol/frame.go`, `messages.go`, `protocol_test.go`, `testdata/vectors.json` | new | Framing, strict JSON decode, binary credit/EOF bodies, limits; cross-language test vectors shared with the TS test. |
| `packages/kete-root-helper/internal/policy/policy.go` + `policy_test.go` | new | Pure request validation: argv, env allowlist, cwd lexical check, signal names. |
| `packages/kete-root-helper/internal/ratelimit/bucket.go` + `bucket_test.go` | new | Token bucket with an injected clock. |
| `packages/kete-root-helper/internal/cgroup/cgroup_linux.go` | new | Start-up checks, per-spawn leaf create/remove, list/freeze leaf. |
| `packages/kete-root-helper/internal/launch/launch_linux.go`, `stage2_linux.go`, `signals.go` | new | Stage 1 (helper side: pipes, leaf, `ForkExec` with cgroup fd + pidfd, status pipe, wait, kill) and stage 2 (in-child hardening, `execve`). |
| `packages/kete-root-helper/internal/server/server_linux.go`, `conn_linux.go`, `server_test.go` | new | Listener, peer credentials, connection state machine, stdio pumps with credits; unit tests against a fake `Launcher` over a real unix socket. |
| `packages/kete-root-helper/internal/itest/helper_test.go` | new | `//go:build integration && linux` — AC1–AC3 as root with real users and cgroup v2. |
| `packages/kete-root-helper/scripts/integration.sh` | new | Root-only Linux setup (users, cgroups, worktree root) + builds and runs the integration test binary. Used by the container command and CI. |
| `packages/kete-root-helper/scripts/e2e.sh` | new | AC5 orchestration on Linux (CI): build helper, create tool user/cgroup/root, start helper via sudo, run the server e2e test as the invoking user, stop helper. |
| `.github/workflows/kete-build.yml` | read | Conventions to copy: pinned action SHAs, `concurrency`, `permissions`, budget header comment. Not changed (D7). |
| `.github/actions/setup-bun/action.yml` | read | Reused for the AC5 step. |
| `.github/workflows/kete-root-helper.yml` | new | Path-filtered Linux job: Go vet/unit, integration, AC5 e2e (D7). |
| `docs/jobs.md` ("Job mode" section) | change | Env contract row for `KETE_JOB_TOOL_SOCKET`; what now runs through the helper; replace "Consequences until the root helper exists"; what's still refused; background-process lifetime (D4). |
| `docs/context/contracts.md` §6 and §8 table | change | `KETE_JOB_TOOL_SOCKET` / `OPENCODE_JOB_TOOL_SOCKET`; the helper protocol v1 as an in-repo contract pointer to the README. |

## Design

### 1. Go module: layout, start-up configuration, spawn sequence

**Layout** (`packages/kete-root-helper/`, Linux-only, `CGO_ENABLED=0` static build:
`go build -trimpath -ldflags=-s -o dist/kete-root-helper ./cmd/kete-root-helper`). Pure packages
(`config`, `protocol`, `policy`, `ratelimit`) carry no build tag; everything touching syscalls is
`_linux.go`. Only dependency: `golang.org/x/sys/unix` (Openat2, CloseRange, PidfdOpen,
PidfdSendSignal, Waitid, GetsockoptUcred, Prctl, Statfs). No NSS/user-name lookups (numeric ids only).

**Start-up configuration — flags from the entrypoint only; nothing in a request can change them:**

| Flag | Meaning | Checked at start-up (fail closed: exit non-zero, one-line reason to stderr) |
|---|---|---|
| `--socket PATH` | Socket to create | absolute; parent dir exists, root-owned, not group/other-writable, not a symlink; a stale socket file is unlinked; bound, then `chown(kete-uid, 0)`, `chmod 0600` |
| `--kete-uid N` | The only peer uid accepted | numeric, ≠ 0 |
| `--tool-uid N`, `--tool-gid N` | Fixed target identity | numeric, ≠ 0, tool-uid ≠ kete-uid |
| `--worktree-root PATH` | cwd must resolve beneath it | absolute, `filepath.Clean`-equal; opened `O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` once and kept (the fd, not the path, anchors every check) |
| `--tool-cgroup PATH` | The tool cgroup (e.g. `/sys/fs/cgroup/kete/tool`) | absolute; `statfs` magic = `CGROUP2_SUPER_MAGIC`; `pids.max` and `memory.max` exist and are not `max` (the entrypoint set them); `cgroup.procs` is empty (all tool processes live in per-spawn leaves, D2) |
| `--env-allow A,B,…` | Allowed env names | each matches `^[A-Za-z_][A-Za-z0-9_]*$`; no duplicates; may be empty |
| `--env-set NAME=VALUE` (repeatable, optional) | Fixed values that override request values (e.g. `HOME`, `TMPDIR`, `PATH` for the tool user) (D6) | name valid; value has no NUL |
| `--max-frame N` (default 1 MiB) | Max frame body size | 64 KiB ≤ N ≤ 16 MiB |
| `--max-processes N` (default 32) | Live spawns (populated leaves) | 1–1024 |
| `--spawn-rate R`, `--spawn-burst B` (defaults 20/s, 40) | Token bucket over SPAWN requests and accepted connections | > 0 |

Also at start-up: effective uid 0; kernel ≥ 5.11 (`uname`; `close_range(CLOSE_RANGE_CLOEXEC)` is
the newest syscall used); **no_new_privs on the helper itself**: if `prctl(PR_GET_NO_NEW_PRIVS)` is
0, `runtime.LockOSThread`, `prctl(PR_SET_NO_NEW_PRIVS,1)`, then `unix.Exec("/proc/self/exe",
os.Args, os.Environ())` so the whole re-executed process has it (prctl is per-thread; Go has
threads before `main`) — then verify `NoNewPrivs: 1` in `/proc/self/status` (D9 note). NNP does not
stop root's `setuid`/`setgid`, so the later drop still works; it only guarantees nothing the helper
starts can regain privilege through a setuid/file-capability binary.

**Spawn sequence (D1: two-stage exec).** Go's `SysProcAttr` can do `clone3` +
`CLONE_INTO_CGROUP` (`UseCgroupFD`/`CgroupFD`, Go ≥ 1.20), `CLONE_PIDFD` (`PidFD`, ≥ 1.22),
`Setsid`, and credentials — but it cannot `fchdir` to an fd, cannot run `prctl(NO_NEW_PRIVS)` after
the drop, and its `Dir` is a path resolved by `chdir(2)`, which a tool-user symlink swap can race.
So the helper starts **itself** (`/proc/self/exe __exec`, the running inode — can't be swapped on
disk) as a short-lived stage 2 in the child, which performs the drop and the checks with raw
syscalls and then `execve`s the tool. The pid, the pidfd and the cgroup carry over across `execve`.

Helper side (stage 1, root, per SPAWN, `internal/launch`):
1. Validate the request (`internal/policy`, see §2 limits): argv non-empty, ≤ 4096 entries, no NUL;
   `argv[0]` absolute **or** a bare name without `/` (a relative path with `/` → `exec` error "relative
   executable"); every env name in the allowlist, no duplicates, no NUL; `cwd` absolute,
   `filepath.Clean(cwd) == cwd`, equal to or lexically beneath the configured root path.
2. **Pre-check as root** (early, friendly error; not the security check):
   `openat2(rootFd, rel, {O_PATH|O_DIRECTORY|O_CLOEXEC, RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS})`
   (`rel = "."` for the root itself); failure → error `cwd`. Close the fd.
3. Rate/concurrency: take a token (else error `rate`); live spawns < max (else `busy`).
4. Create the leaf: `mkdir <tool-cgroup>/p<N>` (mode 0700, root-owned, N = monotonic counter),
   open it `O_DIRECTORY|O_CLOEXEC` (verify `O_PATH` vs plain in the integration test — D-risk R2).
5. Pipes: `os.Pipe` for each `pipe` stdio (CLOEXEC); `/dev/null` for `null`. Spec pipe (stage 2
   fd 3), status pipe (stage 2 fd 5, CLOEXEC set by stage 2).
6. `syscall.ForkExec("/proc/self/exe", ["kete-root-helper","__exec"], &ProcAttr{Env: []string{}
   (never nil — nil would inherit the helper's env), Files: [stdin, stdout, stderr, specR, rootFd,
   statusW], Sys: &SysProcAttr{UseCgroupFD: true, CgroupFD: leafFd, PidFD: &pidfd, Setsid: true}})`
   — Go uses `clone3(CLONE_INTO_CGROUP|CLONE_PIDFD)`: the child exists **only** inside the leaf. No
   `Credential` here (stage 2 drops), no `Pdeathsig` (thread-based in Go, unreliable; cleanup is the
   connection-close kill + the entrypoint, see §2).
7. Close child ends; write the stage-2 spec as JSON `{argv, env (filtered + --env-set), rel, uid,
   gid}` — uid/gid from `Config`, never the request — to the spec pipe; close it.
8. Read the status pipe (≤ 4 KiB, 10 s deadline): EOF with 0 bytes = `execve` succeeded (CLOEXEC
   closed it) → send `SPAWNED`; a JSON `{code, errno}` → reap, remove leaf, send `ERROR`; timeout →
   group-kill the leaf, `ERROR internal`.
9. A goroutine `waitid(P_PIDFD, pidfd, WEXITED)` → `EXIT {code|signal}`.

Stage 2 (in the child, still root, already in the leaf; `internal/launch/stage2_linux.go`, entered
from `main` before any flag parsing when `os.Args[1] == "__exec"`):
1. `runtime.LockOSThread()` (the final `execve` and the per-thread prctl run on this thread).
2. Read the spec from fd 3 (bounded to `max-frame`), close fd 3. Set CLOEXEC on fd 5.
3. `syscall.Setgroups([]int{})` → `syscall.Setgid(toolGid)` → `syscall.Setuid(toolUid)` (the
   standard-library versions apply to **all threads** on Linux since Go 1.16; don't use raw
   single-thread variants). Verify `Getresuid`/`Getresgid` all equal the tool ids and `Getgroups` is
   empty; the kernel cleared all capabilities (uid 0 → non-zero, no `SECBIT_KEEP_CAPS`).
4. `prctl(PR_SET_NO_NEW_PRIVS, 1)`; verify `PR_GET_NO_NEW_PRIVS == 1` (already inherited — this
   keeps the ADR's order explicit).
5. **Authoritative cwd check, as the tool user:** `openat2(4 /* root O_PATH fd */, rel,
   {O_PATH|O_DIRECTORY|O_CLOEXEC, RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS})` → `fchdir(fd)` → close it
   and fd 4. The kernel resolves `..` and symlinks relative to the root fd and refuses any escape
   (`EXDEV`), with the tool user's permissions, at the moment of use — no check/use race. (Symlinks
   that stay beneath are allowed; `RESOLVE_NO_SYMLINKS` would break legitimate trees.)
6. Resolve the executable: absolute → as is; bare name → search the final env's `PATH` **as the
   tool user** (never as root), absolute entries only (skip relative/empty entries), first regular
   file with an execute bit. Not found → status `not_found`.
7. `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)` — every fd ≥ 3 (including Go runtime's epoll/pipe
   fds and fd 5) closes at `execve`; only 0–2 survive.
8. `syscall.Exec(path, argv, env)`. On failure write `{code:"exec", errno}` to fd 5, `exit(127)`.
   Any earlier failure: write the matching code (`cwd`, `identity`, `nnp`, `not_found`), `exit(126)`.
   Stage 2 never writes argv/env values into an error.

Verify empirically in the integration test (not assumed): signal mask and ignored set are empty in
the tool (`SigBlk`/`SigIgn` = 0 in `/proc/self/status`) after Go's `syscall.Exec`; `CapEff`/`CapPrm`
= 0; the tool's `/proc/self/cgroup` is the leaf (catches any silent clone3 fallback).

**Kill (pidfd only, own processes only, D2).** Each spawn owns its leaf; the tool user can't move
processes between cgroups (leaf `cgroup.procs` is root-owned). `KILL {signal, scope}`:
- `process`: `pidfd_send_signal(leaderPidfd, sig)` (no-op once reaped).
- `group` (the client's default, mirroring upstream's `detached` process-group kill): for SIGKILL,
  write `1` to the leaf's `cgroup.freeze` first; for each pid in the leaf's `cgroup.procs`:
  `pidfd_open(pid)`, then re-read `/proc/<pid>/cgroup` and require it to be this leaf (the pidfd pins
  identity, so pid reuse can't redirect the signal), then `pidfd_send_signal`; thaw; repeat until
  `cgroup.events` says `populated 0` or 10 rounds.
- Signals: `SIGTERM SIGKILL SIGINT SIGHUP SIGQUIT SIGUSR1 SIGUSR2` only; anything else → `bad_request`.
- There is no request field naming a pid or cgroup: a connection can only kill its own spawn.

**Lifetime (D4).** When the connection closes (client scope released, client crash) or when the
leader has exited and both output pipes reached EOF (helper then closes), the helper group-kills
whatever remains in the leaf with SIGKILL and `rmdir`s it. Background processes never outlive their
tool call in job mode. On helper shutdown (SIGTERM from the entrypoint), close the listener, kill all
leaves, exit.

**Logging.** One JSON line per event to stderr (the entrypoint captures it): `conn`, `spawn` id
(`p<N>`), `pid`, basename of `argv[0]`, `cwd` relative to the root, exit code/signal, error code.
Never argv beyond `argv[0]`'s basename, never env values (may hold secrets).

### 2. Protocol v1 (contract; written in the README)

- **Transport:** one unix stream connection **per spawned process** (D3). The helper checks
  `SO_PEERCRED` uid == `--kete-uid` right after `accept` (else `ERROR peer`, close); peer pid/gid
  are ignored. The socket file is 0600 owned by the kete uid, so the tool user can't even connect.
- **Frame:** `u32 big-endian body length` | `u8 type` | body. Body length ≤ `max-frame` (HELLO,
  SPAWN) or ≤ 64 KiB (data). Oversized → `ERROR too_large`, close (the helper never allocates past
  the limit — read the header, check, then read).
- **Bodies:** control messages are UTF-8 JSON decoded strictly (unknown fields, wrong types,
  trailing data → `bad_request`); data frames are raw bytes (binary-safe); credit/EOF are fixed
  binary.

| Type | Dir | Body | When |
|---|---|---|---|
| `0x01 HELLO` | c→h | `{"protocol":1}` | first frame, within 5 s of connect |
| `0x41 HELLO` | h→c | `{"protocol":1,"maxFrame":N,"dataChunk":65536,"stdinWindow":262144,"outputWindow":262144,"env":[names]}` | reply; version ≠ 1 → `ERROR version` |
| `0x02 SPAWN` | c→h | `{"argv":[…],"env":[["NAME","value"],…],"cwd":"/abs","stdin":"pipe"\|"null","stdout":"pipe"\|"null","stderr":"pipe"\|"null"}` | exactly once, within 5 s of HELLO |
| `0x42 SPAWNED` | h→c | `{"pid":N,"id":"p17"}` | after stage 2 exec'd |
| `0x03 STDIN` | c→h | raw ≤ 64 KiB | only within granted stdin credit |
| `0x04 STDIN_END` | c→h | empty | closes the child's stdin |
| `0x48 STDIN_CREDIT` | h→c | `u32` bytes | initial window at SPAWNED, then as the helper writes to the pipe |
| `0x05 CREDIT` | c→h | `u8 stream (1 stdout, 2 stderr)`, `u32` bytes | client grants output credit as its consumer pulls |
| `0x43 STDOUT` / `0x44 STDERR` | h→c | raw ≤ min(64 KiB, credit) | never beyond granted credit |
| `0x45 EOF` | h→c | `u8 stream` | pipe closed |
| `0x06 KILL` | c→h | `{"signal":"SIGTERM","scope":"group"\|"process"}` | any time after SPAWNED |
| `0x46 EXIT` | h→c | `{"code":N\|null,"signal":"SIGKILL"\|null}` | leader reaped |
| `0x47 ERROR` | h→c | `{"code":"…","message":"…"}` | always terminal: the helper closes after it |

- **State machine:** `HELLO → SPAWN → (STDIN|STDIN_END|CREDIT|KILL)*`; anything out of order →
  `bad_request`. Error codes: `version peer too_large bad_request rate busy env cwd not_found exec
  identity nnp internal`. Messages never contain argv or env values.
- **Flow control / backpressure:** credit-based per stream in both directions. The helper reads a
  pipe only while that stream has credit, so an unread stderr blocks only the child's stderr (as a
  real pipe would), never the connection's control frames; stdin data beyond the granted window is a
  protocol error, so the helper's socket reader never blocks on a pipe write. Credit total > 16 MiB
  outstanding → `bad_request`. Socket write deadline 60 s (a client that stops reading entirely) →
  close + kill.
- **Limits:** max-frame; 64 KiB data frames; argv ≤ 4096 entries; env ≤ 1024 entries; handshake
  timeouts 5 s; spawn rate/burst; max live spawns; max open connections = max-processes + 8 (excess
  closed immediately after `ERROR busy`).
- **Versioning:** `protocol` is an integer; any change to a frame, field or code bumps it; the
  helper accepts exactly the versions it implements. The TS constant and the Go constant are pinned
  by the shared `testdata/vectors.json` (hex frames + decoded values) read by both test suites.

### 3. TypeScript client (`packages/util/src/kete/tool-helper.ts`)

`export * as KeteToolHelper`; `runner(options: { socket: string; connectTimeout?; spawnTimeout? }):
KeteToolRunner.Interface`. Per `spawn(command)`:
- **PipedCommand:** same shape as `cross-spawn-spawner.ts`'s `PipedCommand` branch — flatten
  left/right, spawn the head, then each next stage with `stdin: {stream: source(prev, from)}`; a
  `to: "fdN"` target fails (additionalFds are refused). Each stage is its own helper connection.
- **StandardCommand refusals** (fail with `PlatformError.systemError({_tag: "Unknown", module:
  "KeteToolHelper", method: "spawn", description})`, basename-only wording like the stub): any
  `additionalFds`; stdio `"inherit"`; `shell` set to a string other than a POSIX sh path. `shell:
  true` → argv `["/bin/sh", "-c", [command, ...args].join(" ")]` exactly as Node does. `"overlapped"`
  → `pipe`. `detached === false` → kill scope `process`, else `group`.
- **Env:** effective env as cross-spawn computes it (`extendEnv` → `{...process.env, ...env}`;
  `env === undefined` → `process.env`), then **keep only names in HELLO's `env` list** (D6; the
  helper refuses any stray name as defence in depth). Dropped names are logged at debug level
  (names only, never values).
- **cwd:** `path.resolve(cwd ?? process.cwd())` — the helper decides whether it's beneath the root.
- **Connection:** `Effect.acquireRelease` around `net.createConnection(socket)`; connect + HELLO
  within `connectTimeout` (5 s), SPAWNED/ERROR within `spawnTimeout` (15 s); an incremental frame
  decoder with the protocol's limits (oversized helper frame → fail and destroy). Release: if the
  process hasn't exited, run the same `stop` as upstream (killSignal default SIGTERM, then SIGKILL
  after `forceKillAfter`), then end the socket (the helper then kills the leaf's remainder).
- **Handle** (`makeHandle`): `pid` from SPAWNED; `stdout`/`stderr` = `Stream.fromQueue` over a
  per-stream queue, each chunk pulled grants `CREDIT` for its length, `EOF` ends the stream,
  connection loss fails it with `PlatformError`; Sink option → `Stream.transduce` like upstream;
  `"ignore"` → `null` + `Stream.empty`; `all = Stream.merge(stdout, stderr)`; `stdin` = a Sink that
  splits chunks to ≤ 64 KiB, waits for stdin credit, sends `STDIN`, and sends `STDIN_END` on done
  (honouring `endOnDone`); a Stream stdin option is forked into that sink (`forkScoped`) like
  `setupStdin`; `exitCode` waits for `EXIT` and the EOF of each piped stream, or 1 s after EXIT
  (upstream's output deadline) after which the client switches to discard mode (keeps granting
  credit, drops data); code → `ExitCode(code)`, signal → the same failure text as upstream;
  `isRunning` = EXIT not yet received; `kill(opts)` = `KILL` + await exit, `forceKillAfter` →
  `KILL SIGKILL`; `unref` = `Effect.fail(PlatformError)` (refused in job mode);
  `getInputFd`/`getOutputFd` = failing Sink/Stream.
- Errors map `ERROR.code` to a description `"Job tool runner refused to start \`<basename>\`:
  <code>"` (plus the helper's message, which never holds values).

**Wiring (`job-mode.ts`, `job-server.ts`).** `toolSocket(env)`: unset/empty →
`{kind: "unset"}`; a POSIX-absolute path (starts with `/`, no NUL) → `{kind: "path", path}`;
anything else → `{kind: "invalid", value}` (truncated). `replacements(options, mode, env =
process.env)`: `invalid` → throw `"KETE_JOB_TOOL_SOCKET must be an absolute path (got …)"` at boot
(fail closed, like an invalid `KETE_JOB_MODE`); `path` → `KeteToolRunner.layer(KeteToolHelper.runner
({socket}))`; `unset` → `KeteToolRunner.layer(KeteToolRunner.unavailable)`. The existing prefix
bridge maps `KETE_JOB_TOOL_SOCKET` → `OPENCODE_JOB_TOOL_SOCKET`; no bridge code. Everything else
job mode refuses stays refused: PTY/persistent PTY replacements, `secret-store`/`job-git`
`refuseSpawn` guards, MCP, disk plugins, formatters, project config.

## Steps

1. **Go skeleton + pure packages.** Create the module (`go.mod`, `.gitignore`), `internal/config`,
   `internal/protocol` (+ `testdata/vectors.json`), `internal/policy`, `internal/ratelimit` with unit
   tests. Generate `go.sum` in the container: `docker run --rm -v
   "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm go mod tidy`. Record the exact
   Go version the image reports in `toolchain` (D8).
2. **cgroup + launch (stage 1 and stage 2)** per §1, `internal/cgroup`, `internal/launch`. Before
   coding, read the pinned Go's `$(go env GOROOT)/src/syscall/exec_linux.go` in the container to
   confirm `UseCgroupFD`/`CgroupFD`/`PidFD` fields and that a failed `clone3` with a cgroup fd
   returns an error rather than falling back (note the finding in handoff.md).
3. **server** (`internal/server`): accept loop, peer creds, connection limit, state machine, credit
   pumps, write deadline, close → kill. Behind a `Launcher` interface so `server_test.go` runs with
   a fake launcher (peer uid = `os.Getuid()` accepted; a config with a different kete uid → `peer`).
4. **main**: `__exec` dispatch first, NNP self re-exec, flags, start-up checks, signal handling.
5. **README.md**: the contract (§1 flags, §2 protocol, kill/lifetime rules, kernel ≥ 5.11,
   cgroup layout the entrypoint must provide, test commands).
6. **Integration tests** (`internal/itest`, `//go:build integration && linux`) and
   `scripts/integration.sh` (§4). Run them in the container until green.
7. **TS protocol + client** (`tool-helper-protocol.ts`, `tool-helper.ts`), `job-mode.ts`
   (`toolSocket`, message wording), `tool-runner.ts` comment, `job-server.ts` wiring.
8. **TS tests**: fake helper fixture, `tool-helper-protocol.test.ts` (incl. the shared vectors),
   `tool-helper.test.ts`, updated `job-mode.test.ts`/`tool-runner.test.ts`, server
   `job-mode.test.ts` case (g); `job-spawn-sites.test.ts` classification if flagged.
9. **AC5**: `packages/server/test/kete/job-helper-e2e.test.ts` + `scripts/e2e.sh`.
10. **CI**: `.github/workflows/kete-root-helper.yml`; trigger it on the branch with
    `workflow_dispatch` (`gh workflow run kete-root-helper.yml --repo kete-org/ketecode --ref
    feature/job-root-helper`) and record in handoff.md what was verified empirically (§4 list).
11. **Docs**: `docs/jobs.md`, `docs/context/contracts.md` §6/§8.
12. Full checks (Verification), then hand off to the verifier.

### 4. Tests

**Go unit** (`go vet ./... && go test ./...`, no root): config validation (every flag rule);
framing (partial reads, max sizes, zero-length, unknown type); strict JSON (unknown field, dup env
name, NUL, wrong types); policy (cwd: `..`, `/root/../x`, `//`, trailing `/`, outside root, root
itself; relative executable `./x`, `bin/x`; bare `git` ok; env outside allowlist; signal names);
token bucket; server state machine with the fake launcher (out-of-order frames, oversize, handshake
timeout, credit enforcement both ways, rate → `rate`, max processes → `busy`, connection limit,
peer uid mismatch → `peer`, connection close → launcher kill called).

**Linux integration** (`internal/itest`, root + real second user + cgroup v2). The test binary is
also the kete-side client (re-executed with `SysProcAttr.Credential{Uid: keteUID}`, the standard
`TestHelperProcess` pattern, since Go can't switch uid per goroutine) and the "report" tool program
(re-executed via the helper; prints JSON of uid/gid/resuid, `getgroups`, `PR_GET_NO_NEW_PRIVS`,
`CapEff`/`CapPrm`, `SigBlk`/`SigIgn`, `/proc/self/cgroup`, open fds via raw `open`+`getdents64` on
`/proc/self/fd` excluding the listing fd itself — **not** `os.ReadDir`, which can add Go netpoller
fds — and `getcwd`). Cases:
- AC1: identity = tool uid/gid, groups empty, NNP 1, cgroup = a leaf under the tool cgroup, fds =
  {0,1,2}, cwd = requested dir; `CapEff` 0, `SigBlk`/`SigIgn` 0; env = exactly the allowed + fixed
  names.
- AC2: peer uid ≠ kete (connect as a third uid, and as root) refused; tool user can't connect
  (`EACCES`); cwd `../`-escape, absolute outside, symlink escaping (`ln -s /etc wt/evil`), and a
  symlink **swapped in after the root pre-check** (race loop in a goroutine flipping a dir ↔ symlink
  while spawning 200 times — every spawn either succeeds beneath the root or fails `cwd`, never runs
  outside); relative executable; env outside allowlist; frame > max; rate burst; > max processes.
- AC3: 10 MiB stdout through `cat` of random bytes (sha256 equal); binary stdin round trip;
  interleaved stderr; slow consumer (credit never exceeded: helper-side counter); exit code 3;
  `SIGTERM`-terminated → signal; `kill` group kills a backgrounded grandchild (`sh -c 'sleep 100 &
  wait'`); a second connection can't affect the first's process (no pid field exists; also: its
  leaf is untouched after the first connection's KILL); connection close kills a detached
  grandchild; leaf removed afterwards.
- Also: `--tool-cgroup` without `pids.max` → helper refuses to start; helper started without NNP
  re-execs and reports `NoNewPrivs: 1`.

`scripts/integration.sh` (root, Linux): require `stat -fc %T /sys/fs/cgroup` = `cgroup2fs`; if the
cgroup root has processes and `+pids +memory` can't be enabled (private cgroupns in a container),
move every pid in `/sys/fs/cgroup/cgroup.procs` into `/sys/fs/cgroup/init` first; create
`/sys/fs/cgroup/kete-it/tool`, enable `+pids +memory` in `kete-it/cgroup.subtree_control`, set
`tool/pids.max 512`, `tool/memory.max 1G`; `useradd -M -r -s /usr/sbin/nologin` a tool user and a
kete user (uids from env or created; in CI the kete user is whatever `KETE_IT_KETE_UID` says) and a
third user; worktree root `/tmp/kete-it/wt` (root:shared-group, `2775`); build
`go test -c -tags integration -o /tmp/kete-it/it.test ./internal/itest` and the helper into
`/tmp/kete-it/` (`0755` path); run `/tmp/kete-it/it.test -test.v -test.count=1 "$@"` with the ids,
paths and cgroup in env. Cleans up the cgroups on exit (`trap`).

**Local run (Docker or Colima on the Mac; no Go needed locally):**

```sh
# unit
docker run --rm -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm \
  sh -c 'go vet ./... && go test ./...'
# integration (root, real users, cgroup v2); append e.g. -test.run TestSpawnIdentity
docker run --rm --privileged --cgroupns=private \
  -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm \
  bash scripts/integration.sh
```

With Colima: `colima start` (Docker runtime), then the same commands; first confirm `docker info
--format '{{.CgroupVersion}}'` prints `2`. `--privileged` also lifts Docker's default seccomp
profile, which on older Docker versions returns `ENOSYS` for `clone3`.

**TS client** (fake helper, runs on macOS and Linux; `test.skipIf(process.platform === "win32")` —
job mode is Linux-only, unix sockets): every handle member (pid, exitCode incl. signal failure,
isRunning before/after, kill with default SIGTERM and with forceKillAfter → SIGKILL sent, stdin sink
round trip incl. binary and > window, stdout/stderr/all, 10 MiB output with a slow consumer — the
fake asserts credit is never exceeded, Sink-valued stdout option, Stream-valued stdin option);
piped command (`printf` | `wc -c`); `additionalFds`, `inherit`, `unref`, fd-targeted pipe refused;
`shell: true` → `/bin/sh -c`; env filtered to the HELLO list (fake records names); helper `ERROR`
→ PlatformError whose description has no args/env; version mismatch; connection drop mid-stream →
stream and exitCode fail; scope release before exit → KILL then close; the 1 s post-exit output
deadline. `tool-helper-protocol.test.ts` also decodes/encodes `testdata/vectors.json`.

**Wiring (AC4):** util `job-mode.test.ts` (`toolSocket`: unset, empty, absolute, relative →
invalid); server `job-mode.test.ts` (g): `replacements(serverOptions, {kind:"on"}, {OPENCODE_JOB_TOOL_SOCKET:
<fake socket>})` → the TestLLM shell call reaches the fake helper (it records a SPAWN whose argv
contains the command) and the tool result carries the fake's output; (h) a relative socket →
`replacements` throws; existing (a) still refused with no socket. The minimal fake for (g) lives in
the test file, built on `@opencode/util/kete/tool-helper-protocol`.

**AC5 end to end** (`job-helper-e2e.test.ts`, `test.skipIf(!process.env.HELPER_E2E_SOCKET)` — the
server's isolated test script strips `KETE_*`, so the gate uses `HELPER_E2E_SOCKET`,
`HELPER_E2E_ROOT`, `HELPER_E2E_TOOL_UID`): creates its repo directory under `HELPER_E2E_ROOT`
(`chmod 0o777`, test-only, so the tool user can write), starts the embedded server with
`replacements(serverOptions, {kind:"on"}, {OPENCODE_JOB_TOOL_SOCKET: socket})`, drives a TestLLM
shell call `id -u > uid.txt; id -G >> uid.txt`, asserts the file's content is the tool uid (and
groups = tool gid only) and its owner (`stat.uid`) is the tool uid. `scripts/e2e.sh` (run as the
unprivileged CI user, uses `sudo` for the helper): build helper; `sudo` create tool user, cgroup
(`/sys/fs/cgroup/kete-e2e/tool`), worktree root `/tmp/kete-e2e` (`1777`), socket dir `/run/kete-e2e`
(root, `0755`); start `sudo dist/kete-root-helper --kete-uid "$(id -u)" … --env-allow
PATH,LANG,TERM --env-set HOME=/tmp/kete-e2e --env-set PATH=/usr/bin:/bin &`; wait for the socket;
run `bun run test ./test/kete/job-helper-e2e.test.ts` in `packages/server` with the `HELPER_E2E_*`
env; fail if the output reports a skip (`grep -q ' 0 skip'` style check on bun's summary); stop the
helper (trap). AC5 runs in CI (and on any Linux box with sudo, bun and Go); locally on the Mac it
isn't practical (the repo's `node_modules` are macOS builds) — trigger the workflow instead.

**CI (`.github/workflows/kete-root-helper.yml`, D7):** `on: pull_request`/`push` to `main` with
`paths:` `packages/kete-root-helper/**`, `packages/util/src/kete/{tool-helper,tool-helper-protocol,tool-runner,job-mode}.ts`,
`packages/server/src/kete/job-server.ts`, `packages/server/test/kete/job-helper-e2e.test.ts`,
`.github/workflows/kete-root-helper.yml`; plus `workflow_dispatch`. Same `concurrency`/`permissions:
contents: read` and pinned `actions/checkout` SHA as `kete-build.yml`; `actions/setup-go` pinned by
SHA with `go-version-file: packages/kete-root-helper/go.mod` and `cache-dependency-path: …/go.sum`.
One job, `ubuntu-latest`, `timeout-minutes: 10`: (1) `go vet ./... && go test ./...`; (2) `sudo env
"PATH=$PATH" bash scripts/integration.sh` (Go on PATH under sudo); (3) `./.github/actions/setup-bun`;
(4) `bash scripts/e2e.sh`. Header comment: budget rationale (runs only when these paths change;
~4–6 min). The TS client/fake tests also run in `kete-build.yml`'s existing `kete-checks` job via
`bun test test/kete` in `util` (no change needed there); the AC5 test self-skips there.
**Verify empirically on the first CI run** and record in handoff.md: cgroup v2 mounted rw at
`/sys/fs/cgroup` for root; `pids`/`memory` in `cgroup.controllers` and enable-able under a new
top-level group without systemd interfering; `sudo useradd` works; kernel version (≥ 5.11);
`clone3` into a cgroup allowed; a tool user can traverse `/tmp/kete-e2e` and exec `/usr/bin/id`;
`/home/runner` permissions don't matter (the kete side runs as the runner user itself).

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `docker run --rm --privileged --cgroupns=private -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh -test.run TestSpawnIdentity` → then the full `bash scripts/integration.sh`; CI job `kete-root-helper` step "integration" |
| AC2 | `docker run --rm -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm go test ./internal/policy ./internal/protocol ./internal/ratelimit ./internal/server` → integration `… bash scripts/integration.sh -test.run 'TestRefuse'` |
| AC3 | integration `… bash scripts/integration.sh -test.run 'TestStreams|TestExit|TestKill|TestLifetime'` (plus the server unit tests above) |
| AC4 | in `packages/util`: `bun test ./test/kete/tool-helper-protocol.test.ts ./test/kete/tool-helper.test.ts ./test/kete/job-mode.test.ts ./test/kete/tool-runner.test.ts`; in `packages/server`: `bun run test ./test/kete/job-mode.test.ts`; in `packages/core`: `bun run test ./test/kete/job-spawn-sites.test.ts` |
| AC5 | Linux with sudo+bun+Go: `bash packages/kete-root-helper/scripts/e2e.sh`; in practice `gh workflow run kete-root-helper.yml --repo kete-org/ketecode --ref feature/job-root-helper` then `gh run watch --repo kete-org/ketecode` |
| AC6 | `docker run … golang:1.26-bookworm sh -c 'go vet ./... && go test ./...'`; `bun run typecheck` in `packages/util`, `packages/server`, `packages/core`; `bun test ./test/kete` in `packages/util`; `bun run test ./test/kete` in `packages/server` and `packages/core`; `bun run lint` (root); `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`; CI `kete-build` and `kete-root-helper` green |

Also confirm `bun install` still succeeds with a `packages/*` directory that has no
`package.json` (Bun workspaces glob; scout said none is needed — check, don't assume).

## 7. Decisions for the user
- **D1 Two-stage exec** (helper re-executes itself as a short stage 2 inside the child) instead of
  Go's built-in `SysProcAttr.Credential`/`Dir`: needed for `openat2`+`fchdir` after the drop (no
  symlink race), NNP after the drop, and `close_range`. Cost: one extra `execve` of a small static
  binary per spawn (~1–3 ms). Recommended.
- **D2 One leaf cgroup per spawn** under the tool cgroup, created by the helper; group kill = pidfd
  per process verified in that leaf. **Consequence for the entrypoint task:** the tool cgroup itself
  holds no processes and must be writable by root only; `pids.max`/`memory.max` on it bound all
  leaves together. Alternative: everything directly in the tool cgroup, leader-only kill (a
  `cmd &` grandchild survives `kill`). Recommended: leaves.
- **D3 One socket connection per process**, credit flow control per stream. Alternative: one
  multiplexed connection with process ids (more state, same flow control). Recommended: per process.
- **D4 Lifetime:** in job mode nothing a tool call starts outlives it — on handle release (or exit
  with stdio closed) the leaf is killed. Differs from local mode, where `nohup cmd > f &` survives.
  Recommended for jobs.
- **D5 Bare command names** (`git`, `rg`) are looked up in `PATH` by stage 2 **as the tool user**;
  `./x`/`bin/x` are refused. Alternative: `kete` resolves paths before sending (it would probe
  tool-writable directories as itself). Recommended: stage 2.
- **D6 Env:** the client drops names not in the helper's allowlist (the shell tool passes all of
  `process.env`; without this every shell call would be refused); the helper still refuses strays.
  Plus `--env-set NAME=VALUE` so the entrypoint can give the tool user its own `HOME`/`TMPDIR`/`PATH`
  (otherwise `HOME` would be `kete`'s `0700` data directory). Recommended: both.
- **D7 CI as a separate workflow** `kete-root-helper.yml` with native `on.paths`, rather than a
  job inside `kete-build.yml`: a per-job path filter there needs an extra detection job on every PR
  (GitHub rounds each job up to a minute) or a third-party action. The coordinator's brief said
  `kete-build.yml`; switching is one-line cheap if the user prefers it there.
- **D8 Go version:** `go 1.26` / `toolchain go1.26.<latest patch>` (newest stable at build time;
  ≥ 1.22 is the hard minimum for `PidFD`). Local runs use `golang:1.26-bookworm`.
- **D9 Refusal wording:** `KeteJobMode.message()` becomes "Job mode: tools run only through the
  job's tool runner; refused to start \`x\`." (drops "which this build doesn't have yet", now
  untrue; still used by the stub when no socket is set and by `secret-store`/`job-git`).
- **D10 Minimum kernel 5.11**, checked at helper start-up (Fly's guest kernel must be confirmed by
  the image task).

## Risks
- R1 The helper is the root boundary: keep it small; every request field is validated before any
  syscall; stage 2 is the only code running as root inside the tool's cgroup and runs for
  milliseconds.
- R2 Unverified until run: Go's `clone3` path with `UseCgroupFD` (and whether `O_PATH` cgroup fds
  are accepted), `close_range` flags and `waitid(P_PIDFD)` in the CI kernel, cgroup delegation on
  `ubuntu-latest`. Each has an integration assertion that fails loudly.
- R3 In job mode, ripgrep lives in `kete`'s `0700` data directory, so the tool user can't execute
  it; grep/glob still degrade until the image ships `rg` on the tool user's `PATH` (image task).
  Similarly `git` on repos owned by another uid hits `safe.directory` (entrypoint/image task).
- R4 Rate limits vs. internal spawns (snapshots, git status) — defaults 20/s burst 40; if AC5 shows
  refusals from internal git calls, raise the defaults rather than exempting anything.

## Cards to update after the build
- `job-mode` — the real runner (`tool-helper.ts`), `KETE_JOB_TOOL_SOCKET` and boot refusal, what
  still refuses, lifetime (D4), env filtering (D6), new tests; Gotchas: isolated server tests strip
  `KETE_*`.
- **New card `root-helper`** (`packages/kete-root-helper/**`, `util/src/kete/tool-helper*.ts`):
  flags, spawn sequence, protocol, kill/lifetime, tests, local Docker/Colima commands; add to
  `INDEX.md`.
- `kete-tools-ci` — the `kete-root-helper.yml` workflow, Go toolchain pin, what was verified on
  `ubuntu-latest`.
- `brand-env` — Quick answer: `KETE_JOB_TOOL_SOCKET` bridged like the other job vars.
- `docs/context/commands.md` — Go unit/integration commands via Docker; AC5 via the workflow.
- `docs/context/repo-map.md` — `packages/kete-root-helper/` (Go, Linux-only, not shipped in CLI/VS Code).
