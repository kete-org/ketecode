// Raw Linux syscalls for job mode's file confinement (job mode piece A3, kete-code-platform
// docs/jobs.md §8 item 3, "kete is not a deputy").
//
// `openat2(2)` has no libc wrapper in older glibc and none in musl, so it goes through libc's
// variadic `syscall(2)` by number (437 on x86_64 and arm64 alike); `getdents64(2)` the same way
// (217 / 61). The *at helpers (`mkdirat`, `unlinkat`, `renameat`) and `fcntl` are ordinary libc
// functions. libc is reached through `bun:ffi`, like the dumpable flag (cli/src/kete/dumpable.ts)
// and core's process lock: musl when `/lib/libc.musl-<arch>.so.1` exists, else glibc's
// `libc.so.6`. `bun:ffi` is loaded lazily with `require` so the Node build still bundles; nothing
// runs at import.
//
// Open-flag values differ between x86_64 and arm64 (O_DIRECTORY, O_NOFOLLOW), so they come from an
// explicit per-architecture table; a Linux test checks it against `fs.constants`. Descriptor I/O
// after the open (fstat, read, write, close) uses Node's fd APIs on the raw integer — they resolve
// no path — in their callback forms, so file I/O stays off the JS thread.
//
// `linux()` opens libc once and returns the bound syscalls; it is called once at server start and
// the result is passed down (no module-level mutable state).

export * as KeteLinuxFfi from "./linux-ffi.js"

import { close as fsClose, closeSync, existsSync, fstat as fsFstat, fstatSync, read as fsRead, write as fsWrite } from "node:fs"

export type Arch = "x64" | "arm64"

/** Linux errno numbers (asm-generic; the same on x86_64 and arm64). */
export const errno = {
  EPERM: 1,
  ENOENT: 2,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  EBADF: 9,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  EROFS: 30,
  EPIPE: 32,
  ERANGE: 34,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  EOPNOTSUPP: 95,
} as const

const errnoNames = new Map<number, string>(Object.entries(errno).map(([name, value]) => [value, name]))

/** The errno's name (`ENOENT`), or `errno <n>` for one this table doesn't know. */
export function errnoName(value: number): string {
  return errnoNames.get(value) ?? `errno ${value}`
}

export interface Flags {
  readonly O_RDONLY: number
  readonly O_WRONLY: number
  readonly O_CREAT: number
  readonly O_EXCL: number
  readonly O_NOCTTY: number
  readonly O_TRUNC: number
  readonly O_NONBLOCK: number
  readonly O_DIRECTORY: number
  readonly O_NOFOLLOW: number
  readonly O_CLOEXEC: number
  readonly O_PATH: number
}

const common = {
  O_RDONLY: 0,
  O_WRONLY: 0o1,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  O_NOCTTY: 0o400,
  O_TRUNC: 0o1000,
  O_NONBLOCK: 0o4000,
  O_CLOEXEC: 0o2000000,
  O_PATH: 0o10000000,
} as const

/** Open flags per architecture: O_DIRECTORY and O_NOFOLLOW differ between x86_64 and arm64. */
export const flagsByArch: Readonly<Record<Arch, Flags>> = {
  x64: { ...common, O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000 },
  arm64: { ...common, O_DIRECTORY: 0o40000, O_NOFOLLOW: 0o100000 },
}

export const AT_FDCWD = -100
export const AT_REMOVEDIR = 0x200
export const F_SETFD = 2
export const FD_CLOEXEC = 1
export const RESOLVE_NO_MAGICLINKS = 0x02
export const RESOLVE_NO_SYMLINKS = 0x04
export const RESOLVE_BENEATH = 0x08
/** `sizeof(struct open_how)`, OPEN_HOW_SIZE_VER0: `u64 flags, u64 mode, u64 resolve`. */
export const OPEN_HOW_SIZE = 24

/** Syscall numbers per architecture. */
export const syscallNumbers: Readonly<Record<Arch, { readonly openat2: number; readonly getdents64: number }>> = {
  x64: { openat2: 437, getdents64: 217 },
  arm64: { openat2: 437, getdents64: 61 },
}

/** `linux_dirent64` d_type values. */
export const DT = { UNKNOWN: 0, FIFO: 1, CHR: 2, DIR: 4, BLK: 6, REG: 8, LNK: 10, SOCK: 12 } as const

export type Result<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly errno: number }

export type Kind = "file" | "directory" | "symlink" | "other"

export interface Stat {
  readonly type: Kind
  readonly size: number
  readonly mtimeMs: number
}

/** Everything the confined file layer needs from the kernel. Tests inject an in-memory fake. */
export interface Syscalls {
  readonly flags: Flags
  /** `openat2(dirfd, path, {flags, mode, resolve}, 24)`; `mode` must be 0 unless O_CREAT is set. */
  readonly openat2: (dirfd: number, path: string, flags: number, mode: number, resolve: number) => Result<number>
  /** One `getdents64(fd, buffer, buffer.length)` call: the number of bytes filled, 0 at the end. */
  readonly getdents64: (fd: number, buffer: Uint8Array) => Result<number>
  /** Every entry of an open directory, read to its end (`.` and `..` skipped). */
  readonly readdir: (fd: number) => Result<Dirent[]>
  readonly mkdirat: (dirfd: number, name: string, mode: number) => Result<void>
  readonly unlinkat: (dirfd: number, name: string, flags: number) => Result<void>
  readonly renameat: (fromDirfd: number, fromName: string, toDirfd: number, toName: string) => Result<void>
  readonly setCloexec: (fd: number) => Result<void>
  readonly fstat: (fd: number) => Promise<Result<Stat>>
  /** One positional read (`position` null reads at the file offset); the number of bytes read. */
  readonly pread: (fd: number, buffer: Uint8Array, position: number | null) => Promise<Result<number>>
  readonly writeAll: (fd: number, bytes: Uint8Array) => Promise<Result<void>>
  readonly close: (fd: number) => Result<void>
}

export type Linux = Syscalls | { readonly unsupported: string }

/** Builds the 24-byte `struct open_how` (little-endian on both supported architectures). */
export function openHow(flags: number, mode: number, resolve: number): Uint8Array {
  const bytes = new Uint8Array(OPEN_HOW_SIZE)
  const view = new DataView(bytes.buffer)
  view.setBigUint64(0, BigInt(flags), true)
  view.setBigUint64(8, BigInt(mode), true)
  view.setBigUint64(16, BigInt(resolve), true)
  return bytes
}

export interface Dirent {
  readonly name: string
  readonly type: number
}

/** Parses `linux_dirent64` records: `u64 d_ino @0, s64 d_off @8, u16 d_reclen @16, u8 d_type @18,
 * d_name @19` (NUL-terminated). `.` and `..` are skipped. */
export function parseDirents(buffer: Uint8Array, length: number): Dirent[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const decoder = new TextDecoder()
  const out: Dirent[] = []
  let offset = 0
  while (offset < length) {
    const reclen = view.getUint16(offset + 16, true)
    if (reclen === 0) break
    const type = view.getUint8(offset + 18)
    let end = offset + 19
    while (end < offset + reclen && buffer[end] !== 0) end++
    const name = decoder.decode(buffer.subarray(offset + 19, end))
    if (name !== "." && name !== "..") out.push({ name, type })
    offset += reclen
  }
  return out
}

const DIRENT_BUFFER_BYTES = 64 * 1024

/** Reads a directory to its end with repeated `getdents64` calls: 0 bytes is the end, an error is returned as is. */
export function readDirents(getdents64: (buffer: Uint8Array) => Result<number>): Result<Dirent[]> {
  const buffer = new Uint8Array(DIRENT_BUFFER_BYTES)
  const out: Dirent[] = []
  for (;;) {
    const result = getdents64(buffer)
    if (!result.ok) return result
    if (result.value === 0) return { ok: true, value: out }
    out.push(...parseDirents(buffer, result.value))
  }
}

/**
 * `openat2` emulated with one `openat` per component, for kernels without it (< 5.6: RHEL 8, WSL1).
 * Each intermediate is opened O_PATH|O_NOFOLLOW (no device open, works on execute-only directories)
 * and checked with `kind`: a symlink is ELOOP (never followed), a non-directory ENOTDIR. The last
 * component gets O_NOFOLLOW too (O_PATH|O_NOFOLLOW still yields the link itself, as with openat2).
 * Needs RESOLVE_NO_SYMLINKS. RESOLVE_BENEATH refuses an absolute path or `..` (EXDEV); without it an
 * absolute path walks from an fd for "/", not from `dirfd`. Empty components are skipped, so a
 * trailing slash does not demand a directory (openat2 would give ENOTDIR for a file).
 */
export function emulateOpenat2(
  sys: {
    readonly flags: Flags
    readonly openat: (dirfd: number, path: string, flags: number, mode: number) => Result<number>
    readonly close: (fd: number) => Result<void>
    readonly kind: (fd: number) => Result<Kind>
  },
  dirfd: number,
  path: string,
  flags: number,
  mode: number,
  resolve: number,
): Result<number> {
  const F = sys.flags
  const bad = (value: number): Result<number> => ({ ok: false, errno: value })
  if ((resolve & RESOLVE_NO_SYMLINKS) === 0) return bad(errno.EINVAL)
  const parts = path.split("/").filter((part) => part !== "" && part !== ".")
  if ((resolve & RESOLVE_BENEATH) !== 0 && (path.startsWith("/") || parts.includes(".."))) return bad(errno.EXDEV)
  let current = dirfd
  let owned = false
  if (path.startsWith("/")) {
    const root = sys.openat(AT_FDCWD, "/", F.O_PATH | F.O_DIRECTORY | F.O_NOFOLLOW | F.O_CLOEXEC, 0)
    if (!root.ok) return root
    current = root.value
    owned = true
  }
  if (parts.length === 0) {
    const self = sys.openat(current, ".", flags | F.O_NOFOLLOW, mode)
    if (owned) sys.close(current)
    return self
  }
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1
    const next = last
      ? sys.openat(current, part, flags | F.O_NOFOLLOW, mode)
      : sys.openat(current, part, F.O_PATH | F.O_NOFOLLOW | F.O_CLOEXEC, 0)
    if (owned) sys.close(current)
    if (!next.ok) return next
    current = next.value
    owned = true
    if (!last) {
      const kind = sys.kind(current)
      const failure = !kind.ok ? kind.errno : kind.value === "symlink" ? errno.ELOOP : kind.value !== "directory" ? errno.ENOTDIR : 0
      if (failure !== 0) {
        sys.close(current)
        return { ok: false, errno: failure }
      }
    }
  }
  return { ok: true, value: current }
}

/** Whether a failed `openat2` falls back to the emulation: ENOSYS (kernel < 5.6) or, with
 * `fallback`, EPERM (older Docker seccomp profiles answer unknown syscalls with EPERM, not ENOSYS). */
export function shouldEmulate(failure: number, fallback: boolean): boolean {
  return fallback && (failure === errno.ENOSYS || failure === errno.EPERM)
}

/** The architecture's key in the tables above, or `undefined` for an unsupported one. */
export function arch(value: string = process.arch): Arch | undefined {
  return value === "x64" || value === "arm64" ? value : undefined
}

const codeErrno = (error: unknown): number => {
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : ""
  return (errno as Record<string, number>)[code] ?? errno.EIO
}

const kindOf = (stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): Kind => {
  if (stats.isFile()) return "file"
  if (stats.isDirectory()) return "directory"
  if (stats.isSymbolicLink()) return "symlink"
  return "other"
}

/** Node fd I/O shared by the real syscalls (the fake has its own). */
export const nodeFdIo = {
  fstat: (fd: number) =>
    new Promise<Result<Stat>>((resolve) =>
      fsFstat(fd, (error, stats) =>
        resolve(error ? { ok: false, errno: codeErrno(error) } : { ok: true, value: { type: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs } }),
      ),
    ),
  pread: (fd: number, buffer: Uint8Array, position: number | null) =>
    new Promise<Result<number>>((resolve) =>
      fsRead(fd, buffer, 0, buffer.byteLength, position, (error, bytesRead) =>
        resolve(error ? { ok: false, errno: codeErrno(error) } : { ok: true, value: bytesRead }),
      ),
    ),
  writeAll: async (fd: number, bytes: Uint8Array): Promise<Result<void>> => {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = await new Promise<Result<number>>((resolve) =>
        fsWrite(fd, bytes, offset, bytes.byteLength - offset, null, (error, count) =>
          resolve(error ? { ok: false, errno: codeErrno(error) } : { ok: true, value: count }),
        ),
      )
      if (!written.ok) return written
      if (written.value === 0) return { ok: false, errno: errno.EIO }
      offset += written.value
    }
    return { ok: true, value: undefined }
  },
  close: (fd: number): Result<void> => {
    try {
      closeSync(fd)
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, errno: codeErrno(error) }
    }
  },
  closeAsync: (fd: number) => new Promise<void>((resolve) => fsClose(fd, () => resolve())),
}

function libcPath(value: Arch) {
  const musl = `/lib/libc.musl-${value === "arm64" ? "aarch64" : "x86_64"}.so.1`
  return existsSync(musl) ? musl : "libc.so.6"
}

/** The real syscalls through libc, or why they're unavailable (not Linux, an unsupported
 * architecture, not the Bun runtime, or libc failed to load). Opens libc once; the library stays
 * open for the process's life (it's the process's own libc). With `fallback`, an `openat2` that
 * the kernel lacks (ENOSYS, or EPERM from a seccomp filter) is emulated per component (`emulateOpenat2`); job mode leaves it off
 * and refuses to start instead. */
export function linux(platform: NodeJS.Platform = process.platform, archName: string = process.arch, fallback = false): Linux {
  if (platform !== "linux") return { unsupported: `not Linux (${platform})` }
  const key = arch(archName)
  if (key === undefined) return { unsupported: `unsupported architecture (${archName})` }
  if (typeof Bun === "undefined") return { unsupported: "needs the Bun runtime" }
  let ffi: typeof import("bun:ffi")
  let library
  try {
    // Lazy, so the Node build still bundles.
    ffi = require("bun:ffi") as typeof import("bun:ffi")
    library = ffi.dlopen(libcPath(key), {
      // Variadic in libc; integer and pointer arguments pass identically in registers on x86_64 SysV
      // and Linux AAPCS64. Pointers are passed as their numeric address (`ffi.ptr`).
      syscall: { args: ["i64", "i64", "u64", "u64", "u64"], returns: "i64" },
      openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
      unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
      renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
      fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    })
  } catch (error) {
    return { unsupported: `could not load libc: ${error instanceof Error ? error.message : String(error)}` }
  }
  const { symbols } = library
  const numbers = syscallNumbers[key]
  // errno is read in the same synchronous turn as the failing call (process-lock-ffi.bun.ts).
  const lastErrno = () => {
    const pointer = symbols.__errno_location()
    return pointer === null ? errno.EIO : ffi.read.i32(pointer, 0)
  }
  const cstr = (value: string) => Buffer.from(value + "\0", "utf8")
  const status = (result: number): Result<void> => (result === -1 ? { ok: false, errno: lastErrno() } : { ok: true, value: undefined })

  const flags = flagsByArch[key]
  const getdents64: Syscalls["getdents64"] = (fd, buffer) => {
    const result = Number(symbols.syscall(numbers.getdents64, fd, ffi.ptr(buffer), buffer.byteLength, 0))
    if (result < 0) return { ok: false, errno: lastErrno() }
    return { ok: true, value: result }
  }
  const fdKind = (fd: number): Result<Kind> => {
    try {
      return { ok: true, value: kindOf(fstatSync(fd)) }
    } catch (error) {
      return { ok: false, errno: codeErrno(error) }
    }
  }
  // `openat` is variadic in libc, but the fixed four-argument binding is safe on x86_64 and arm64
  // Linux: every argument is an integer or pointer, passed in registers.
  const openat = (dirfd: number, path: string, openFlags: number, mode: number): Result<number> => {
    const result = symbols.openat(dirfd, cstr(path), openFlags, mode)
    return result < 0 ? { ok: false, errno: lastErrno() } : { ok: true, value: result }
  }

  return {
    flags,
    openat2: (dirfd, path, openFlags, mode, resolve) => {
      const name = cstr(path)
      const how = openHow(openFlags, mode, resolve)
      const result = Number(symbols.syscall(numbers.openat2, dirfd, ffi.ptr(name), ffi.ptr(how), OPEN_HOW_SIZE))
      if (result >= 0) return { ok: true, value: result }
      const failure = lastErrno()
      if (shouldEmulate(failure, fallback))
        return emulateOpenat2({ flags, openat, close: nodeFdIo.close, kind: fdKind }, dirfd, path, openFlags, mode, resolve)
      return { ok: false, errno: failure }
    },
    getdents64,
    readdir: (fd) => readDirents((buffer) => getdents64(fd, buffer)),
    mkdirat: (dirfd, name, mode) => status(symbols.mkdirat(dirfd, cstr(name), mode)),
    unlinkat: (dirfd, name, flags) => status(symbols.unlinkat(dirfd, cstr(name), flags)),
    renameat: (fromDirfd, fromName, toDirfd, toName) =>
      status(symbols.renameat(fromDirfd, cstr(fromName), toDirfd, cstr(toName))),
    setCloexec: (fd) => status(symbols.fcntl(fd, F_SETFD, FD_CLOEXEC)),
    fstat: nodeFdIo.fstat,
    pread: nodeFdIo.pread,
    writeAll: nodeFdIo.writeAll,
    close: nodeFdIo.close,
  }
}

/** Marks `fd` close-on-exec — on Linux through `linux()`, on macOS through libSystem's `fcntl`
 * (job mode itself runs only on Linux; macOS is for `kete job run`'s own tests). Throws on
 * failure or an unsupported platform. */
export function setCloexec(fd: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "linux") {
    const sys = linux(platform)
    if ("unsupported" in sys) throw new Error(`cannot mark descriptor ${fd} close-on-exec: ${sys.unsupported}`)
    const result = sys.setCloexec(fd)
    if (!result.ok) throw new Error(`cannot mark descriptor ${fd} close-on-exec: ${errnoName(result.errno)}`)
    return
  }
  if (platform === "darwin" && typeof Bun !== "undefined") {
    const ffi = require("bun:ffi") as typeof import("bun:ffi")
    // Apple arm64 passes variadic arguments on the stack: pad x2..x7 so the third argument lands there.
    const padded = process.arch === "arm64"
    const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      fcntl: { args: padded ? ["i32", "i32", "i64", "i64", "i64", "i64", "i64", "i64", "i64"] : ["i32", "i32", "i32"], returns: "i32" },
    })
    try {
      // F_SETFD and FD_CLOEXEC have the same values on macOS.
      const fcntl = library.symbols.fcntl as unknown as (...args: number[]) => number
      const result = padded ? fcntl(fd, F_SETFD, 0, 0, 0, 0, 0, 0, FD_CLOEXEC) : fcntl(fd, F_SETFD, FD_CLOEXEC)
      if (result === -1) throw new Error(`cannot mark descriptor ${fd} close-on-exec`)
    } finally {
      library.close()
    }
    return
  }
  throw new Error(`cannot mark descriptor ${fd} close-on-exec on ${platform}`)
}
