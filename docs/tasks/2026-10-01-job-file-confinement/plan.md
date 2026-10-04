# Plan: Job mode piece A3: openat2 confinement and entrypoint-owned audit/result sink

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task. Needs the user's approval before building.** Security change (file confinement and
> the audit sink of a cloud job) and an additive shared contract (`KETE_JOB_AUDIT_FD`, entrypoint ↔
> `kete job run`, contracts.md §6/§6d). **No upstream file is edited**: every routing change is a
> `LayerNode` replacement in the Kete-owned `server/src/kete/job-server.ts` (the seam
> `routes.ts` already appends last). No config schema change, no server endpoint change, so no
> protocol/client regeneration. New decisions the spec doesn't settle are listed under
> "New decisions (need the user)" below — N1–N5 should be answered before the build.

## Cards read
- docs/context/INDEX.md, commands.md, pitfalls.md, contracts.md §6, §6b, §6d
- docs/context/modules/job-mode.md (verified-at 6d8972321a, stale: no)
- docs/context/modules/audit-log.md (verified-at d5cd08f36b, stale: no)
- docs/context/modules/job-entrypoint.md (verified-at 6d8972321a, stale: no)
- docs/context/modules/root-helper.md (verified-at 6d8972321a, stale: no)
- docs/context/modules/job-image.md (verified-at 6d8972321a, stale: no)
- docs/context/modules/cli.md (verified-at c73dddecab, stale: no)
- `node scripts/agent/stale-cards.mjs job-mode audit-log job-entrypoint root-helper job-image kete-tools-ci cli` → "All cards current."

Code opened where the cards stop (each logged in handoff.md as a gap): the Environment seam and
local driver, the FSUtil service, FileSystem/FileSystemSearch, the read/glob/grep tools, the
instruction readers, `audit.ts`'s writer, `job-run.ts`'s audit reader, `job-standalone.ts`'s spawn,
the entrypoint's `StartKete`/`OpenAudit`/upload, the e2e gateway script and export scan.

## New decisions (need the user)
The spec settles D1–D3. These follow from the code and are not settled by it:

- **N1 — the audit pipe is relayed by `kete job run`.** The entrypoint's pipe is `kete job run`'s
  fd 4. The audit *writer* lives in its `kete serve` child, and the CLI's spawner can't pass an
  existing descriptor to a child (effect `additionalFds` only creates new pipes). So the child writes
  to its own fd 4, a pipe/socketpair to the parent, and the parent copies it byte for byte into the
  entrypoint's pipe. Both hops are pipes, so neither process can seek, truncate or rewrite lines.
  The parent also needs the lines itself: `kete job run` builds its result from the audit (`run
  ended` reason, family cost, denials, `job-run.ts:285-300,656-674`), and once there is no file it
  can only read them from the relay. Alternative: no relay, and the result falls back to the event
  stream (it would lose `cost_scope: family` and the denials list). **Recommended: relay.**
- **N2 — `audit_log` in the job-mode result.** There's no file path any more. Recommended: leave
  `audit_log` out and set `audit_local: true`. Both fields are optional in result v1, so this is
  additive. (Alternative: `"fd:4"`.)
- **N3 — job-mode audit cap.** Today the writer caps *detail* lines at 20 MiB (20,971,520) and never
  caps `permission`/`run` lines (`audit.ts:43,233-265`). The entrypoint caps at 20,000,000 bytes.
  Recommended for job mode only: count **bytes**, not UTF-16 length. Cap detail lines at 19,000,000
  bytes total across all roots and keep the last 1,000,000 for `permission`/`run`/`truncated`. An
  append that would pass 20,000,000 is a write failure: the run is interrupted (fail closed), so the
  entrypoint's cap is never hit by a working `kete`. Outside job mode nothing changes (AC5).
- **N4 — how far FSUtil confinement reaches (D1 names FSUtil).** `FSUtil` is a global service used
  for data/config dirs as well as the worktree, so it can't be replaced outright. Recommended: a job-mode
  wrapper that, **for paths inside the worktree only**, does three things. (a) It routes content and
  listing reads (`readFile`, `readFileString`, `readFileStringSafe`, `readJson`, `readDirectory`,
  `readDirectoryEntries`) and canonicalisation (`realPath`, `resolve`) through openat2. (b) It refuses
  every FSUtil mutation (write, mkdir, remove, rename, copy, chmod, link, symlink, truncate, utimes,
  open/sink/stream). (c) It delegates metadata calls (`stat`, `exists*`, `isDir`, `isFile`, `access`,
  `readLink`, `watch`, `up`, `findUp`, `globUp`, `scan`, `globMatch`). Two consequences: a symlinked
  `AGENTS.md` in the worktree is skipped, not followed (the read tool's discovery,
  `config/plugin/instruction.ts`, `session/instructions.ts`); and metadata about a symlink's
  target (whether it exists, its type and size, names via `scan`) can still be seen in-process, but
  never its content. Alternative: also route the metadata calls (bigger, and it changes `up`/`stat`
  semantics for project/VCS detection).
- **N5 — entrypoint at the cap / empty pipe.** Recommended: more than 20,000,000 bytes → the
  entrypoint stops reading and closes its end, so `kete`'s next write fails and the run is
  interrupted; it uploads nothing and sends the note "audit log not uploaded: too large", the same as
  today's over-limit rule (`job.go:824-826`). Zero bytes (`kete` refused before any session) → no
  upload, note "audit log not uploaded: empty" (TestNoAgent's expectation stays true).

Consequences of settled decisions, for the user to know (no choice needed):
- Job mode now **refuses to start on non-Linux** (spec "fail closed"). Tests that ran a job-mode
  `kete serve` on macOS (`cli/test/kete/job-socket.subprocess.test.ts`) assert the refusal on darwin
  and run the full path only on Linux.
- Job-mode file tools refuse **every** absolute path outside the worktree (spec). That includes
  `kete`'s own truncated-tool-output files under its data dir (`tool-output.ts:91-94`, "full content
  saved to …"). In an unattended job the `external_directory` permission already denies these unless
  the policy allows them, so in practice this mostly changes the error a job sees.
- A relay failure in `kete job run` (it can't forward to the entrypoint) interrupts the run and
  reports `audit_failed` (exit 2), the same outcome a failed audit write gives today.

## Design

### A. Where in-process worktree access happens, and how each is routed
| Path today | What it does in-process | Job-mode route (replacement in `job-server.ts`) |
|---|---|---|
| `Environment.files` → `makeLocalDriver` (`core/src/environment/local.ts`) | read/write/stat/list/remove/move/mkdir with `node:fs`, following symlinks | `Environment.node.replace(KeteJobFiles.node(root))`, the openat2 driver (B) |
| read tool (`tool/plugin/read.ts`) content + directory listing ("list") via `ReadToolFileSystem` (`tool/read-filesystem.ts:394-402`) | `environment.files.read/list` | covered by the Environment replacement |
| edit/write/patch via `FileMutation` (`file-mutation.ts:69-124`) and the tools | `environment.files.*` | covered by the Environment replacement |
| glob/grep tools (`tool/plugin/glob.ts:82`, `grep.ts:104`) | ripgrep **subprocess** (already the tool user, through the helper) + `Environment.typeFollowing` | the type check is covered by the Environment replacement; ripgrep unchanged |
| file search `FileSystemSearch` (`core/src/filesystem/search.ts`) | `fffLayer`: native in-process indexer (`#fff`) over `location.directory` | `FileSystemSearch.node.replace(FileSystemSearch.configured({ fff: false }))` → `ripgrepLayer` (subprocess through the helper) |
| server `FileSystem` service (`core/src/filesystem.ts`, `/fs` routes) read/list/write | `FSUtil.realPath/stat/readFile/readDirectoryEntries/writeWithDirs` | covered by the FSUtil wrapper (routed reads; `writeWithDirs` inside the worktree refused; outside it stays upstream's tmp staging) |
| read tool's `missing()` suggestions (`read.ts:153`), AGENTS.md discovery (`read.ts:89-102` → `session/instructions.ts` `readFileStringSafe`), `config/plugin/instruction.ts:32-70`, `project.ts:258` (`.git/opencode`), `vcs.ts:146`, `snapshot.ts:94`, `location-watcher.ts:37-42` | FSUtil reads/realPath | `FSUtil.node.replace(…KeteJobFsUtil.layer(root)…)` (N4) |
| direct `node:fs` in core (`kete/audit.ts`, `util/process-lock*.ts`, `filesystem/watcher.ts`, `persistent-pty/*`, `shell/select.ts`, `plugin/module.ts`, `environment/local.ts`) | data dir / lock files / metadata-only watcher / off in job mode / replaced | unchanged; pinned by the new static test `core/test/kete/job-fs-sites.test.ts` (step 9) |

There is no separate "list" tool in v2. A directory read through the read tool is the listing, and
it goes through `Environment.files.list`.

The worktree root is the `kete serve` child's cwd at start. It is the prepared worktree
(contracts.md §6d; the child inherits it from `job-standalone.ts:115`). `rootLexical =
process.cwd()` and `rootReal = realpathSync(rootLexical)`. The parent dir is root:kete-job 2750, so
the tool user can't swap the root itself (`job-entrypoint` card, layout).

### B. Operation map: local driver → job driver (behaviour must match)
Shared pre-check for every operation (no syscall when it refuses):
1. Refuse a string containing NUL.
2. Compute `abs = path.resolve(rootLexical, value)`. A relative value resolves against the root,
   which matches the local driver: in a job its relative paths resolve against cwd, and cwd is the
   root.
3. Compute `rel = path.relative(rootLexical | rootReal, abs)`. If it is `..`, starts with `../` or
   is absolute, refuse it as `outside`. `""` becomes `"."`.
4. Every open goes through `openat2(rootFd, rel, how)` with
   `resolve = RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS` (0x08|0x04|0x02) and
   `O_CLOEXEC` always. `RESOLVE_NO_XDEV` stays out (spec).
5. Errno → result: `ENOENT`, `ENOTDIR` → missing (`NotFound`, as `local.ts:96-100`). `ELOOP`
   (symlink or magic link) and `EXDEV` (beneath escape) → **refused**: `Environment.Failed` with
   cause `KeteConfinedFs.Refused` and the message "Job mode: refused to follow a symbolic link or
   leave the working tree: <rel>". The message never contains a target or any content. `EAGAIN`
   (concurrent rename under `RESOLVE_BENEATH`) and `EINTR` → retry up to 8 times, then `Failed`.
   Any other errno → `Failed` with the errno name.

| Op | Local driver (`local.ts`) | Job driver (openat2 / `*at`) | Errors (same channels) |
|---|---|---|---|
| `read(p)` | `stat(follow)`, not file → `WrongKind`; `readFile` | `fd = openat2(rel, O_RDONLY\|O_NOCTTY\|O_NONBLOCK\|O_CLOEXEC)` (no block on a FIFO); `fstat(fd)`. Directory or other → close, `WrongKind{actual}`. Else read until EOF; `info` from that same `fstat` | `NotFound`/`WrongKind`/`Failed` |
| `read(p,{offset,length})` | `open` + positional `read` | same open; one `pread(fd, length, offset)`; `subarray(0, bytesRead)` | same |
| `write(p,bytes)` | `mkdir -p dirname`; `writeFile` (creates 0666&~umask, truncates, follows a final symlink) | `mkdirp(dirname(rel))` as below; `fd = openat2(rel, O_WRONLY\|O_CREAT\|O_TRUNC\|O_NOCTTY\|O_NONBLOCK\|O_CLOEXEC, mode 0o666)`; `fstat` must be a regular file, else `Failed`; write all; close. A final symlink → `ELOOP` refused | `Failed` only |
| `stat(p)` (lstat semantics) | `lstat` | `fd = openat2(rel, O_PATH\|O_NOFOLLOW\|O_CLOEXEC)`. With `O_PATH\|O_NOFOLLOW`, a *final* symlink yields an fd for the link itself (openat2(2)), so `fstat` → `symlink`, the same as `lstat`. A symlink in a *middle* component → refused (intended change). `rel="."` → `fstat(rootFd)` | `NotFound`/`Failed` |
| `list(p)` | `stat(follow)` dir check; `readdir(withFileTypes)` | `fd = openat2(rel, O_RDONLY\|O_DIRECTORY\|O_CLOEXEC)`. `ENOTDIR` → `stat(rel)`: it succeeds → `WrongKind{actual}`; missing → `NotFound`. Then loop `getdents64(fd, 64 KiB)`, skip `.`/`..`, `d_type` → type (`DT_REG` file, `DT_DIR` directory, `DT_LNK` symlink, other known → other). `DT_UNKNOWN` → per-entry `openat2(fd, name, O_PATH\|O_NOFOLLOW)` + `fstat`. A final symlink → refused (local followed it) | `NotFound`/`WrongKind`/`Failed` |
| `remove(p)` | `rm -rf` (missing ok; removes a link, not its target) | `rel="."` → `Failed` (never remove the root). `parent = openat2(dirname, O_PATH\|O_DIRECTORY)`; `stat` the entry relative to `parent`: missing → ok; non-directory (link included) → `unlinkat(parent, name, 0)`; directory → `openat2(parent, name, O_RDONLY\|O_DIRECTORY)`, `getdents64`, recurse with that fd as parent (iterative stack, depth ≤ 512, else `Failed`), then `unlinkat(parent, name, AT_REMOVEDIR)`. `ENOENT` during the walk is ignored (force) | `Failed` only |
| `move(from,to)` | `lstat(from)` (`NotFound`); `lstat(to)` directory → `to/basename(from)`, else `to`; `rename` | `stat(from)` (`NotFound`; a final link is allowed, renaming the link itself, as local does). `stat(to)`: a real directory → destination parent fd = `to`, name = `basename(from)`; else parent = `dirname(to)`, name = `basename(to)` (missing → same). Both parents opened `O_PATH\|O_DIRECTORY`; `renameat(fromParent, fromName, toParent, toName)` | `NotFound`/`Failed` |
| `mkdir(p)` | `mkdir -p` | Walk the components from `rootFd`: `openat2(dirfd, c, O_PATH\|O_DIRECTORY)`. `ENOENT` → `mkdirat(dirfd, c, 0o777)` (`EEXIST` → reopen; race-safe) → reopen. `ENOTDIR` → `Failed`. `ELOOP` → refused. `"."` → no-op | `Failed` only |
| `spawner` | the given spawner | unchanged (the tool runner) | — |

All descriptors are closed in `finally`/`acquireRelease`. The driver supplies all seven `FilesImpl`
methods, so `execDefaults` (`environment/index.ts:23-27`) is never reached. A test asserts that.

Notes:
- `typeFollowing` (glob/grep) calls `stat` → `symlink` → `read(p,{0,0})` → refused → `Failed`.
  The tools' `catchTag("Environment.NotFound")` doesn't catch it, so the tool fails. That is the
  intended refusal.
- A workspace-placed location (`location.workspaceID`) never happens in a job. The job Environment
  layer dies with a clear message if it does, and never falls back to the local driver.

### C. bun:ffi binding (`packages/util/src/kete/linux-ffi.ts`, `KeteLinuxFfi`)
- **Library:** the same rule as `cli/src/kete/dumpable.ts:29-45`. Use musl
  `/lib/libc.musl-${arm64 ? "aarch64" : "x86_64"}.so.1` when it exists, else `libc.so.6`. Load it with
  a lazy `require("bun:ffi")` so the Node build still bundles. Open the library **once** per
  `syscalls()` factory call and keep it open; that factory is called once at server start and the
  result is passed down (no module-level mutable state).
- **Symbols:** `syscall: {args: ["i64","i32","ptr","ptr","u64"], returns: "i64"}` (variadic in libc;
  integer and pointer arguments pass identically on x86_64 SysV and Linux AAPCS64), plus
  `mkdirat(i32, ptr, u32) → i32`, `unlinkat(i32, ptr, i32) → i32`, `renameat(i32, ptr, i32, ptr) →
  i32` (glibc and musl both implement this with `renameat2` on arm64), `fcntl(i32, i32, i32) → i32`,
  `__errno_location() → ptr`. Convert an `i64` return with `Number()`.
- **errno:** read `read.i32(__errno_location(), 0)` straight after a `-1`, in the same synchronous JS
  turn (the pattern of `process-lock-ffi.bun.ts:40-44`).
- **Syscall numbers:** `openat2` is 437 on both arches. `getdents64` is 217 on x86_64 and 61 on
  arm64. Any other `process.arch` → `unsupported`.
- **`struct open_how`** (24 bytes, `OPEN_HOW_SIZE_VER0`): `u64 flags @0, u64 mode @8, u64 resolve @16`,
  little-endian. Build it with a `DataView` over a fresh 24-byte `Uint8Array`. `mode` must be 0 unless
  `O_CREAT` is set (else `EINVAL`). Pass `size = 24`.
- **Paths:** `Buffer.from(rel + "\0")`. Keep a reference until the call returns.
- **Open flags differ per arch.** Use an explicit table keyed by `process.arch`:
  - common: `O_RDONLY 0`, `O_WRONLY 1`, `O_CREAT 0o100`, `O_NOCTTY 0o400`, `O_TRUNC 0o1000`,
    `O_NONBLOCK 0o4000`, `O_CLOEXEC 0o2000000`, `O_PATH 0o10000000`
  - x86_64: `O_DIRECTORY 0o200000`, `O_NOFOLLOW 0o400000`
  - arm64: `O_DIRECTORY 0o40000`, `O_NOFOLLOW 0o100000`
  - `AT_FDCWD -100`, `AT_REMOVEDIR 0x200`, `F_SETFD 2`, `FD_CLOEXEC 1`, `RESOLVE_NO_MAGICLINKS 0x02`,
    `RESOLVE_NO_SYMLINKS 0x04`, `RESOLVE_BENEATH 0x08`
  - A Linux test asserts the table equals `fs.constants` for every flag Node exposes (`O_DIRECTORY`,
    `O_NOFOLLOW`, `O_CREAT`, `O_TRUNC`, `O_NOCTTY`, `O_NONBLOCK`).
- **`linux_dirent64`** (kernel layout, the same under both libcs): `u64 d_ino @0, s64 d_off @8, u16
  d_reclen @16, u8 d_type @18, d_name @19` (NUL-terminated, UTF-8 decoded like Node's readdir).
- **Descriptor I/O** after open uses Node's fd APIs on the raw integer (`fs.fstat`, `fs.read`,
  `fs.write`, `fs.close`; callback/promisified forms, so file I/O stays off the event loop). These
  calls resolve no path.
- **Interface:** `Syscalls` = `{openat2, getdents64, mkdirat, unlinkat, renameat, setCloexec, fstat,
  pread, writeAll, close}`, each returning `{ok, value} | {ok:false, errno}`. `linux()` returns the
  real one or `{unsupported: reason}`. Tests inject an in-memory fake that implements the RESOLVE
  rules.

### D. Fail-closed startup (`KeteConfinedFs.open(rootLexical, sys)`, called from `replacements()`)
1. Platform not `linux`, unsupported arch, or the dlopen failed → throw.
2. `rootFd = openat2(AT_FDCWD, rootReal, O_PATH|O_DIRECTORY|O_CLOEXEC, resolve = NO_SYMLINKS|NO_MAGICLINKS)`.
   `ENOSYS` (kernel < 5.6, seccomp), `E2BIG` or `EINVAL` → throw "Job mode: kete can't confine its
   file access (openat2 unavailable: <ERRNO>); refusing to start." Any other failure → throw with
   the errno name.
3. Probe `openat2(rootFd, ".", O_PATH|O_DIRECTORY|O_CLOEXEC, BENEATH|NO_SYMLINKS|NO_MAGICLINKS)`,
   which must succeed. Then close the probe fd.
4. `replacements()` throws, so `kete serve` refuses to boot (like an invalid `KETE_JOB_MODE`,
   `job-server.ts:84`). `kete job run` then reports `error` (1) with the child's last stderr line
   (`job-standalone.ts:200-208`). There is never a fallback to plain `open`.

### E. Audit sink (D2, N1, N3, N5)
**Entrypoint (Go):**
- `StartKete` creates `auditR, auditW := os.Pipe()` and passes `Extra: {keyR, auditW}`, so `kete`
  gets fd 3 = key and fd 4 = audit. `KeteEnvList` adds `KETE_JOB_AUDIT_FD=4`. After `launch.Start`
  the entrypoint closes `auditW`, so EOF arrives once every `kete` copy is closed.
- A reader goroutine starts *before* launch. It copies `auditR` into the root file
  `/var/log/kete-job/kete.audit.jsonl` (`setup.CreateRootFile`, 0600 root, `layout.KeteAudit()`)
  through `io.LimitReader(auditR, MaxAuditUpload+1)`. More than 20,000,000 bytes → it marks over-limit
  and closes `auditR`, so `kete` gets EPIPE. It records `{size, overLimit, err}`.
- `Machine.OpenAudit()` loses its session-id argument. It waits for the reader after `Reap` (all
  `kete` processes are dead, so EOF; bound 10 s, then note "audit log not uploaded: reader stuck"),
  then opens the root file `O_NOFOLLOW`. `upload` (`job.go:815-829`) uses it: empty → note "empty";
  over-limit → note "too large"; else PUT. `layout.AuditRel` and its `SessionID`-based audit branch
  go away.

**`kete job run` (parent, `cli`):**
- `KeteJobPreflight.run` reads `KETE_JOB_AUDIT_FD`. It is required in job mode, an integer in
  3–1023, not the key's fd, and must `fstat` as a FIFO; otherwise `refused` (2), like the key fd.
  Preflight sets `FD_CLOEXEC`, deletes the variable from `process.env`, and returns the fd.
- `KeteJobStandalone.command` adds `additionalFds.fd4 = {type: "output"}` and sets
  `KETE_JOB_AUDIT_FD=4` in the child env (this overrides the inherited value). `start` forks a relay
  fiber: `proc.getOutputFd(4)` → `KeteJobAuditSink.writer(parentFd)`. Each chunk's write is awaited
  with a 10 s timeout. Bytes are counted, with a hard stop above 20,000,000. The relay tees complete
  lines into a bounded in-memory list, keeping only `type` `run`/`model`/`permission` (≤ 10,000 lines).
- If the relay fails (EPIPE, timeout, cap), it stops reading so the child's next write fails. It
  also triggers the same interrupt path as SIGINT and forces outcome `audit_failed`.
- `job-run.ts` gets one new optional dep, `readAudit(rootID) → Promise<string | undefined>`. The
  default reads the file, so behaviour outside job mode doesn't change. In job mode it returns the
  relay's lines. `pollAuditEnded` uses it instead of `exists`+`readFile`. N2 sets the `audit_log`
  field.

**`kete serve` child (`cli/src/kete/job-serve.ts` + `core/src/kete/audit.ts`):**
- `KeteJobServe.prepare` reads `KETE_JOB_AUDIT_FD` (required in job mode, FIFO or socket), sets
  `FD_CLOEXEC`, deletes the variable, and stores the fd in the write-once
  `KeteJobAuditSink.set(fd)` (pattern: `KeteJobSecrets.setGatewayKey`, `job-secrets.ts:133-145`).
- `audit.ts` gains a storage seam. File storage is today's `create`/`append` code, unchanged. Sink
  storage applies when `KeteJobMode.enabled(process.env)`:
  - `create` writes `run started` once per root (an in-memory set).
  - `append` writes the serialized line under one sink-wide lock, so no two lines interleave on the
    pipe. Each write has a 10 s timeout.
  - N3 caps apply, counted with `Buffer.byteLength`.
  - Job mode with no sink set → `WriteError{code: "no-audit-sink"}`, so `begin` refuses the step.
  - `WriteError.path` is `"fd:<n>"`.
  - The failure path is the existing `writeGuarded` interrupt plus the `Tool.Error` refusal. No
    file or directory is created under `<data>/audit` in job mode.
- **D3:** the result still goes to `kete job run`'s stdout, which is the root-created
  `/var/log/kete-job/kete.stdout` (`entry_linux.go:304-314`). No change.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/core/src/environment/environment.ts` | read | the `Environment` seam: `Service`, `node` (location node, deps) |
| `packages/core/src/environment/index.ts`, `files.ts`, `driver.ts` | read | `Files`/`FilesImpl` contract, errors, `makeFiles`, `typeFollowing` |
| `packages/core/src/environment/local.ts` | read | the behaviour the job driver must match (table B) |
| `packages/core/test/environment.test.ts`, `packages/core/test/fixture/environment.ts` | read | local-driver cases to mirror in the parity tests |
| `packages/util/src/fs-util.ts` | read | `FSUtil.Interface`, `layer` (exported for wrapping), `node` deps; derived helpers call the *inner* FileSystem (`:102-115,163-178`), so the wrapper must override them explicitly |
| `packages/util/src/effect/app-node.ts`, `packages/util/src/effect/app-node-platform.ts`, `packages/util/src/effect/layer-node.ts` (`:70-130`) | read | `makeLocationNode`/`makeGlobalNode`, the `filesystem` node, `replace` rules (same tag) |
| `packages/core/src/filesystem.ts`, `packages/core/src/filesystem/search.ts` | read | FileSystem (covered via FSUtil) and `FileSystemSearch.configured({fff:false})` |
| `packages/core/src/tool/plugin/read.ts`, `glob.ts`, `grep.ts`, `packages/core/src/tool/read-filesystem.ts` | read | how the tools reach Files/FSUtil (table A); expected refusal surface |
| `packages/core/src/session/instructions.ts`, `packages/core/src/config/plugin/instruction.ts` | read | AGENTS.md reads that the FSUtil wrapper covers (N4) |
| `packages/server/src/workerd.ts` (`:74-125`) | read | precedent for replacing `FileSystem`/`FileSystemSearch` nodes |
| `packages/cli/src/kete/dumpable.ts`, `packages/core/src/util/process-lock-ffi.bun.ts` | read | bun:ffi, musl/glibc, errno precedents |
| `packages/util/src/kete/job-secrets.ts`, `packages/util/src/kete/job-mode.ts` | read | fd-variable parsing, write-once overlay, env bridge names |
| **`packages/util/src/kete/linux-ffi.ts`** (new) | change | `KeteLinuxFfi`: libc load, arch tables, `Syscalls` interface, `linux()` (section C) |
| **`packages/util/src/kete/confined-fs.ts`** (new) | change | `KeteConfinedFs`: `open(root, sys)` (section D), pre-check, primitive ops of table B with errno mapping, `Refused` |
| **`packages/util/src/kete/job-fs-util.ts`** (new) | change | `KeteJobFsUtil.layer(root)`: FSUtil wrapper; exported `routed`/`delegated`/`refused` method lists (N4) |
| **`packages/util/src/kete/job-audit-sink.ts`** (new) | change | `KeteJobAuditSink`: `KETE_JOB_AUDIT_FD` parse/validate (bridged `OPENCODE_JOB_AUDIT_FD`), write-once `set`/`get`, `writer(fd)` (awaited writes, timeout, byte count), `relay(stream, writer, opts)` with the line tee |
| **`packages/core/src/kete/job-files.ts`** (new) | change | `KeteJobFiles`: `driver(root, spawner)` → `Environment.Driver` (maps to `NotFound`/`WrongKind`/`Failed`); `node(root)` → location node for `Environment.node.replace` |
| `packages/server/src/kete/job-server.ts` | change | open the root (section D, injectable opener param, default real); add 3 replacements: `Environment.node`, `FSUtil.node`, `FileSystemSearch.node`; header comment |
| `packages/core/src/kete/audit.ts` | change | storage seam; sink storage in job mode (section E, N3) |
| `packages/cli/src/kete/job-preflight.ts` | change | read/validate/cloexec `KETE_JOB_AUDIT_FD` |
| `packages/cli/src/kete/job-serve.ts` | change | child side: audit fd → `KeteJobAuditSink.set` |
| `packages/cli/src/kete/job-standalone.ts` | change | fd 4 `output`, child env var, relay fiber, expose relay handle |
| `packages/cli/src/kete/job.ts` | change | pass the audit fd from preflight to `start`; `readAudit` dep from the relay in job mode |
| `packages/cli/src/kete/job-run.ts` | change | `Deps.readAudit` (default = file); N2 result fields; relay failure → `audit_failed` |
| `packages/kete-job-entrypoint/internal/entry/entry_linux.go` | change | audit pipe, `Extra`, `KETE_JOB_AUDIT_FD=4`, reader goroutine, `OpenAudit()` |
| `packages/kete-job-entrypoint/internal/layout/layout.go` | change | `KeteAudit()` path, `KeteAuditFD = 4`; drop `AuditRel` |
| `packages/kete-job-entrypoint/internal/job/deps.go`, `internal/job/job.go` (`:815-829`) | change | `OpenAudit()` signature/semantics; upload notes (N5) |
| `packages/kete-job-entrypoint/internal/job/job_test.go` | change | fake Machine; empty / too-large / ok upload cases |
| `packages/kete-job-entrypoint/internal/itest/fakekete/main.go` | change | write audit to fd `KETE_JOB_AUDIT_FD` (must be "4", FIFO); prove `lseek` → ESPIPE and `ftruncate` → EINVAL; an `audit-flood` spec knob that writes > 20,000,000 bytes and records EPIPE |
| `packages/kete-job-entrypoint/internal/itest/scenarios_test.go` | change | lifecycle asserts the uploaded audit equals the fakekete's lines and that no file exists under kete's data dir; new `TestAuditOverLimit` |
| `packages/kete-job-entrypoint/internal/fakeplatform/gateway.go` | change | lifecycle steps 2–5: plant symlinks, read (refused), write (refused), remove links (Steps, step 12) |
| `packages/kete-job-entrypoint/internal/e2e/e2e_test.go` | change | `symlink_read_refused`/`symlink_write_refused` checks; the audit has a `tool` line for `read` with `status:"error"` |
| `packages/kete-job-entrypoint/internal/e2e/scan_test.go` | change | export: no entry under `var/lib/kete-job/kete/.local/share/kete/audit/`; no `var/lib/kete-job/kete/e2e-written`; `var/log/kete-job/kete.audit.jsonl` root 0600 and byte-equal to the uploaded audit |
| `packages/kete-job-entrypoint/README.md` | change | Launching (fd 4), Environments (`KETE_JOB_AUDIT_FD=4`), the audit-upload paragraph (`:228-236`) |
| `packages/kete-job-image/README.md` | change | lifecycle scenario now includes the symlink steps |
| `packages/util/test/kete/fixture/fake-syscalls.ts` (new) | change | in-memory tree with symlinks/FIFOs implementing `RESOLVE_*`, `EAGAIN` injection, `ENOSYS` mode |
| `packages/util/test/kete/confined-fs.test.ts` (new) | change | pre-check, errno mapping, retry, probe failures (ENOSYS/EINVAL/non-linux/arch), fd always closed |
| `packages/util/test/kete/confined-fs-linux.test.ts` (new, `skipIf(platform !== "linux")`) | change | real openat2: symlink to `/etc/passwd`, symlinked dir, `..`, absolute, `/proc/self/root` link, a final-link `stat`, FIFO not blocking, swap race, flag table vs `fs.constants`; root-only bind-mounted `/proc` case gated on `CONFINED_FS_ROOT_TESTS=1` |
| `packages/util/test/kete/job-fs-util.test.ts` (new) | change | routed/refused/delegated behaviour; **exhaustiveness**: every key of the real `FSUtil` service is in exactly one list (an upstream-added method fails the test) |
| `packages/util/test/kete/job-audit-sink.test.ts` (new) | change | fd parsing, write-once, writer timeout on a full pipe, EPIPE on a closed reader, relay cap and line tee |
| `packages/core/test/kete/job-files.test.ts` (new) | change | driver over fake syscalls: every op of table B, the error channels, all 7 methods overridden |
| `packages/core/test/kete/job-files-linux.test.ts` (new, Linux only) | change | parity: the same scenario list run through `makeLocalDriver` and `KeteJobFiles.driver` on a real temp tree with no symlinks gives equal results; every symlink/escape case refused by the job driver |
| `packages/core/test/kete/audit-sink.test.ts` (new) | change | job-mode `begin`/`append` to a pipe, no `<data>/audit` dir, closed pipe → `WriteError` + interrupt, N3 caps, no-sink → step refused |
| `packages/core/test/kete/job-fs-sites.test.ts` (new) | change | static allowlist of in-process fs primitives (`node:fs`, `fs/promises`, `Bun.file`, `Bun.write`, `FileSystem.FileSystem`) in `packages/{core,server}/src`, each classified; precedent `job-spawn-sites.test.ts` |
| `packages/core/test/kete/job-spawn-sites.test.ts` | read | the pattern for the static test |
| `packages/server/test/kete/job-files-wiring.test.ts` (new) | change | the replacement list contains the 3 nodes; opener failure → `replacements` throws (AC2); on Linux, an embedded server read tool call on a planted symlink is refused, and an edit works |
| `packages/server/test/kete/job-mode.test.ts`, `job-helper-e2e.test.ts`, `job-auth.test.ts` | change | pass a test opener (fake syscalls) where `replacements(…, {kind:"on"})` or `OPENCODE_JOB_MODE=1` builds a server; set an audit sink where a job-mode prompt runs |
| `packages/cli/test/kete/job-preflight.test.ts`, `job-serve.test.ts`, `job-standalone.test.ts`, `job-run.test.ts` | change | audit fd required/invalid/ok; fd 4 in the command; relay; `readAudit` path |
| `packages/cli/test/kete/job-socket.subprocess.test.ts` | change | darwin: assert the startup refusal (AC2); Linux: give the child fd 4 = a pipe with `KETE_JOB_AUDIT_FD=4` and assert audit lines arrive and `<XDG_DATA_HOME>/kete/audit` is absent |
| `packages/core/test/kete/audit.test.ts`, `audit-service.test.ts` | read | unchanged; they guard AC5 |
| `docs/context/contracts.md` (§6, §6d) | change | `KETE_JOB_AUDIT_FD` (additive), audit via pipe, root file, N2/N5 |
| `docs/jobs.md` ("Job mode") | change | the new variable, confinement, non-Linux refusal |
| `packages/core/src/kete/skill/kete.md` | change | job-mode paragraph and audit-log bullet (where the log goes in a job) |
| `docs/upstream-patches.md` | change | one line under the job-mode section: A3 adds no upstream edit (replacements only) |

## Steps
1. **FFI binding** (`linux-ffi.ts`): section C. Export `Syscalls`, `linux()`, the arch tables, and
   `setCloexec`. Nothing runs at import.
2. **Confined primitives** (`confined-fs.ts`): `open(rootLexical, sys, platform = process.platform)`
   (section D) → `Root {lexical, real, fd, ops}`. The ops implement table B over `Syscalls` and return
   typed results `{missing}|{refused}|{wrongKind}|{failed}` with the errno name. Include the shared
   pre-check, `EAGAIN`/`EINTR` retry (≤ 8), iterative remove (depth ≤ 512), and close in `finally`.
   Write `fake-syscalls.ts` and `confined-fs.test.ts` alongside.
3. **Environment driver** (`core/src/kete/job-files.ts`): adapt `Root` ops to `FilesImpl` with the
   exact error channels of table B. `node(root)` = `makeLocationNode({service: Environment.Service,
   layer, deps: [CrossSpawnSpawner.node, Location.node]})`. The layer takes `ChildProcessSpawner`
   (already the tool runner in job mode) and `Location`; a `workspaceID` dies.
   `job-files.test.ts` covers this.
4. **FSUtil wrapper** (`job-fs-util.ts`): `layer(root)` builds the real FSUtil from `FSUtil.layer`
   (provided with the platform `FileSystem`) and returns `{...real, ...overrides}`.
   - Routed methods take a path inside `root.lexical`/`root.real` and go through `Root` ops.
     `readFileString` supports utf-8 only. `readFileStringSafe` maps missing/refused to `undefined`,
     as upstream does for NotFound/PermissionDenied. `realPath` returns the lexical path or fails
     with `PlatformError` `NotFound`/`PermissionDenied`. `resolve` returns the lexical path on
     NotFound and dies otherwise (upstream shape, `fs-util.ts:102-108`). `readDirectory` with
     `recursive` refuses.
   - Refused methods fail inside the root with `PlatformError` `PermissionDenied` and the description
     "Job mode: kete changes the working tree only through its file tools".
   - Every path outside the root delegates to the real FSUtil.
   - Export the three method lists. `job-fs-util.test.ts` includes the exhaustiveness check.
5. **Wire job mode** (`job-server.ts`): add a 4th parameter, `confine: (root: string) =>
   KeteConfinedFs.Root`, defaulting to `(root) => KeteConfinedFs.open(root, KeteLinuxFfi.linux())`.
   Call it with `process.cwd()` after the existing mode/socket checks and let it throw. Append
   `Environment.node.replace(KeteJobFiles.node(root))`,
   `FSUtil.node.replace(makeGlobalNode({service: FSUtil.Service, layer: KeteJobFsUtil.layer(root),
   deps: [filesystem]}))` and `FileSystemSearch.node.replace(FileSystemSearch.configured({fff:
   false}))`. Update the header comment and the "8-item" wording in comments.
   - Update the server tests that build a job-mode server to pass a fake opener.
   - Add `job-files-wiring.test.ts`. If the FSUtil replacement's typing rejects a raw layer, build it
     as a `makeGlobalNode`, as `requestExecutor` does (`job-server.ts:114-116`).
6. **Audit fd plumbing in util** (`job-audit-sink.ts`): variable `KETE_JOB_AUDIT_FD` /
   `OPENCODE_JOB_AUDIT_FD` (`Brand.envPrefix`; the bridge renames it, so no new bridge code);
   `parse(env)` → `{kind: "missing"|"invalid"|"fd"}`; `validate(fd, accept: "fifo"|"fifo-or-socket")`
   with `fs.fstatSync`; `set`/`get` write-once; `writer(fd)`; `relay`. Test with real pipes
   (`job-audit-sink.test.ts`).
7. **Audit writer** (`audit.ts`): introduce the storage seam (file = existing code moved behind it,
   with no behaviour change). Add sink storage per section E and N3. Pick the storage in `make`/
   `install` from `KeteJobMode.enabled(process.env)`. Add `audit-sink.test.ts`. Run `audit.test.ts`
   and `audit-service.test.ts` unchanged (AC5).
8. **CLI** (`job-preflight.ts`, `job-serve.ts`, `job-standalone.ts`, `job.ts`, `job-run.ts`):
   section E, then update their tests. For `job-socket.subprocess.test.ts`, use the darwin refusal
   and the Linux fd-4 harness.
9. **Static fs-sites test** (`job-fs-sites.test.ts`): classify each current match:
   - `replaced`: `environment/local.ts`
   - `data-dir`: `kete/audit.ts` (file storage only), `util/process-lock*.ts`
   - `metadata-only`: `filesystem/watcher.ts`
   - `off-in-job`: `persistent-pty/*`, `plugin/module.ts`
   - `not-worktree`: `shell/select.ts`, `server/src/kete/socket-listen.ts`, the database migrations
   - A new unclassified match fails with "classify this file-access site".
10. **Entrypoint** (Go): section E. Run `gofmt`; update the README.
11. **Entrypoint tests:** fakekete, `job_test.go`, `scenarios_test.go` (`TestLifecycle` audit
    equality and no data-dir file; `TestAuditOverLimit`; `TestNoAgent`/empty).
12. **e2e scenario** (`gateway.go` lifecycle; `n` counts tool results):
    - 0 `shell id -un`
    - 1 `edit README.md`
    - 2 `shell "ln -s /var/lib/kete-job/kete/spec.json e2e-read && ln -s /var/lib/kete-job/kete/e2e-written e2e-write"`
    - 3 `read {path: Worktree+"/e2e-read"}` → `checks["symlink_read_refused"]` = the result reports
      an error and contains neither the spec's branch nor the agent slug
    - 4 `write {path: Worktree+"/e2e-write", content: "x"}` → `checks["symlink_write_refused"]` = an
      error
    - 5 `shell "rm e2e-read e2e-write"`, which keeps the bundle free of symlinks (otherwise
      `push_error: symlink`)
    - 6 the final text

    The agent must offer `read` and `write` (assert with `hasTool`). Then `e2e_test.go`/`scan_test.go`
    per the file table.
13. **Docs:** contracts.md §6/§6d, `docs/jobs.md`, the entrypoint and image READMEs, `skill/kete.md`,
    and one line in `docs/upstream-patches.md`.
14. **Run** the verification table, then `bun run --cwd packages/kete-tools upstream:check`
    (expected: no new markers needed) and `verify --base main`.

## Verification
Run the narrowest first. Linux-only TS tests run in CI automatically: `kete-build.yml` runs
`packages/*/test/kete` on ubuntu-latest, x86_64, on a real kernel. Locally (Apple silicon, so arm64,
on Colima) use the AC1 Linux row's `docker run`. It copies the tree into the container without the
macOS `node_modules` and installs the Linux dependencies there. Bun is pinned at 1.4.2 (root
`package.json`); the plain image tests glibc, and `-alpine` tests musl.

| Criterion | Command (narrowest first) |
|---|---|
| AC1 (unit, any OS) | `cd packages/util && bun test ./test/kete/confined-fs.test.ts ./test/kete/job-fs-util.test.ts` · `cd packages/core && bun run test ./test/kete/job-files.test.ts ./test/kete/job-fs-sites.test.ts` |
| AC1 (Linux, real openat2; arm64 locally, x86_64 in CI) | `docker run --rm -v "$PWD:/src:ro" oven/bun:1.4.2 bash -c 'mkdir /w && tar -C /src --exclude=node_modules --exclude=.git --exclude=dist --exclude=.build -cf - . \| tar -C /w -xf - && cd /w && bun install --frozen-lockfile >/dev/null && (cd packages/util && bun test ./test/kete/confined-fs-linux.test.ts) && (cd packages/core && bun run test ./test/kete/job-files-linux.test.ts) && (cd packages/server && bun run test ./test/kete/job-files-wiring.test.ts)'` · musl: the same with `oven/bun:1.4.2-alpine` and only the util test · root case: add `--privileged -e CONFINED_FS_ROOT_TESTS=1` · CI: the PR's `kete-build` "Kete tests" job |
| AC1 + AC4 (real binary in the image) | `(cd packages/cli && bun run build --target=kete-linux-arm64 --skip-web-ui) && bash packages/kete-job-image/scripts/build.sh && bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario lifecycle` · CI x86_64: `gh workflow run kete-job-image.yml --repo kete-org/ketecode --ref feature/job-file-confinement` |
| AC2 | `cd packages/util && bun test ./test/kete/confined-fs.test.ts -t "ENOSYS"` · `cd packages/server && bun run test ./test/kete/job-files-wiring.test.ts -t "refuses to start"` · `cd packages/cli && bun test ./test/kete/job-socket.subprocess.test.ts` (darwin: refusal case) |
| AC3 | `cd packages/util && bun test ./test/kete/job-audit-sink.test.ts` · `cd packages/core && bun run test ./test/kete/audit-sink.test.ts` · `cd packages/cli && bun test ./test/kete/job-preflight.test.ts ./test/kete/job-serve.test.ts ./test/kete/job-standalone.test.ts ./test/kete/job-run.test.ts` · Linux: `job-socket.subprocess.test.ts` through the recipe above |
| AC4 | `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go vet -tags e2e ./... && go test -race ./...'` · `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh` (first `-test.run 'TestLifecycle\|TestAuditOverLimit\|TestNoAgent'`) · e2e: `bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario all` · CI: `gh workflow run kete-job-entrypoint.yml --repo kete-org/ketecode --ref feature/job-file-confinement` |
| AC5 | `cd packages/core && bun run test ./test/kete/audit.test.ts ./test/kete/audit-service.test.ts ./test/environment.test.ts ./test/tool-read.test.ts ./test/tool-write.test.ts ./test/tool-edit.test.ts ./test/tool-patch.test.ts ./test/tool-search.test.ts ./test/file-mutation.test.ts ./test/location-filesystem.test.ts` · `cd packages/server && bun run test ./test/kete/job-mode.test.ts` |
| AC6 | per package `bun run typecheck` (util, core, server, cli) · `bun run test ./test/kete` (core) and `bun test ./test/kete` (util, cli, server) · root `bun run lint` · `bun turbo typecheck` · `bun run --cwd packages/kete-tools upstream:check` · `bun run --cwd packages/kete-tools verify --base main` · the Go and e2e rows above |

Use `node scripts/agent/check-summary.mjs bash -c "cd packages/<pkg> && <command>"` for agent
runs.

## Cards to update after the build
- `job-mode`: confinement (seam, three replacements, root = cwd, fail-closed probe, non-Linux
  refusal), `KETE_JOB_AUDIT_FD` and the relay, new key files, new tests; the replacement list grows
  from 8 to 11 items.
- `audit-log`: storage seam, sink mode, N3 caps in bytes, the "where does the log live" answer for
  jobs, the new test.
- `job-entrypoint`: fd 4 audit pipe, root audit file, reader, `OpenAudit()`, notes (N5), fakekete,
  `TestAuditOverLimit`, `AuditRel` gone.
- `job-image`: lifecycle scenario steps 2–5 and the export-scan assertions.
- `cli`: `kete job run` audit source in job mode (`readAudit`, relay, `audit_failed` on relay
  failure, N2).
- `root-helper`: none (unchanged). `kete-tools-ci`: note that the Linux confinement tests run in the
  existing `kete-build` Kete-tests job.
- `pitfalls.md` (librarian):
  - `O_DIRECTORY`/`O_NOFOLLOW` differ between x86_64 and arm64.
  - FSUtil's derived helpers call the inner FileSystem, so a wrapper must override them.
  - A job-mode `kete serve` can't start on macOS.
- contracts.md §6/§6d (the implementer, step 13).
