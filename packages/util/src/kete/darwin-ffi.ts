// macOS syscalls for the confined file layer, in the shape of linux-ffi.ts's `Syscalls` so
// confined-fs.ts runs unchanged on them (file tools: no symlink in any component of a checked path).
//
// `openat2` is emulated with `openat(… | O_NOFOLLOW_ANY)`, which refuses a symlink in any component
// (ELOOP). Workarounds, each found by a spike on macOS 26 arm64 under Bun 1.4.4:
// - O_NOFOLLOW together with O_NOFOLLOW_ANY is EINVAL, so O_NOFOLLOW is stripped.
// - Apple arm64 passes variadic arguments on the stack: `openat`'s `mode` and `fcntl`'s third argument
//   are declared after padding the unused registers (x86_64 passes them in registers).
// - There is no O_PATH: O_EVTONLY|O_NONBLOCK opens directories and files without blocking on a FIFO,
//   but needs read permission.
// - `unlinkat(dir, name, 0)` on a directory is EPERM (never recursive).
// - Directories are listed through `fdopendir`/`readdir` on a close-on-exec dup; x86_64 needs the
//   64-bit-inode symbols (`$INODE64`).
// - errno numbers differ from Linux's; `errnoToLinux` translates them so confined-fs.ts's table works.
//
// libSystem is reached through `bun:ffi`, loaded lazily; nothing runs at import.

export * as KeteDarwinFfi from "./darwin-ffi.js"

import { KeteLinuxFfi } from "./linux-ffi.js"

export const flags: KeteLinuxFfi.Flags = {
  O_RDONLY: 0,
  O_WRONLY: 0x1,
  O_CREAT: 0x200,
  O_EXCL: 0x800,
  O_NOCTTY: 0x20000,
  O_TRUNC: 0x400,
  O_NONBLOCK: 0x4,
  O_DIRECTORY: 0x100000,
  O_NOFOLLOW: 0x100,
  O_CLOEXEC: 0x1000000,
  // O_EVTONLY | O_NONBLOCK: needs read permission, never blocks on a FIFO.
  O_PATH: 0x8000 | 0x4 | 0x20000, // + O_NOCTTY
}

export const O_NOFOLLOW_ANY = 0x20000000
export const AT_FDCWD = -2
export const AT_REMOVEDIR = 0x80
export const F_SETFD = 2
export const FD_CLOEXEC = 1
export const F_DUPFD_CLOEXEC = 67

type Ptr = import("bun:ffi").Pointer

const EIO = KeteLinuxFfi.errno.EIO
const differing = new Map<number, number>([
  [35, 11], // EAGAIN
  [45, 95], // ENOTSUP
  [102, 95], // EOPNOTSUPP
  [62, 40], // ELOOP
  [63, 36], // ENAMETOOLONG
  [66, 39], // ENOTEMPTY
  [78, 38], // ENOSYS
])

/** A macOS errno as Linux's number: 1-10 and 12-34 are equal, the known differing ones map, the rest is EIO. */
export function errnoToLinux(value: number): number {
  if ((value >= 1 && value <= 10) || (value >= 12 && value <= 34)) return value
  return differing.get(value) ?? EIO
}

/** The macOS syscalls through libSystem, or why they're unavailable. */
export function darwin(platform: NodeJS.Platform = process.platform, archName: string = process.arch): KeteLinuxFfi.Linux {
  if (platform !== "darwin") return { unsupported: `not macOS (${platform})` }
  const key = KeteLinuxFfi.arch(archName)
  if (key === undefined) return { unsupported: `unsupported architecture (${archName})` }
  if (typeof Bun === "undefined") return { unsupported: "needs the Bun runtime" }
  let ffi: typeof import("bun:ffi")
  // Loosely typed: the symbol tables differ by architecture.
  let symbols: Record<string, (...args: unknown[]) => unknown>
  const arm = key === "arm64"
  const I = "i32" as const
  const L = "i64" as const
  const P = "ptr" as const
  try {
    // Lazy, so the Node build still bundles.
    ffi = require("bun:ffi") as typeof import("bun:ffi")
    symbols = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      openat: { args: arm ? [I, P, I, L, L, L, L, L, L] : [I, P, I, I], returns: I },
      fcntl: { args: arm ? [I, I, L, L, L, L, L, L, L] : [I, I, I], returns: I },
      [arm ? "fdopendir" : "fdopendir$INODE64"]: { args: [I], returns: P },
      [arm ? "readdir" : "readdir$INODE64"]: { args: [P], returns: P },
      closedir: { args: [P], returns: I },
      mkdirat: { args: [I, P, "u16"], returns: I },
      unlinkat: { args: [I, P, I], returns: I },
      renameat: { args: [I, P, I, P], returns: I },
      __error: { args: [], returns: P },
    }).symbols as unknown as typeof symbols
  } catch (error) {
    return { unsupported: `could not load libSystem: ${error instanceof Error ? error.message : String(error)}` }
  }
  const call = <A>(name: string, ...args: unknown[]) => symbols[name]!(...args) as A
  const cstr = (value: string) => Buffer.from(value + "\0", "utf8")
  const errnoPointer = () => call<Ptr | null>("__error")
  // errno is read in the same synchronous turn as the failing call.
  const lastErrno = () => {
    const pointer = errnoPointer()
    return pointer === null ? EIO : errnoToLinux(ffi.read.i32(pointer, 0))
  }
  const status = (result: number): KeteLinuxFfi.Result<void> =>
    result === -1 ? { ok: false, errno: lastErrno() } : { ok: true, value: undefined }
  const openat = (dirfd: number, path: Buffer, openFlags: number, mode: number) =>
    arm ? call<number>("openat", dirfd, path, openFlags, 0, 0, 0, 0, 0, mode) : call<number>("openat", dirfd, path, openFlags, mode)
  const fcntl = (fd: number, cmd: number, arg: number) =>
    arm ? call<number>("fcntl", fd, cmd, 0, 0, 0, 0, 0, 0, arg) : call<number>("fcntl", fd, cmd, arg)
  const fdopendir = arm ? "fdopendir" : "fdopendir$INODE64"
  const readdirName = arm ? "readdir" : "readdir$INODE64"

  return {
    flags,
    openat2: (dirfd, path, openFlags, mode, resolve) => {
      if ((resolve & KeteLinuxFfi.RESOLVE_NO_SYMLINKS) === 0) return { ok: false, errno: KeteLinuxFfi.errno.EINVAL }
      if ((resolve & KeteLinuxFfi.RESOLVE_BENEATH) !== 0 && (path.startsWith("/") || path.split("/").includes("..")))
        return { ok: false, errno: KeteLinuxFfi.errno.EXDEV }
      // A final symlink is refused (ELOOP) even with O_NOFOLLOW, unlike Linux's O_PATH|O_NOFOLLOW.
      const result = openat(dirfd, cstr(path), (openFlags & ~flags.O_NOFOLLOW) | O_NOFOLLOW_ANY, mode)
      return result < 0 ? { ok: false, errno: lastErrno() } : { ok: true, value: result }
    },
    getdents64: () => ({ ok: false, errno: KeteLinuxFfi.errno.ENOSYS }),
    readdir: (fd) => {
      const dup = fcntl(fd, F_DUPFD_CLOEXEC, 0)
      if (dup < 0) return { ok: false, errno: lastErrno() }
      const dir = call<Ptr | null>(fdopendir, dup)
      if (dir === null) {
        const failure = lastErrno()
        KeteLinuxFfi.nodeFdIo.close(dup)
        return { ok: false, errno: failure }
      }
      try {
        const cell = errnoPointer()
        if (cell === null) return { ok: false, errno: EIO }
        const code = new Int32Array(ffi.toArrayBuffer(cell, 0, 4))
        const decoder = new TextDecoder()
        const out: KeteLinuxFfi.Dirent[] = []
        for (;;) {
          code[0] = 0
          const entry = call<Ptr | null>(readdirName, dir)
          if (entry === null) return code[0] !== 0 ? { ok: false, errno: errnoToLinux(code[0]!) } : { ok: true, value: out }
          const name = decoder.decode(new Uint8Array(ffi.toArrayBuffer(entry, 21, ffi.read.u16(entry, 18))))
          if (name !== "." && name !== "..") out.push({ name, type: ffi.read.u8(entry, 20) })
        }
      } finally {
        call("closedir", dir)
      }
    },
    // Buffers go in as the pointer arguments themselves (as linux-ffi.ts does), so they live for the call.
    mkdirat: (dirfd, name, mode) => status(call<number>("mkdirat", dirfd, cstr(name), mode)),
    unlinkat: (dirfd, name, unlinkFlags) => status(call<number>("unlinkat", dirfd, cstr(name), unlinkFlags)),
    renameat: (fromDirfd, fromName, toDirfd, toName) =>
      status(call<number>("renameat", fromDirfd, cstr(fromName), toDirfd, cstr(toName))),
    setCloexec: (fd) => status(fcntl(fd, F_SETFD, FD_CLOEXEC)),
    fstat: KeteLinuxFfi.nodeFdIo.fstat,
    pread: KeteLinuxFfi.nodeFdIo.pread,
    writeAll: KeteLinuxFfi.nodeFdIo.writeAll,
    close: KeteLinuxFfi.nodeFdIo.close,
  }
}
