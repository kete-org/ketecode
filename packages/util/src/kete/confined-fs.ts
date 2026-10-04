// Confined file access for job mode (job mode piece A3, kete-code-platform docs/jobs.md §8 item 3,
// "kete is not a deputy").
//
// In a cloud job the tool user can write anything in the working tree, including symbolic links
// to `kete`'s own files (its spec, data dir, `/proc/self/...`). `kete` must never follow one: every
// open, stat, listing, mkdir, rename and unlink it makes in the working tree goes through
// `openat2(2)` relative to a descriptor of the tree's root, opened once at startup, with
// RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS, and through `*at` calls on
// descriptors obtained that way. A symlink anywhere in the path (`ELOOP`) or an escape (`EXDEV`) is
// a refusal; there is never a fallback to a plain `open`.
//
// Paths are checked before any syscall: a NUL byte, an absolute path outside the root and a `..`
// escape are refused outright. Results are plain discriminated unions (no Effect), adapted by
// core's job-mode Environment driver (core/src/kete/job-files.ts) and the FSUtil wrapper
// (job-fs-util.ts). Error messages never contain a link target or file content.

export * as KeteConfinedFs from "./confined-fs.js"

import path from "node:path"
import { realpathSync } from "node:fs"
import { KeteLinuxFfi } from "./linux-ffi.js"

export type Kind = KeteLinuxFfi.Kind
export type Stat = KeteLinuxFfi.Stat

export type Failure =
  | { readonly kind: "missing" }
  | { readonly kind: "refused" }
  | { readonly kind: "wrongKind"; readonly actual: Kind }
  | { readonly kind: "failed"; readonly reason: string }

export type Outcome<A> = { readonly kind: "ok"; readonly value: A } | Failure

export interface Entry {
  readonly name: string
  readonly type: Kind
}

/** The cause carried by a refusal (`Environment.Failed`'s cause, a `PlatformError`'s cause). */
export class Refused extends Error {
  override readonly name = "KeteConfinedFs.Refused"
  constructor(readonly relative: string) {
    super(refusedMessage(relative))
  }
}

export function refusedMessage(relative: string): string {
  return `Job mode: refused to follow a symbolic link or leave the working tree: ${relative}`
}

export class StartError extends Error {
  override readonly name = "KeteConfinedFs.StartError"
}

const RESOLVE = KeteLinuxFfi.RESOLVE_BENEATH | KeteLinuxFfi.RESOLVE_NO_SYMLINKS | KeteLinuxFfi.RESOLVE_NO_MAGICLINKS
/** Retries for EAGAIN (a concurrent rename under RESOLVE_BENEATH) and EINTR. */
export const MAX_RETRIES = 8
/** The deepest directory tree `remove` walks. */
export const MAX_REMOVE_DEPTH = 512
const DIRENT_BUFFER_BYTES = 64 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export interface Root {
  /** The root as given (the `kete serve` child's cwd). */
  readonly lexical: string
  /** Its realpath at startup. */
  readonly real: string
  /** An O_PATH descriptor of `real`, held for the process's life. */
  readonly fd: number
  readonly sys: KeteLinuxFfi.Syscalls
}

const ok = <A>(value: A): Outcome<A> => ({ kind: "ok", value })
const failed = (reason: string): Failure => ({ kind: "failed", reason })

/** Maps an errno to the shared failure channels: ENOENT/ENOTDIR missing, ELOOP/EXDEV refused,
 * anything else failed with the errno's name. */
export function fromErrno(value: number): Failure {
  const E = KeteLinuxFfi.errno
  if (value === E.ENOENT || value === E.ENOTDIR) return { kind: "missing" }
  if (value === E.ELOOP || value === E.EXDEV) return { kind: "refused" }
  return failed(KeteLinuxFfi.errnoName(value))
}

/**
 * Opens the root and probes `openat2`. Throws (`StartError`) when the platform isn't Linux, the
 * syscalls are unavailable, or `openat2` itself is (ENOSYS: kernel < 5.6 or seccomp; E2BIG/EINVAL:
 * no `open_how` support) — job mode then refuses to start, never falling back to plain `open`.
 */
export function open(rootLexical: string, sys: KeteLinuxFfi.Linux, platform: NodeJS.Platform = process.platform): Root {
  if (platform !== "linux") throw new StartError(`Job mode: kete can't confine its file access (not Linux: ${platform}); refusing to start.`)
  if ("unsupported" in sys) throw new StartError(`Job mode: kete can't confine its file access (${sys.unsupported}); refusing to start.`)
  if (!path.isAbsolute(rootLexical) || rootLexical.includes("\0"))
    throw new StartError("Job mode: the working tree root is not an absolute path; refusing to start.")
  let real: string
  try {
    real = realpathSync(rootLexical)
  } catch {
    throw new StartError("Job mode: the working tree root can't be resolved; refusing to start.")
  }
  const F = sys.flags
  const opened = sys.openat2(KeteLinuxFfi.AT_FDCWD, real, F.O_PATH | F.O_DIRECTORY | F.O_CLOEXEC, 0, KeteLinuxFfi.RESOLVE_NO_SYMLINKS | KeteLinuxFfi.RESOLVE_NO_MAGICLINKS)
  if (!opened.ok) {
    const E = KeteLinuxFfi.errno
    const name = KeteLinuxFfi.errnoName(opened.errno)
    if (opened.errno === E.ENOSYS || opened.errno === E.E2BIG || opened.errno === E.EINVAL)
      throw new StartError(`Job mode: kete can't confine its file access (openat2 unavailable: ${name}); refusing to start.`)
    throw new StartError(`Job mode: kete can't open the working tree root (${name}); refusing to start.`)
  }
  const probe = sys.openat2(opened.value, ".", F.O_PATH | F.O_DIRECTORY | F.O_CLOEXEC, 0, RESOLVE)
  if (!probe.ok) {
    sys.close(opened.value)
    throw new StartError(
      `Job mode: kete can't confine its file access (openat2 probe failed: ${KeteLinuxFfi.errnoName(probe.errno)}); refusing to start.`,
    )
  }
  sys.close(probe.value)
  return { lexical: rootLexical, real, fd: opened.value, sys }
}

export type Relative = { readonly kind: "inside"; readonly relative: string } | { readonly kind: "outside" } | { readonly kind: "invalid" }

/** The shared pre-check: refuses NUL, resolves `value` against the root (a relative path resolves
 * against it, as the local driver's do against cwd), and refuses anything outside it. */
export function relative(root: Pick<Root, "lexical" | "real">, value: string): Relative {
  if (value.includes("\0")) return { kind: "invalid" }
  const absolute = path.resolve(root.lexical, value)
  for (const base of root.lexical === root.real ? [root.lexical] : [root.lexical, root.real]) {
    const rel = path.relative(base, absolute)
    if (rel === "") return { kind: "inside", relative: "." }
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue
    return { kind: "inside", relative: rel }
  }
  return { kind: "outside" }
}

/** Whether `value` names something inside the root (no syscall). */
export function contains(root: Pick<Root, "lexical" | "real">, value: string): boolean {
  return relative(root, value).kind === "inside"
}

function openRetry(sys: KeteLinuxFfi.Syscalls, dirfd: number, rel: string, flags: number, mode = 0): KeteLinuxFfi.Result<number> {
  const E = KeteLinuxFfi.errno
  let result = sys.openat2(dirfd, rel, flags | sys.flags.O_CLOEXEC, mode, RESOLVE)
  for (let attempt = 0; !result.ok && (result.errno === E.EAGAIN || result.errno === E.EINTR) && attempt < MAX_RETRIES; attempt++)
    result = sys.openat2(dirfd, rel, flags | sys.flags.O_CLOEXEC, mode, RESOLVE)
  return result
}

function closeQuiet(sys: KeteLinuxFfi.Syscalls, fd: number) {
  sys.close(fd)
}

async function withFd<A>(sys: KeteLinuxFfi.Syscalls, fd: number, use: (fd: number) => Promise<Outcome<A>>): Promise<Outcome<A>> {
  try {
    return await use(fd)
  } finally {
    closeQuiet(sys, fd)
  }
}

/** Opens `rel` beneath `dirfd`; `.` relative to the root reuses nothing (a fresh fd either way). */
function openAt(root: Root, dirfd: number, rel: string, flags: number, mode = 0): Outcome<number> {
  const result = openRetry(root.sys, dirfd, rel, flags, mode)
  return result.ok ? ok(result.value) : fromErrno(result.errno)
}

async function fstatOf(root: Root, fd: number): Promise<Outcome<Stat>> {
  const result = await root.sys.fstat(fd)
  return result.ok ? ok(result.value) : fromErrno(result.errno)
}

/** lstat semantics: a final symlink is reported as `symlink` (O_PATH|O_NOFOLLOW gives a descriptor
 * of the link itself); a symlink in a middle component is refused. */
async function statAt(root: Root, dirfd: number, rel: string): Promise<Outcome<Stat>> {
  const F = root.sys.flags
  const fd = openAt(root, dirfd, rel, F.O_PATH | F.O_NOFOLLOW)
  if (fd.kind !== "ok") return fd
  return withFd(root.sys, fd.value, (value) => fstatOf(root, value))
}

function split(rel: string) {
  return rel === "." ? [] : rel.split(path.sep).filter((part) => part !== "" && part !== ".")
}

function parentAndName(rel: string): { readonly parent: string; readonly name: string } {
  const parts = split(rel)
  const name = parts.pop() ?? "."
  return { parent: parts.length === 0 ? "." : parts.join(path.sep), name }
}

function readEntries(root: Root, fd: number): Outcome<KeteLinuxFfi.Dirent[]> {
  const buffer = new Uint8Array(DIRENT_BUFFER_BYTES)
  const out: KeteLinuxFfi.Dirent[] = []
  for (;;) {
    const result = root.sys.getdents64(fd, buffer)
    if (!result.ok) return fromErrno(result.errno)
    if (result.value === 0) return ok(out)
    out.push(...KeteLinuxFfi.parseDirents(buffer, result.value))
  }
}

function direntKind(type: number): Kind | undefined {
  const DT = KeteLinuxFfi.DT
  if (type === DT.REG) return "file"
  if (type === DT.DIR) return "directory"
  if (type === DT.LNK) return "symlink"
  if (type === DT.UNKNOWN) return undefined
  return "other"
}

export interface Ops {
  readonly read: (value: string, range?: { readonly offset: number; readonly length: number }) => Promise<Outcome<{ readonly info: Stat; readonly bytes: Uint8Array }>>
  readonly write: (value: string, bytes: Uint8Array) => Promise<Outcome<void>>
  readonly stat: (value: string) => Promise<Outcome<Stat>>
  readonly list: (value: string) => Promise<Outcome<Entry[]>>
  readonly remove: (value: string) => Promise<Outcome<void>>
  readonly move: (from: string, to: string) => Promise<Outcome<void>>
  readonly mkdir: (value: string) => Promise<Outcome<void>>
  /** The canonical path of an existing, non-symlink entry inside the root. */
  readonly realPath: (value: string) => Promise<Outcome<string>>
}

const inside = (root: Root, value: string): Outcome<string> => {
  const rel = relative(root, value)
  if (rel.kind === "inside") return ok(rel.relative)
  return { kind: "refused" }
}

/** The primitive operations of table B (plan.md), each over the root descriptor. */
export function ops(root: Root): Ops {
  const sys = root.sys
  const F = sys.flags

  const readAll = async (fd: number): Promise<Outcome<Uint8Array>> => {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const buffer = new Uint8Array(READ_CHUNK_BYTES)
      const result = await sys.pread(fd, buffer, null)
      if (!result.ok) return fromErrno(result.errno)
      if (result.value === 0) break
      chunks.push(buffer.subarray(0, result.value))
      total += result.value
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return ok(bytes)
  }

  /** mkdir -p beneath the root, one component at a time; returns an O_PATH fd of the directory. */
  const mkdirp = (rel: string): Outcome<number> => {
    const dup = openAt(root, root.fd, ".", F.O_PATH | F.O_DIRECTORY)
    if (dup.kind !== "ok") return dup
    let current = dup.value
    for (const part of split(rel)) {
      let next = openAt(root, current, part, F.O_PATH | F.O_DIRECTORY)
      if (next.kind === "missing") {
        const made = sys.mkdirat(current, part, 0o777)
        if (!made.ok && made.errno !== KeteLinuxFfi.errno.EEXIST) {
          closeQuiet(sys, current)
          const failure = fromErrno(made.errno)
          return failure.kind === "missing" ? failed(KeteLinuxFfi.errnoName(made.errno)) : failure
        }
        next = openAt(root, current, part, F.O_PATH | F.O_DIRECTORY)
      }
      closeQuiet(sys, current)
      if (next.kind !== "ok") return next.kind === "missing" ? failed("ENOTDIR") : next
      current = next.value
    }
    return ok(current)
  }

  const removeTree = async (parent: number, name: string, depth: number): Promise<Outcome<void>> => {
    if (depth > MAX_REMOVE_DEPTH) return failed(`directory tree deeper than ${MAX_REMOVE_DEPTH}`)
    const info = await statAt(root, parent, name)
    if (info.kind === "missing") return ok(undefined)
    if (info.kind !== "ok") return info
    if (info.value.type !== "directory") {
      const gone = sys.unlinkat(parent, name, 0)
      if (!gone.ok && gone.errno !== KeteLinuxFfi.errno.ENOENT) return fromErrno(gone.errno)
      return ok(undefined)
    }
    const dir = openAt(root, parent, name, F.O_RDONLY | F.O_DIRECTORY)
    if (dir.kind === "missing") return ok(undefined)
    if (dir.kind !== "ok") return dir
    const emptied = await withFd(sys, dir.value, async (fd) => {
      const entries = readEntries(root, fd)
      if (entries.kind !== "ok") return entries
      for (const entry of entries.value) {
        const removed = await removeTree(fd, entry.name, depth + 1)
        if (removed.kind !== "ok") return removed
      }
      return ok(undefined)
    })
    if (emptied.kind !== "ok") return emptied
    const gone = sys.unlinkat(parent, name, KeteLinuxFfi.AT_REMOVEDIR)
    if (!gone.ok && gone.errno !== KeteLinuxFfi.errno.ENOENT) return fromErrno(gone.errno)
    return ok(undefined)
  }

  return {
    read: async (value, range) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      const fd = openAt(root, root.fd, rel.value, F.O_RDONLY | F.O_NOCTTY | F.O_NONBLOCK)
      if (fd.kind === "failed" && fd.reason === "ENXIO") {
        // A socket can't be opened: report its kind, as the local driver's stat would.
        const info = await statAt(root, root.fd, rel.value)
        return info.kind === "ok" ? { kind: "wrongKind", actual: info.value.type } : info
      }
      if (fd.kind !== "ok") return fd
      return withFd(sys, fd.value, async (handle) => {
        const info = await fstatOf(root, handle)
        if (info.kind !== "ok") return info
        if (info.value.type !== "file") return { kind: "wrongKind", actual: info.value.type }
        if (range === undefined) {
          const bytes = await readAll(handle)
          return bytes.kind === "ok" ? ok({ info: info.value, bytes: bytes.value }) : bytes
        }
        const buffer = new Uint8Array(range.length)
        if (range.length === 0) return ok({ info: info.value, bytes: buffer })
        const result = await sys.pread(handle, buffer, range.offset)
        if (!result.ok) return fromErrno(result.errno)
        return ok({ info: info.value, bytes: buffer.subarray(0, result.value) })
      })
    },

    write: async (value, bytes) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      if (rel.value === ".") return failed("EISDIR")
      const { parent, name } = parentAndName(rel.value)
      const dir = mkdirp(parent)
      if (dir.kind !== "ok") return dir
      const fd = withFdSync(sys, dir.value, (dirfd) =>
        openAt(root, dirfd, name, F.O_WRONLY | F.O_CREAT | F.O_TRUNC | F.O_NOCTTY | F.O_NONBLOCK, 0o666),
      )
      if (fd.kind !== "ok") return fd.kind === "missing" ? failed("ENOENT") : fd
      return withFd(sys, fd.value, async (handle) => {
        const info = await fstatOf(root, handle)
        if (info.kind !== "ok") return info
        if (info.value.type !== "file") return failed(`not a regular file (${info.value.type})`)
        const written = await sys.writeAll(handle, bytes)
        return written.ok ? ok(undefined) : fromErrno(written.errno)
      })
    },

    stat: async (value) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      if (rel.value === ".") return fstatOf(root, root.fd)
      return statAt(root, root.fd, rel.value)
    },

    list: async (value) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      const fd = openAt(root, root.fd, rel.value, F.O_RDONLY | F.O_DIRECTORY)
      if (fd.kind === "missing") {
        const info = await statAt(root, root.fd, rel.value)
        return info.kind === "ok" ? { kind: "wrongKind", actual: info.value.type } : info
      }
      if (fd.kind !== "ok") return fd
      return withFd(sys, fd.value, async (handle) => {
        const entries = readEntries(root, handle)
        if (entries.kind !== "ok") return entries
        const out: Entry[] = []
        for (const entry of entries.value) {
          const known = direntKind(entry.type)
          if (known !== undefined) {
            out.push({ name: entry.name, type: known })
            continue
          }
          const info = await statAt(root, handle, entry.name)
          if (info.kind === "missing") continue
          if (info.kind !== "ok") return info
          out.push({ name: entry.name, type: info.value.type })
        }
        return ok(out)
      })
    },

    remove: async (value) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      if (rel.value === ".") return failed("refusing to remove the working tree root")
      const { parent, name } = parentAndName(rel.value)
      const dir = openAt(root, root.fd, parent, F.O_PATH | F.O_DIRECTORY)
      if (dir.kind === "missing") return ok(undefined)
      if (dir.kind !== "ok") return dir
      return withFd(sys, dir.value, (dirfd) => removeTree(dirfd, name, 0))
    },

    move: async (from, to) => {
      const source = inside(root, from)
      if (source.kind !== "ok") return source
      const target = inside(root, to)
      if (target.kind !== "ok") return target
      if (source.value === ".") return failed("refusing to move the working tree root")
      const info = await statAt(root, root.fd, source.value)
      if (info.kind !== "ok") return info
      const destination = await statAt(root, root.fd, target.value).then((stat) =>
        stat.kind === "ok" && stat.value.type === "directory"
          ? ok({ parent: target.value, name: path.basename(source.value) })
          : stat.kind === "ok" || stat.kind === "missing"
            ? ok(parentAndName(target.value))
            : stat,
      )
      if (destination.kind !== "ok") return destination
      const fromParent = parentAndName(source.value)
      const fromDir = openAt(root, root.fd, fromParent.parent, F.O_PATH | F.O_DIRECTORY)
      if (fromDir.kind !== "ok") return fromDir
      return withFd(sys, fromDir.value, async (fromfd) => {
        const toDir = openAt(root, root.fd, destination.value.parent, F.O_PATH | F.O_DIRECTORY)
        if (toDir.kind !== "ok") return toDir.kind === "missing" ? failed("ENOENT") : toDir
        return withFd(sys, toDir.value, async (tofd) => {
          const moved = sys.renameat(fromfd, fromParent.name, tofd, destination.value.name)
          if (moved.ok) return ok(undefined)
          const failure = fromErrno(moved.errno)
          return failure.kind === "missing" ? failed(KeteLinuxFfi.errnoName(moved.errno)) : failure
        })
      })
    },

    mkdir: async (value) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      const dir = mkdirp(rel.value)
      if (dir.kind !== "ok") return dir
      closeQuiet(sys, dir.value)
      return ok(undefined)
    },

    realPath: async (value) => {
      const rel = inside(root, value)
      if (rel.kind !== "ok") return rel
      const info = rel.value === "." ? await fstatOf(root, root.fd) : await statAt(root, root.fd, rel.value)
      if (info.kind !== "ok") return info
      if (info.value.type === "symlink") return { kind: "refused" }
      return ok(rel.value === "." ? root.real : path.join(root.real, rel.value))
    },
  }
}

function withFdSync<A>(sys: KeteLinuxFfi.Syscalls, fd: number, use: (fd: number) => A): A {
  try {
    return use(fd)
  } finally {
    sys.close(fd)
  }
}

/** The relative form of `value` for a refusal message (never the link target). */
export function describe(root: Pick<Root, "lexical" | "real">, value: string): string {
  const rel = relative(root, value)
  return rel.kind === "inside" ? rel.relative : rel.kind === "outside" ? "(outside the working tree)" : "(invalid path)"
}
