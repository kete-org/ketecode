# Plan: File tools open paths without following swapped links

> **Large: security change + two upstream edits** (`core/src/environment/local.ts`, `core/src/formatter.ts`).
> Needs the user's approval of this plan before building. No shared contract, config schema or API change.
> **Two PRs** (estimate ~750 changed lines in total): **PR1** `util` platform layer (no behaviour change),
> **PR2** `core` wiring + tests + docs, based on PR1. Branches: PR1 `fix/file-tools-openat-ffi`,
> PR2 `fix/file-tools-openat` (the worktree's current branch).

**Approval question (decide before building):** on Linux kernels without `openat2` (< 5.6: RHEL/Alma 8,
WSL1, some seccomp'd sandboxes) this plan **fails closed**, so read/write/edit/patch stop working there for
Code sessions too (spec: "fail closed"). Alternative: a per-component `openat(O_NOFOLLOW)` walk fallback
(~+40 lines, same safety). Default in this plan: fail closed, as the spec says.

## Cards read
- docs/context/modules/permissions.md (verified-at 16d806c84b, stale: no)
- docs/context/modules/job-mode.md (verified-at 16d806c84b, stale: no)
- docs/context/INDEX.md, pitfalls.md (verified-open and linux-ffi lines), commands.md, upstream-patches.md
  "Verified open for file tools"

## Design
Reuse `KeteConfinedFs.ops` over a **root of `/`**. The checked real path has no symlinks at check time (macOS
`/var` is already `/private/var`), so it is opened relative to a descriptor of `/` with no symlink allowed in any
component. Linux: the existing `KeteLinuxFfi.linux()` (`openat2` + `RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS`).
macOS: a new `KeteDarwinFfi.darwin()` next to it that returns the **same `KeteLinuxFfi.Syscalls` shape**, so
`confined-fs.ts` runs unchanged on it: `openat2` is emulated with `openat(… | O_NOFOLLOW_ANY)` and errno is
translated to Linux numbers. Directory listing moves behind a new `Syscalls.readdir` (Linux: the `getdents64`
loop; macOS: `fdopendir`/`readdir` on a close-on-exec dup). `verified-open.ts` picks the platform once
(an Effect `Context.Reference` whose default Effect caches per process; tests inject `unsupported`), keeps #100's
identity check, and adds `list`, `remove` and `formattable`. Windows keeps #100 unchanged.

Spike facts (handoff.md), confirmed on macOS 26 arm64 under Bun 1.4.4:
- `O_NOFOLLOW | O_NOFOLLOW_ANY` together → **EINVAL**. Strip `O_NOFOLLOW` when adding `O_NOFOLLOW_ANY`.
- **Apple arm64 passes variadic arguments on the stack.** `openat`'s `mode` and `fcntl`'s 3rd argument must be
  declared after padding x3..x7 / x2..x7 (signatures below); a plain 4-argument `openat` creates files with a
  garbage mode. Padded `openat(…, O_CREAT|O_EXCL, 0o640)` gave mode 640; padded `fcntl(F_DUPFD_CLOEXEC)` worked.
  x86_64 macOS passes them in registers (plain signatures).
- No `O_PATH` on macOS: use `O_EVTONLY|O_NONBLOCK` (0x8004). It opens directories and files and doesn't block on a
  FIFO, but **needs read permission** (a write-only file → EACCES). Works as `dirfd` for `openat`/`mkdirat`/
  `unlinkat`/`renameat`.
- `unlinkat(dirfd, name, 0)` on a directory → EPERM on macOS (EISDIR on Linux): never recursive.
- macOS `struct dirent` (64-bit inode): `d_ino u64 @0, d_seekoff u64 @8, d_reclen u16 @16, d_namlen u16 @18,
  d_type u8 @20, d_name @21` (namlen bytes). DT_* values equal Linux's (REG 8, DIR 4, LNK 10, UNKNOWN 0).
  `readdir` returns `.` and `..` (skip them). `closedir` closes only the dup.
- macOS SDK constants: O_WRONLY 0x1, O_NONBLOCK 0x4, O_NOFOLLOW 0x100, O_CREAT 0x200, O_TRUNC 0x400, O_EXCL 0x800,
  O_EVTONLY 0x8000, O_NOCTTY 0x20000, O_DIRECTORY 0x100000, O_CLOEXEC 0x1000000, O_NOFOLLOW_ANY 0x20000000,
  AT_FDCWD -2, AT_REMOVEDIR 0x80, F_SETFD 2, FD_CLOEXEC 1, F_DUPFD_CLOEXEC 67.
- macOS errno that differ from Linux: EAGAIN 35 (Linux 11), EDEADLK 11, ENOTSUP 45 / EOPNOTSUPP 102 (Linux
  EOPNOTSUPP 95), ELOOP 62 (40), ENAMETOOLONG 63 (36), ENOTEMPTY 66 (39), ENOSYS 78 (38). 1–10 and 12–34 are equal.
- Linux `O_EXCL` is `0o200` on x86_64 and arm64.

## Files
The implementer reads ONLY these.

| File | Read / change | Why |
|---|---|---|
| `packages/util/src/kete/linux-ffi.ts` | change (PR1) | `O_EXCL` in `Flags`/`common`; `Syscalls.readdir`; `readDirents` helper; `linux()` gains `readdir` |
| `packages/util/src/kete/darwin-ffi.ts` | **new** (PR1) | macOS `Syscalls` via libSystem |
| `packages/util/src/kete/confined-fs.ts` | change (PR1) | `readEntries` → `sys.readdir`; `Ops.open`, `Ops.create` |
| `packages/util/test/kete/fixture/fake-syscalls.ts` | change (PR1) | the fake implements `readdir` (one property) |
| `packages/util/test/kete/confined-fs-linux.test.ts` | change (PR1) | add `"O_EXCL"` to the flag-table check (line 47) |
| `packages/util/test/kete/confined-fs.test.ts` | read (PR1) | must stay green (fake readdir path); style for new tests |
| `packages/util/test/kete/darwin-ffi.test.ts` | **new** (PR1) | macOS FFI tests + the pure errno table |
| `packages/core/src/kete/verified-open.ts` | change (PR2) | platform choice, no-follow read/write, `list`, `remove`, `formattable` |
| `packages/core/src/environment/local.ts` | change (PR2, **upstream**) | marked blocks in `list` and `remove` |
| `packages/core/src/formatter.ts` | change (PR2, **upstream**) | one marked line in `file` (line 56) and the import |
| `packages/core/src/environment/files.ts` | read (PR2) | `Failed`, `NotFound`, `WrongKind`, entry types |
| `packages/core/src/kete/job-files.ts` | read (PR2) | pattern for mapping `Outcome` → Environment errors (`lift`) |
| `packages/core/test/kete/verified-open.test.ts` | read (PR2) | the #100 cases must pass **unchanged**; reuse its `checked()` helper style |
| `packages/core/test/kete/file-tools-verified-open.test.ts` | read (PR2) | must pass unchanged |
| `packages/core/test/kete/verified-open-nofollow.test.ts` | **new** (PR2) | AC1–AC3 |
| `packages/core/test/kete/job-fs-sites.test.ts` | change if it fails (PR2) | line 62 reason: verified-open is now also called from `formatter.ts`; add a `darwin-ffi.ts` entry only if the test asks |
| `docs/upstream-patches.md` | change (PR2) | section "Verified open for file tools" (line 1921): rows for `local.ts` list/remove and `formatter.ts` |
| `docs/tasks/2026-11-05-file-tools-verify-open/result.md` | change (PR2) | mark the "Known residual" list (line 36) closed, link this task |

Not changed (checked): `tool/plugin/*.ts` already wrap `KeteVerifiedOpen.scoped`; `file-access.ts` already
records every checked path (folders too); `files.move`/`files.mkdir` are never called by the file tools (patch
"move" = `write(to)` + `remove(from)`, `patch.ts:249-256`), so they stay upstream; job mode never records.

## Steps

### PR1: util platform layer (no behaviour change)

1. **`linux-ffi.ts`**
   - `Flags`: add `readonly O_EXCL: number`; `common`: `O_EXCL: 0o200`.
   - `Syscalls`: add `/** Every entry of an open directory, read to its end (`.` and `..` skipped). */
     readonly readdir: (fd: number) => Result<Dirent[]>`. Keep `getdents64`.
   - New export (move `DIRENT_BUFFER_BYTES = 64 * 1024` here from confined-fs):
     `export function readDirents(getdents64: (buffer: Uint8Array) => Result<number>): Result<Dirent[]>`: the
     loop now in `confined-fs.ts` `readEntries` (`:192-201`): `0` → done, an error → return it, else `parseDirents`.
   - In `linux()`: hoist the `getdents64` arrow into a `const`, use it for `getdents64` and add
     `readdir: (fd) => readDirents((buffer) => getdents64(fd, buffer))`.
2. **`confined-fs.ts`**
   - `readEntries(root, fd)` becomes `const r = root.sys.readdir(fd); return r.ok ? ok(r.value) : fromErrno(r.errno)`;
     delete the local `DIRENT_BUFFER_BYTES`.
   - `Ops` gains (doc comments say the caller closes the descriptor):
     - `open: (value: string, flags: number, mode?: number) => Outcome<number>` = `inside(root, value)` then
       `openAt(root, root.fd, rel, flags, mode)`.
     - `create: (value: string, mode: number) => Outcome<number>` = `inside`; `"."` → `failed("EISDIR")`;
       `parentAndName`; `mkdirp(parent)`; then `withFdSync(sys, dir, (dirfd) => openAt(root, dirfd, name,
       F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOCTTY | F.O_NONBLOCK, mode))`. An existing file gives
       `failed("EEXIST")` (through `fromErrno`); `missing` → `failed("ENOENT")` as `write` does.
   - Header comment: the module also backs the local file tools (root `/`, `core/src/kete/verified-open.ts`) and
     runs on macOS through `darwin-ffi.ts`. `open()` (job mode's start) stays Linux-only and unchanged.
3. **`fake-syscalls.ts`**: add `readdir: (fd) => KeteLinuxFfi.readDirents((buffer) => sys.getdents64(fd, buffer))`
   to the `sys` object (the lazy self-reference is fine).
4. **`darwin-ffi.ts`** (new, `export * as KeteDarwinFfi from "./darwin-ffi.js"`; a header comment like
   linux-ffi's explaining each workaround). Exports:
   - `flags: KeteLinuxFfi.Flags` = `{ O_RDONLY: 0, O_WRONLY: 0x1, O_CREAT: 0x200, O_EXCL: 0x800, O_NOCTTY: 0x20000,
     O_TRUNC: 0x400, O_NONBLOCK: 0x4, O_DIRECTORY: 0x100000, O_NOFOLLOW: 0x100, O_CLOEXEC: 0x1000000,
     O_PATH: 0x8000 | 0x4 }` (comment: O_EVTONLY|O_NONBLOCK, needs read permission, never blocks on a FIFO).
   - `O_NOFOLLOW_ANY = 0x20000000`, `AT_FDCWD = -2`, `AT_REMOVEDIR = 0x80`, `F_SETFD = 2`, `FD_CLOEXEC = 1`,
     `F_DUPFD_CLOEXEC = 67`.
   - `errnoToLinux(value: number): number`: 1–10 and 12–34 unchanged; 35→11, 45→95, 102→95, 62→40, 63→36,
     66→39, 78→38; anything else (including 11, EDEADLK) → 5 (EIO).
   - `darwin(platform = process.platform, archName = process.arch): KeteLinuxFfi.Linux`:
     not `"darwin"` → `{ unsupported: \`not macOS (${platform})\` }`; `KeteLinuxFfi.arch(archName)` undefined →
     unsupported; `typeof Bun === "undefined"` → `{ unsupported: "needs the Bun runtime" }`; then lazy
     `require("bun:ffi")` and `dlopen("/usr/lib/libSystem.B.dylib", …)` in try/catch (→ unsupported
     "could not load libSystem: …"). Two literal symbol tables picked by arch, wrapped into plain closures
     (`openat(d, p, f, m)`, `fcntl(fd, cmd, arg)`, `fdopendir`, `readdir`) so the rest is arch-free:
     - arm64: `openat: { args: ["i32","ptr","i32","i64","i64","i64","i64","i64","i64"], returns: "i32" }`
       called `openat(d, p, f, 0, 0, 0, 0, 0, m)`;
       `fcntl: { args: ["i32","i32","i64","i64","i64","i64","i64","i64","i64"], returns: "i32" }`
       called `fcntl(fd, cmd, 0, 0, 0, 0, 0, 0, arg)`; `fdopendir: { args: ["i32"], returns: "ptr" }`;
       `readdir: { args: ["ptr"], returns: "ptr" }`.
     - x64: `openat: ["i32","ptr","i32","i32"]`, `fcntl: ["i32","i32","i32"]`, and the 64-bit-inode symbols
       **`"fdopendir$INODE64"`** and **`"readdir$INODE64"`** (SDK `dirent.h`: `__DARWIN_ALIAS_I`/`__DARWIN_INODE64`).
     - both: `mkdirat: ["i32","ptr","u16"]→i32`, `unlinkat: ["i32","ptr","i32"]→i32`,
       `renameat: ["i32","ptr","i32","ptr"]→i32`, `closedir: ["ptr"]→i32`, `__error: []→ptr`.
     - `lastErrno = () => errnoToLinux(read.i32(__error(), 0))` (EIO for a null pointer), read in the same
       synchronous turn as the failing call.
     The returned `Syscalls`:
     - `flags`.
     - `openat2(dirfd, path, flags, mode, resolve)`: no `RESOLVE_NO_SYMLINKS` bit → `{ok:false, errno: EINVAL}`;
       `RESOLVE_BENEATH` set and (`path` starts with `/` or a `/`-split segment is `..`) → `EXDEV`; else
       `openat(dirfd, cstr(path), (flags & ~0x100) | O_NOFOLLOW_ANY, mode)`; `< 0` → `lastErrno()`.
       Comment: a final symlink is refused (ELOOP) even with O_NOFOLLOW, unlike Linux's O_PATH|O_NOFOLLOW.
     - `getdents64`: `() => ({ ok: false, errno: KeteLinuxFfi.errno.ENOSYS })` (macOS lists through `readdir`).
     - `readdir(fd)`: `dup = fcntl(fd, F_DUPFD_CLOEXEC, 0)` (failure → errno); `dir = fdopendir(dup)`; null →
       read errno, `KeteLinuxFfi.nodeFdIo.close(dup)`, fail. Then inside `try/finally closedir(dir)`: an
       `Int32Array(toArrayBuffer(__error(), 0, 4))`; loop: set it to 0, `entry = readdir(dir)`; null → if the
       errno cell ≠ 0 return `{ok:false, errno: errnoToLinux(cell)}`, else stop; otherwise
       `name = new TextDecoder().decode(toArrayBuffer(entry, 21, read.u16(entry, 18)))`, `type = read.u8(entry, 20)`,
       skip `.`/`..`, push `{ name, type }`.
     - `mkdirat`, `unlinkat`, `renameat`: as in linux-ffi (`status`), errno through `lastErrno`.
     - `setCloexec: (fd) => status(fcntl(fd, F_SETFD, FD_CLOEXEC))`.
     - `fstat`, `pread`, `writeAll`, `close`: `KeteLinuxFfi.nodeFdIo.*`.
5. **Tests (PR1)**
   - `confined-fs-linux.test.ts:47`: add `"O_EXCL"` to the list.
   - `darwin-ffi.test.ts` (new). On every platform: the `errnoToLinux` table (62→40, 35→11, 66→39, 78→38, 63→36,
     45→95, 102→95, 2→2, 11→5, 999→5); `darwin("linux")` is `{unsupported}`.
     `describe.skipIf(process.platform !== "darwin")`, temp dirs via `fs.realpath(fs.mkdtemp(os.tmpdir()…))`
     cleaned in `afterEach`; root = `sys.openat2(KeteDarwinFfi.AT_FDCWD, "/", F.O_PATH | F.O_DIRECTORY | F.O_CLOEXEC, 0, RESOLVE_NO_SYMLINKS)`
     and `ops = KeteConfinedFs.ops({ lexical: "/", real: "/", fd, sys })`:
     - the flag table equals `fs.constants` for O_DIRECTORY, O_NOFOLLOW, O_CREAT, O_EXCL, O_TRUNC, O_NOCTTY, O_NONBLOCK, O_WRONLY;
     - `ops.create(file, 0o640)` → file mode `& 0o777` equals `0o640 & ~process.umask()` (proves the padded `mode`);
     - `ops.open(file, F.O_PATH | F.O_NOFOLLOW)` succeeds (the EINVAL regression);
     - a parent folder swapped for a symlink to an outside folder → `ops.open` and `ops.create` are `refused` and
       the outside folder stays empty;
     - `ops.list(dir)` returns file/directory/symlink kinds without `.`/`..`; the directory fd still `fstat`s
       after `sys.readdir`;
     - a FIFO (`Bun.spawnSync(["/usr/bin/mkfifo", p])`) opened with `F.O_PATH` returns without blocking;
     - `sys.unlinkat(dirfd, "<folder>", 0)` fails and the folder remains.

### PR2: core wiring

6. **`verified-open.ts`**
   - Imports: `KeteLinuxFfi`, `KeteDarwinFfi`, `KeteConfinedFs` (`@opencode/util/kete/...`), `WrongKind`,
     `promisify` and the callback `node:fs` functions for descriptor I/O (`fstat` with `{ bigint: true }`, `read`,
     `ftruncate`, `write`, `readFile` on an fd).
   - `export type Platform = { kind: "nofollow"; root: KeteConfinedFs.Root; ops: KeteConfinedFs.Ops } |
     { kind: "identity" } | { kind: "unsupported"; reason: string }`.
   - `export function load(platform = process.platform, arch = process.arch): Platform`: `win32` → identity;
     `darwin` → `KeteDarwinFfi.darwin`, `linux` → `KeteLinuxFfi.linux`, anything else → unsupported
     `` `no-follow file access is not available on ${platform}` ``; `{unsupported}` from either → unsupported.
     Open the root: `sys.openat2(darwin ? KeteDarwinFfi.AT_FDCWD : KeteLinuxFfi.AT_FDCWD, "/", F.O_PATH |
     F.O_DIRECTORY | F.O_CLOEXEC, 0, RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)` (failure → unsupported with
     `errnoName`; on Linux ENOSYS means kernel < 5.6). **macOS probe**: `sys.openat2(AT_FDCWD, "/var", F.O_PATH |
     F.O_DIRECTORY, 0, RESOLVE_NO_SYMLINKS)` must fail with errno 40 (`/var` is a system symlink); success (close
     it) or another errno → unsupported "O_NOFOLLOW_ANY is not honoured". Root = `{ lexical: "/", real: "/", fd, sys }`,
     held for the process's life (comment why, like job mode's `Root.fd`); `ops = KeteConfinedFs.ops(root)`.
   - `export const CurrentPlatform = Context.Reference<Platform>("@kete/VerifiedOpen/Platform", { defaultValue: () => load() })`
     (Effect caches a Reference's default once per process; tests `Effect.provideService` it).
   - Extract the `ChangedError` branch of `run` into `changed(value, entry, cause)` (sets `registry.changed`,
     logs the warning, fails `Failed`); `run` calls it. Add `unsupported(value, reason)` = `Failed` with cause
     `new Error(\`Kete Code can't open ${value} without following symbolic links here (${reason}); refused.\`)`.
   - Refactor `verify(handle, …)` into `verify(opened: BigIntStats, value, entry)`; the legacy path passes
     `await handle.stat({ bigint: true })`. Logic unchanged; keep the realpath fallback for a file with no
     recorded id (`verified-open.test.ts:125` depends on it).
   - `read` / `write`: switch on `yield* CurrentPlatform`. `identity` → today's bodies unchanged;
     `unsupported` → `unsupported(...)`; `nofollow` → new bodies through `run`:
     - guard: `!path.isAbsolute(entry.real)` → `ChangedError` (covers `UNRESOLVED` and `{ real: "never" }`).
     - Outcome failures are thrown: `missing` → `Object.assign(new Error("ENOENT"), { code: "ENOENT" })`;
       `refused` → `ChangedError(…, "a symbolic link is in the way")`; `wrongKind` →
       `ChangedError(…, "it is not a regular file")`; `failed` → `Object.assign(new Error(reason), { code: reason })`.
     - read: `ops.open(entry.real, F.O_RDONLY | F.O_NOCTTY | F.O_NONBLOCK)`; in try/finally `sys.close(fd)`:
       `verify(await fstat(fd, { bigint: true }), …)`; whole → `readFile(fd)`; ranged →
       `read(fd, buffer, 0, length, offset)`; same `info` shape as today.
     - write: `ops.open(entry.real, F.O_WRONLY | F.O_NOCTTY | F.O_NONBLOCK)`; `missing` with `entry.id` set →
       `ChangedError(…, "the checked file is gone")`; `missing` otherwise → `ops.create(entry.real, 0o666)`, where
       `failed("EEXIST")` → `ChangedError(…, "it appeared while it was being created")`, and `created = true`.
       In try/finally close: `verify`; when it fails and `created`, discard: `ops.open(entry.real, F.O_PATH |
       F.O_NOFOLLOW)` with the same dev/ino as ours → `ops.open(dirname, F.O_PATH | F.O_DIRECTORY)` +
       `sys.unlinkat(dirfd, basename, 0)` (errors ignored, as #100's `discard` does). Then `ftruncate(fd, 0)` and a
       write loop at explicit positions. Nothing is truncated before `verify`; an overwrite keeps the mode.
   - `export const list = (value, entry)`: `Effect<entries | undefined, NotFound | WrongKind | Failed>`;
     identity → `undefined`; unsupported → fail; non-absolute real → `changed`; `ops.list(entry.real)` mapped:
     ok → entries; missing → `NotFound`; wrongKind → `WrongKind`; refused → `changed`; failed → `Failed`.
   - `export const remove = (value, entry)`: `Effect<boolean, Failed>` (true = handled); identity → false;
     unsupported → fail; `fs.lstat(value)` is a symlink → `Failed` "refused to delete a symbolic link: <value>"
     (the checked real path is the link's target, not the link); else through `run`: `ops.open(dirname(real),
     F.O_PATH | F.O_DIRECTORY)` (`missing` → true, nothing to delete; `refused` → `ChangedError`), then
     `sys.unlinkat(dirfd, basename(real), 0)` (ok or ENOENT → true; else `Failed` with `errnoName`, so a folder
     fails here and is never deleted recursively); close `dirfd` in finally.
   - `export const formattable = (value)`: `Effect<boolean>`; not registered → true; identity → true;
     unsupported or non-absolute real → `logWarning` + false; else `ops.stat(entry.real)` ok with `type ===
     "file"` → true, otherwise a warning + false. Comment: `shortcut: a swap between this check and the
     formatter's own open is not covered; disable formatting in Work sessions if the security review asks.`
   - Update the header comment (no longer "no POSIX-only flag"; Windows keeps the identity check only).
7. **`environment/local.ts`** (upstream; each block marked):
   - `list`: after the `WrongKind` line (`:52`):
     `// kete_change start: a checked folder is listed without following a swapped link (kete/verified-open.ts)`,
     `const checked = yield* KeteVerifiedOpen.expected(value)`,
     `const listed = checked === undefined ? undefined : yield* KeteVerifiedOpen.list(value, checked)`,
     `if (listed !== undefined) return listed`, `// kete_change end`.
   - `remove` (`:67`): replace the one-liner with a marked `Effect.gen` that returns early when
     `checked !== undefined && (yield* KeteVerifiedOpen.remove(value, checked))`, else runs the original
     `attempt(value, () => fs.rm(value, { recursive: true, force: true }))` unchanged.
8. **`formatter.ts`** (upstream): first line inside `Formatter.file` (`:56`):
   `if (!(yield* KeteVerifiedOpen.formattable(filepath))) return false // kete_change: a checked file is formatted only if it still opens without a link (kete/verified-open.ts)`,
   plus the import marked `// kete_change`.
9. **`verified-open-nofollow.test.ts`** (new; `describe.skipIf(process.platform === "win32")`; temp dirs as in
   `verified-open.test.ts`; entries from the same `checked()` helper; an `outside` dir with a `secret` file):
   - AC1 (each refused as `Environment.Failed`, and `outside` unchanged: its entries listed and `secret` read):
     create a new file under a parent swapped for a symlink to `outside`; create with missing parents
     (`a/b/c/new.txt`, `a` swapped); write an existing file whose parent is swapped; `remove` with the parent
     swapped; move = `write(to)` and `remove(from)`, each side's parent swapped in turn; `list` of a swapped folder.
   - Wiring: `EnvironmentLocal.makeLocalDriver(undefined as never /* the file methods never spawn */).overrides`
     `list` and `remove`, run inside `Effect.provideService(KeteVerifiedOpen.Expected, registry)` with a recorded
     entry and a swapped folder → `Environment.Failed`; without a registry entry they behave as upstream.
   - `formattable`: unchanged file → true; parent swapped → false; unregistered → true.
   - AC2: create with new parents; overwrite keeps mode 0o640; read whole and ranged; remove a file; remove a
     folder → `Failed` and the folder still exists; move (write + remove); list returns names and kinds; a value
     through a symlinked folder (`root/link → root/real`, entry.real = `root/real/f`) reads and writes; on macOS
     also an un-realpathed `os.tmpdir()` value with its realpath as entry.real.
   - AC3: `Effect.provideService(KeteVerifiedOpen.CurrentPlatform, { kind: "unsupported", reason: "test" })` →
     read, write, list and remove fail `Environment.Failed` whose cause message contains
     "without following symbolic links", and nothing is written; `formattable` → false;
     `KeteVerifiedOpen.load("sunos")` is `unsupported`.
10. **`job-fs-sites.test.ts`**: run it; update line 62's reason to mention `formatter.ts`; add entries only if
    it reports an unclassified site.
11. **Docs**: `docs/upstream-patches.md` section at line 1921: add fix/file-tools-openat to the summary, describe
    no-follow I/O (root `/`, openat2 / O_NOFOLLOW_ANY, Windows identity only, fail closed), add rows for
    `core/src/environment/local.ts` (also `list`, `remove`) and `core/src/formatter.ts` (one line; the formatter
    runs by path and has no hook before it); sync checklist: route any new `Files` method the tools call. In
    #100's `result.md`, mark each "Known residual" line closed by this task.

## Verification
First: `bun install` at the worktree root (`/Users/magbotta/Development/kete-code-openat` has no `node_modules`).
Linux: CI `kete-build` runs `util` and `core` `test/kete` on Linux; or locally from the worktree root:
`docker run --rm -v "$PWD":/src:ro oven/bun:1.4.4 sh -c 'mkdir /w && tar -C /src --exclude=node_modules --exclude=.git -cf - . | tar -C /w -xf - && cd /w && bun install && cd packages/util && bun test ./test/kete/confined-fs-linux.test.ts && cd ../core && bun run test ./test/kete/verified-open-nofollow.test.ts'`.

| Criterion | Command (narrowest first) |
|---|---|
| PR1 | `packages/util`: `bun test ./test/kete/darwin-ffi.test.ts`, then `bun test ./test/kete/confined-fs.test.ts`, then `bun test ./test/kete`, then `bun run typecheck`; Linux: `bun test ./test/kete/confined-fs-linux.test.ts` (Docker above or CI) |
| AC1 | `packages/core`: `bun run test ./test/kete/verified-open-nofollow.test.ts` on macOS **and** Linux (Docker above or CI) |
| AC2 | `packages/core`: `bun run test ./test/kete/verified-open-nofollow.test.ts`, then `bun run test ./test/kete/verified-open.test.ts ./test/kete/file-tools-verified-open.test.ts` (the unchanged #100 tests) |
| AC3 | `packages/core`: `bun run test ./test/kete/verified-open-nofollow.test.ts -t unsupported` |
| AC4 | `packages/core`: `bun run test ./test/kete/job-fs-sites.test.ts`, `bun run test ./test/kete`, `bun run typecheck`; `packages/util`: `bun run typecheck`; root: `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`; CI green on both PRs; security review (security-review skill + reviewer) with no open high or medium finding |

Also time `bun run test ./test/kete/verified-open.test.ts` (core) before and after, for the spec's "no
noticeable slowdown" note in result.md.

## Cards to update after the build
- `permissions`: Quick answers "Known residual of Work mode?" and "Do file tools re-check the path…" (no-follow
  I/O, root `/`, list/remove/formatter covered, Windows identity only, fail closed and its message, the
  `CurrentPlatform` test seam); `paths` add `core/src/formatter.ts`.
- `job-mode`: the "linux-ffi / job-files" answer: `Syscalls.readdir` + `readDirents`, `O_EXCL`, `Ops.open`/
  `Ops.create`, `darwin-ffi.ts` as the macOS `Syscalls`; `paths` add `util/src/kete/darwin-ffi.ts`.
- `pitfalls.md`: Apple arm64 puts variadic FFI arguments on the stack (pad); `O_NOFOLLOW|O_NOFOLLOW_ANY` is EINVAL;
  macOS has no `O_PATH` (`O_EVTONLY` needs read permission); x64 macOS needs the `$INODE64` dirent symbols.

## Risks
- **Linux < 5.6, WSL1, Node runtime**: the file tools refuse (fail closed); see the approval question at the top.
  Upstream's Node SEA build (not shipped by Kete) would also refuse (no `bun:ffi`).
- **x86_64 macOS is untested** (`$INODE64` symbols, register-passed variadics), and no CI job runs Kete tests on
  macOS, so macOS evidence for AC1 is a local run only. Get an Intel Mac (or Rosetta + x64 Bun) run before release.
- macOS: creating files under, or listing, a folder the user can traverse but not read now fails (EACCES) where
  it used to work; `ops.stat` refuses a final symlink. Both fail closed.
- Formatter: the check-then-spawn residual (step 6 comment). Hard links planted before the check stay out of scope.
- Pre-existing, not fixed here: `linux-ffi.ts` `setCloexec`'s macOS branch calls variadic `fcntl` unpadded, so on
  Apple arm64 its `FD_CLOEXEC` argument is read from the stack (works by luck). Fix separately with `KeteDarwinFfi`.
