# Handoff: File tools open paths without following swapped links

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## Main session: spikes (2026-11-05)
- macOS SDK (`sys/fcntl.h`): O_NOFOLLOW 0x100, O_CREAT 0x200, O_EXCL 0x800, O_DIRECTORY 0x100000, O_CLOEXEC 0x1000000,
  O_NOFOLLOW_ANY 0x20000000, AT_FDCWD -2, AT_REMOVEDIR 0x80. ELOOP is 62 on macOS.
- `bun:ffi` `dlopen("/usr/lib/libSystem.B.dylib")` with `openat(i32, ptr, i32, i32) -> i32` and `__error() -> ptr`
  (errno via `read.i32`): `openat(AT_FDCWD, "<real>/f", O_RDONLY|O_NOFOLLOW_ANY)` opened; the same file through a
  symlinked parent folder returned -1 with errno 62 (ELOOP). So one openat call refuses a link in any component.

## 2026-11-05 planner
- Done: plan.md (two PRs: util platform layer, then core wiring). Cards permissions and job-mode current.
- More spikes (macOS 26 arm64, Bun 1.4.4; scripts were in the planner's scratchpad, not committed):
  - `O_NOFOLLOW | O_NOFOLLOW_ANY` → EINVAL (22). The macOS shim must strip O_NOFOLLOW.
  - Variadic args go on the stack on Apple arm64: `openat` declared `["i32","ptr","i32", 5×"i64", "i64" mode]` created
    a file with mode 640 as asked; `fcntl` declared `["i32","i32", 6×"i64", "i64" arg]` did F_SETFD/F_DUPFD_CLOEXEC (67).
  - `O_EVTONLY|O_NONBLOCK` (0x8004) works as an O_PATH stand-in (dirs, files, a FIFO without blocking) but a write-only
    file gives EACCES. EVTONLY dirfds work for openat/mkdirat/unlinkat/renameat.
  - `unlinkat(dir, "<folder>", 0)` → EPERM (1). `fdopendir(dup)`/`readdir`/`closedir` list `.`, `..` and entries with
    DT types 4/8/10 at `d_namlen u16 @18, d_type u8 @20, d_name @21`; the original fd survives `closedir`.
- Decisions: root `/` + `KeteConfinedFs.ops` for both OSes; `KeteDarwinFfi.darwin()` returns the existing `Syscalls`
  shape; new `Syscalls.readdir`; `Ops.open`/`Ops.create`; files.move/mkdir not routed (tools never call them);
  formatter = no-follow check before it runs (smaller option; residual noted); remove = `unlinkat(…, 0)`, refuses a
  folder and a path that is itself a symlink.
- Open question for the user (top of plan.md): fail closed on Linux without openat2 (RHEL 8, WSL1) vs a per-component
  O_NOFOLLOW walk fallback.
- Docs enough: no — missing: (1) that the file tools never call `files.move`/`files.mkdir` (patch move = write + remove,
  `patch.ts:249-256`); (2) that `Formatter.file` runs inside the tool's `KeteVerifiedOpen.scoped` registry
  (`formatter.ts:56`); (3) that an Effect `Context.Reference` default is computed once and cached
  (`effect/dist/Context.js` `defaultValueCacheKey`); (4) which test classifies `verified-open.ts` for job mode
  (`core/test/kete/job-fs-sites.test.ts:62`); (5) that `verified-open.test.ts:125` relies on #100's realpath fallback.
- Noticed, not fixed: `linux-ffi.ts` `setCloexec` macOS branch calls variadic `fcntl` unpadded (wrong on Apple arm64).

## Main session: decisions (2026-11-05)
- Linux without `openat2` (RHEL 8, WSL1): use the per-component no-follow fallback (openat with O_NOFOLLOW|O_DIRECTORY
  on each component from `/`, then the leaf with O_NOFOLLOW), not refusal — Code must keep working there. Refuse only
  when neither path is available (FFI missing).
- Fix the `setCloexec` macOS fcntl padding bug in PR1 if it is in a file PR1 already touches; otherwise note it.
- Two PRs as planned: PR1 util platform layer (no behaviour change), PR2 wiring + tests + docs.

## Implementer: PR1 review fixes (2026-11-05)

Done (no shell, nothing run):
- linux-ffi.ts `emulateOpenat2`: absolute path without BENEATH walks from an fd for "/" (openat AT_FDCWD, O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); "/" alone opens "." under that root fd. Intermediates are O_PATH|O_NOFOLLOW, then a new `kind(fd)` dep (fstatSync in `linux()`): symlink -> ELOOP, non-dir -> ENOTDIR. Leaf unchanged. Comments: trailing slash is not enforced as a directory; fixed-arity openat binding is safe on x86_64/arm64.
- New exported `shouldEmulate(errno, fallback)`: ENOSYS or EPERM (old Docker seccomp) with fallback=true; `linux()` uses it. fallback=false unchanged.
- darwin-ffi.ts: Buffers passed directly as ptr args (openat, mkdirat, unlinkat, renameat); O_PATH stand-in gains O_NOCTTY (0x20000).
- Tests: new packages/util/test/kete/linux-ffi.test.ts (emulation + shouldEmulate); emulation tests removed from darwin-ffi.test.ts.
- paths: darwin-ffi.ts added to modules/job-mode.md and permissions.md.
Decision: wiring tested through the `shouldEmulate` seam, not an injected binding in `linux()`.
Open: the real-libc path (`linux()` with a live seccomp EPERM) is untested.
