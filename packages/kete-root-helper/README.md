# kete-root-helper

A small root process that starts a job's tools as a fixed, unprivileged tool user, inside a
cgroup, with the hardening kete-code-platform `docs/jobs.md` §8 item 3 and ADR 0019 rule 5
require. It is the only boundary between `kete` (running as the `kete` user) and root inside a
job's cloud container. Linux-only; ships in the (future) job container image, not the CLI or VS
Code downloads.

The TypeScript client that speaks this module's protocol is
`packages/util/src/kete/tool-helper.ts`; see the `root-helper` context card for how the two fit
into job mode.

## Security model

- The helper runs as root. It starts every tool process as a **fixed** tool uid/gid, taken only
  from its own start-up flags — never from a request.
- Its socket is 0600, owned by the `kete` uid: the tool user cannot even connect. Every accepted
  connection is additionally checked by `SO_PEERCRED`.
- Every tool process's cwd is confined beneath the worktree root by the kernel itself
  (`openat2(..., RESOLVE_BENEATH)`), checked at the moment of use, as the tool user — not by a
  string comparison that a symlink swap could race.
- Every tool process runs in its own **leaf cgroup** under the configured tool cgroup, so a group
  kill can never reach another connection's process, and so `pids.max`/`memory.max` on the parent
  bound every leaf together.
- `no_new_privs` is set on the helper itself and (redundantly, defense in depth) on every process
  it starts, before that process's own executable runs.
- The helper is small and shells out to nothing: it execs the requested program directly, never
  through `/bin/sh`.

## Building

```sh
CGO_ENABLED=0 go build -trimpath -ldflags=-s -o dist/kete-root-helper ./cmd/kete-root-helper
```

No Go toolchain is required on a macOS development machine; every command below runs in the
official `golang` Docker image (Colima works as the Docker runtime on macOS; confirm
`docker info --format '{{.CgroupVersion}}'` prints `2` first).

## Start-up flags

| Flag | Meaning | Checked at start-up (fail closed) |
|---|---|---|
| `--socket PATH` | Unix socket to create | absolute; parent dir exists, root-owned, not group/other-writable, not a symlink; a stale socket file is unlinked; bound, then `chown(kete-uid, 0)`, `chmod 0600` |
| `--kete-uid N` | The only peer uid the socket accepts | numeric, ≠ 0 |
| `--tool-uid N`, `--tool-gid N` | Fixed identity every process runs as | numeric, ≠ 0, `tool-uid` ≠ `kete-uid` |
| `--worktree-root PATH` | Every spawn's cwd must resolve beneath this | absolute, lexically clean; opened `O_PATH\|O_DIRECTORY\|O_NOFOLLOW\|O_CLOEXEC` once at start-up and kept for the process's life — the fd, not the path, anchors every check |
| `--tool-cgroup PATH` | The parent cgroup every spawn's leaf is created under | absolute; a cgroup v2 directory (`statfs` magic `CGROUP2_SUPER_MAGIC`); `pids.max`/`memory.max` already bounded (not `max`) by the entrypoint; holds no processes directly |
| `--env-allow A,B,…` | Allowed env variable names | each matches `^[A-Za-z_][A-Za-z0-9_]*$`, no duplicates; may be empty |
| `--env-set NAME=VALUE` (repeatable) | Fixed values that override a request's value for `NAME` (e.g. the tool user's own `HOME`/`TMPDIR`/`PATH`) | name valid, value has no NUL |
| `--max-frame N` (default 1 MiB) | Max control-frame body size | 64 KiB ≤ N ≤ 16 MiB |
| `--max-processes N` (default 32) | Max live spawns; also bounds open connections (`N+8`) | 1–1024 |
| `--spawn-rate R`, `--spawn-burst B` (defaults 20/s, 40) | Token bucket over SPAWN requests and accepted connections | > 0 |

Also at start-up: effective uid must be 0; the kernel must be ≥ 5.11 (the newest syscall used is
`close_range`); and the helper ensures **its own** `no_new_privs` is set — if
`prctl(PR_GET_NO_NEW_PRIVS)` is 0, it locks the calling goroutine to its OS thread, sets
`PR_SET_NO_NEW_PRIVS`, then re-execs itself (`/proc/self/exe`, its own running inode) so the whole
process ends up with it set (prctl is per-thread; the exec makes it process-wide).

## Spawn sequence (two-stage exec)

Go's `os/exec`/`syscall.SysProcAttr` can join a new cgroup (`UseCgroupFD`/`CgroupFD`) and get a
pidfd (`PidFD`), but it can't `fchdir` to an fd, can't `prctl(NO_NEW_PRIVS)` after dropping
privilege, and its `Dir` is a path resolved by `chdir(2)` — a race a symlink swap could win. So the
helper re-execs **itself** (`/proc/self/exe __exec`) as a short-lived **stage 2** in the child,
which does the actual privilege drop and checks with raw syscalls, then `execve`s the tool. The
pid, the pidfd, and the cgroup membership all carry across that final `execve`.

**Stage 1** (root, per SPAWN):
1. Validate the request (argv non-empty and ≤ 4096 entries, no NUL; `argv[0]` absolute or a bare
   name with no `/` — a relative path with a `/` is refused as `exec: relative executable`; every
   env name in the allowlist, no duplicates, no NUL; `cwd` absolute, lexically clean, at or beneath
   the worktree root).
2. A friendly pre-check as root: `openat2` the cwd beneath the kept root fd. Not the security
   check — just an early, clear `cwd` error instead of a confusing failure later.
3. Take a rate-limit token (else `rate`); check live spawns < `--max-processes` (else `busy`).
4. Create a leaf cgroup `<tool-cgroup>/p<N>` (root-owned, mode 0700).
5. Create pipes for each `"pipe"` stdio stream; open `/dev/null` for each `"null"` one.
6. `ForkExec` into `/proc/self/exe __exec`, joining the leaf via `clone3(CLONE_INTO_CGROUP)` and
   getting a pidfd via `CLONE_PIDFD`, in a new session (`Setsid`). No `Credential` (stage 2 drops
   privilege itself) and no `Pdeathsig` (unreliable across threads in Go; cleanup is connection
   close + kill, or helper shutdown).
7. Write the stage-2 spec (`{argv, env, rel, uid, gid}` — uid/gid always from the helper's own
   `Config`) as JSON to the spec pipe; close it.
8. Read the status pipe (≤ 4 KiB, 10 s deadline): EOF with 0 bytes means the tool's `execve`
   succeeded (the pipe's write end was closed by `close_range`'s `CLOSE_RANGE_CLOEXEC`) → reply
   `SPAWNED`; a JSON `{code, errno}` body means stage 2 failed before exec → reap, remove the leaf,
   reply `ERROR`; a timeout → group-kill the leaf, reply `ERROR internal`.
9. A goroutine waits for the leader's exit via its pidfd (`waitid(P_PIDFD, ..., WNOWAIT)`, then
   `wait4` to actually reap — avoids any pid-reuse ambiguity) and delivers `EXIT`.

**Stage 2** (still root, already inside the leaf; entered when `argv[1] == "__exec"`, before any
flag parsing):
1. Lock the goroutine to its OS thread (the final `execve` and the per-thread `prctl` need to run
   on it).
2. Read the spec from fd 3 (bounded), close it. Mark fd 5 (status) close-on-exec. Write `0` to
   `/proc/self/oom_score_adj` and read it back (else `identity`): the entrypoint runs the helper
   at −1000 and every child inherits that, which would make every tool immune to the OOM killer,
   its own cgroup's `memory.max` included.
3. `setgroups([])` → `setgid(tool)` → `setuid(tool)` (Go's standard-library versions apply to every
   OS thread on Linux, not just the calling one). Verify `getresuid`/`getresgid` all equal the tool
   ids and `getgroups` is empty.
4. `prctl(PR_SET_NO_NEW_PRIVS, 1)`; verify it reads back as 1.
5. **The authoritative cwd check, as the tool user**: `openat2(rootFD, rel,
   {O_PATH|O_DIRECTORY|O_CLOEXEC, RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS})` → `fchdir` → close both
   fds. The kernel resolves `..` and symlinks relative to the root fd and refuses any escape, with
   the tool user's own permissions, at the moment of use — there is no window between checking and
   using the path.
6. Resolve the executable: an absolute `argv[0]` is used as is; a bare name is looked up on the
   final env's `PATH`, **as the tool user, never as root** — absolute `PATH` entries only, the
   first regular file with an execute bit.
7. `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)`: every fd ≥ 3 (the spec/root fds already explicitly
   closed above, the status fd, and anything the Go runtime itself still held) is marked
   close-on-exec — not closed immediately, so a later exec failure can still report to fd 5 — and
   vanishes at the exec below. Only fds 0-2 (the tool's stdio) survive into the tool.
8. `execve`. On failure, write `{code:"exec", errno}` to fd 5 and `exit(127)`. Any earlier failure
   writes its own code (`cwd`, `identity`, `nnp`, `not_found`) and `exit(126)`. Stage 2 never
   writes argv or env values into an error.

## Kill and lifetime

`KILL {signal, scope}` — there is no pid or cgroup field; a connection can only ever affect its own
spawn:
- `scope: "process"` signals only the leader, via its pidfd (a no-op once it's been reaped).
- `scope: "group"` (the default) signals every process currently in the leaf: for `SIGKILL` it
  freezes the leaf first (`cgroup.freeze`) so nothing can fork away between listing
  `cgroup.procs` and signalling, re-verifies each pid's cgroup membership via `pidfd_open` +
  `/proc/<pid>/cgroup` before signalling it (pid reuse can't redirect the signal), then thaws;
  repeats until the leaf reports empty or 10 rounds pass.
- Accepted signals: `SIGTERM SIGKILL SIGINT SIGHUP SIGQUIT SIGUSR1 SIGUSR2`; anything else is
  `bad_request`.

**Nothing a tool call starts outlives it.** When the connection closes (the client's scope was
released, or it crashed) — or once the leader has exited and both piped output streams have
reached EOF — the helper force-kills whatever remains in the leaf with `SIGKILL` and removes it.
This differs from local (non-job) mode, where `nohup cmd &` can survive its parent. On helper
shutdown (`SIGTERM`), it closes the listener, kills every live leaf, and exits.

## Protocol v1

One unix stream connection **per spawned process**. Frame: `u32` big-endian body length, `u8`
type, then the body (so total frame size on the wire is `5 + length` bytes). The header is always
read and its length checked *before* the body is read — the helper never allocates past the limit.
Control bodies (types below whose name isn't STDIN/STDOUT/STDERR) are strict UTF-8 JSON: an
unknown field, a wrong type, or trailing data after the JSON value is `bad_request`. STDIN/STDOUT/
STDERR are raw, binary-safe bytes, capped at 64 KiB per frame regardless of `--max-frame`.

| Type | Byte | Dir | Body | When |
|---|---|---|---|---|
| `HELLO` | `0x01` | c→h | `{"protocol":1}` | first frame, within 5 s of connect |
| `HELLO` | `0x41` | h→c | `{"protocol":1,"maxFrame":N,"dataChunk":65536,"stdinWindow":262144,"outputWindow":262144,"env":[names]}` | reply; a `protocol` this build doesn't implement → `ERROR version` |
| `SPAWN` | `0x02` | c→h | `{"argv":[…],"env":[["NAME","value"],…],"cwd":"/abs","stdin":"pipe"\|"null","stdout":"pipe"\|"null","stderr":"pipe"\|"null"}` | exactly once, within 5 s of HELLO |
| `SPAWNED` | `0x42` | h→c | `{"pid":N,"id":"p4211-17"}` (opaque; unique per helper process) | after stage 2's `execve` |
| `STDIN` | `0x03` | c→h | raw, ≤ 64 KiB | only within granted stdin credit |
| `STDIN_END` | `0x04` | c→h | empty | closes the tool's stdin |
| `STDIN_CREDIT` | `0x48` | h→c | `u32` bytes | the initial window right after `SPAWNED`, then again each time the helper successfully writes to the pipe |
| `CREDIT` | `0x05` | c→h | `u8` stream (`1` stdout, `2` stderr), `u32` bytes | the client grants more output credit as its own consumer reads |
| `STDOUT` / `STDERR` | `0x43` / `0x44` | h→c | raw, ≤ min(64 KiB, remaining credit) | never sent beyond granted credit |
| `EOF` | `0x45` | h→c | `u8` stream | that stream's pipe closed |
| `KILL` | `0x06` | c→h | `{"signal":"SIGTERM","scope":"group"\|"process"}` | any time after `SPAWNED` |
| `EXIT` | `0x46` | h→c | `{"code":N\|null,"signal":"SIGKILL"\|null}` | the leader has been reaped |
| `ERROR` | `0x47` | h→c | `{"code":"…","message":"…"}` | always terminal: the helper closes the connection right after |

**State machine:** `HELLO → SPAWN → (STDIN\|STDIN_END\|CREDIT\|KILL)*`; anything out of order is
`bad_request`. Error codes: `version peer too_large bad_request rate busy env cwd not_found exec
identity nnp internal`. No message ever contains argv or env values, which may hold secrets.

**End of a session:** `EXIT` can arrive before the last `STDOUT`/`STDERR` frames. Once the leader
has exited and both streams have sent `EOF`, the helper half-closes the connection (the client
reads EOF after the last frame) and keeps reading, so late `CREDIT` frames are harmless, until the
client closes or 5 s pass. It never closes outright while the client may still be writing: the
client's write would fail with `EPIPE`, and Bun then drops the frames it hasn't read yet.

**Flow control** is credit-based, in both directions, per stream. The helper only reads a pipe
while that stream has credit — an unread stderr blocks only the tool's stderr (as a real pipe
would), never the connection's control frames. Stdin data beyond the granted window is a protocol
error, so the helper's own socket reader never blocks on writing to a pipe. Outstanding credit
above 16 MiB is `bad_request`. The socket write deadline is 60 s (a client that stops reading
entirely) — past that, the helper closes the connection and kills the process.

**Versioning:** `protocol` is an integer; any change to a frame, field, or error code bumps it. The
Go and TypeScript implementations are pinned to the same wire format by shared test vectors,
`internal/protocol/testdata/vectors.json`, read by both `internal/protocol/protocol_test.go` and
`packages/util/test/kete/tool-helper-protocol.test.ts`.

## Kernel requirements

Linux ≥ 5.11 (the newest syscall used is `close_range`, added in 5.9, with the `CLOSE_RANGE_CLOEXEC`
flag added in 5.11). Also needed: `clone3` with `CLONE_INTO_CGROUP` (5.7), `CLONE_PIDFD` (5.2),
`openat2` with `RESOLVE_BENEATH`/`RESOLVE_NO_MAGICLINKS` (5.6), `pidfd_open`/`pidfd_send_signal`
(5.1/5.3), and a cgroup v2 unified hierarchy with the `pids` and `memory` controllers delegated to
the tool cgroup (the entrypoint's job, a later task — this module only checks that delegation
happened).

## How to test

No Go toolchain is required locally; every command runs in the official `golang` Docker image.

```sh
# Unit tests (pure packages + the server's protocol state machine against a fake launcher).
docker run --rm -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm \
  sh -c 'go vet ./... && go test ./...'

# Integration tests: root, real second/third users, real cgroup v2. Needs a privileged container;
# --cgroupns=private matches what CI's runner and the eventual job container both look like.
# First confirm `docker info --format '{{.CgroupVersion}}'` prints `2` (Colima on macOS: OK).
docker run --rm --privileged --cgroupns=private \
  -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm \
  bash scripts/integration.sh
# Append a Go test flag to run a subset, e.g.:
#   bash scripts/integration.sh -test.run TestSpawnIdentity
```

`scripts/integration.sh` sets up the cgroup v2 layout, the tool/kete/third users, and the worktree
root, builds the helper and the integration test binary, and runs them — see the script for the
exact layout it creates under `/sys/fs/cgroup/kete-it` and `/tmp/kete-it`.

The TypeScript client and its fake-helper tests run on macOS directly (`bun test` in
`packages/util`); AC5's end-to-end test needs Linux, `sudo`, `bun`, and this module's built binary
— see `scripts/e2e.sh` and `docs/context/modules/root-helper.md`.
