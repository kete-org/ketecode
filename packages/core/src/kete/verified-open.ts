// The file tools (read, write, edit, patch) check a path with `FileAccess.resolve` (symlinks followed, inside
// or outside the workspace, permission asked) and open it later by that same path. A process that can
// change the folder in between (a symlink swapped in after the check) would make the open land on a file the
// check never saw (time-of-check/time-of-use). So `FileAccess.resolve` records the real path it checked for
// the current tool call (`record`), and the local driver (environment/local.ts) opens that real path and proves
// the descriptor is the file that was checked (`read`, `write`); on any mismatch nothing is read or written.
//
// On Linux and macOS the real path is opened relative to a descriptor of `/` with no symbolic link allowed in
// any component (confined-fs.ts over openat2, or openat with O_NOFOLLOW_ANY on macOS), so a swapped folder
// can't redirect a read, a create, a delete or a listing. If that layer can't load, the file tools refuse
// (fail closed). Windows keeps the identity check only. Writing a file with other hard links is refused. The
// formatter (run after a write) rewrites by path: it runs only when the path has no link and still opens as the
// checked file, but a swap during its own spawn (milliseconds) is not covered. Raw node:fs for descriptor I/O, like the local driver
// it is called from (the only caller; nothing above the environment seam touches it).

export * as KeteVerifiedOpen from "./verified-open.js"

import { ToolFailure } from "@opencode/ai/effect"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { KeteDarwinFfi } from "@opencode/util/kete/darwin-ffi"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { Context, Effect } from "effect"
import {
  constants,
  fstat as fsFstat,
  ftruncate as fsFtruncate,
  read as fsRead,
  readFile as fsReadFile,
  write as fsWrite,
  type BigIntStats,
} from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Failed, NotFound, WrongKind } from "../environment/files.js"
import { KeteRealPath } from "./real-path.js"

export const CONFLICT = Symbol("conflict")

/** What `FileAccess.resolve` checked: the real path and, for an existing file, its identity at that moment. */
export interface Entry {
  readonly real: string
  readonly id?: { readonly dev: bigint; readonly ino: bigint }
  /** The checked path is itself a symbolic link. */
  readonly link?: boolean
  /** For a link: its folder (lexical, equal to its real path at check time, so no link in it), so the link (not its
   *  target) can be deleted without following a swapped folder. Unset when a link is in the folder's own path. */
  readonly linkParent?: string
}

export interface Registry {
  /** `path.resolve(absolute)` -> what `FileAccess.resolve` checked. */
  readonly paths: Map<string, Entry | typeof CONFLICT>
  changed: boolean
}

/** The paths one tool call checked; `undefined` outside a tool call, where nothing is verified. */
export const Expected = Context.Reference<Registry | undefined>("@kete/VerifiedOpen/Expected", {
  defaultValue: () => undefined,
})

/** How this machine opens a checked path: with no link in any component, by identity only (Windows), or not at all. */
export type Platform =
  | { readonly kind: "nofollow"; readonly root: KeteConfinedFs.Root; readonly ops: KeteConfinedFs.Ops }
  | { readonly kind: "identity" }
  | { readonly kind: "unsupported"; readonly reason: string }

const refuse = (reason: string): Platform => ({ kind: "unsupported", reason })

/**
 * Pick the platform layer and open `/` once. The descriptor is held for the process's life (as job mode's
 * `Root.fd` is): it is the anchor of every later open. Linux falls back to a per-component walk on kernels
 * without openat2 (`linux(…, true)`); macOS is probed for O_NOFOLLOW_ANY (`/var` must be refused).
 */
export function load(platform: NodeJS.Platform = process.platform, archName: string = process.arch): Platform {
  if (platform === "win32") return { kind: "identity" }
  if (platform !== "linux" && platform !== "darwin") return refuse(`no-follow file access is not available on ${platform}`)
  const darwin = platform === "darwin"
  const sys = darwin ? KeteDarwinFfi.darwin(platform, archName) : KeteLinuxFfi.linux(platform, archName, true)
  if ("unsupported" in sys) return refuse(sys.unsupported)
  const F = sys.flags
  const cwd = darwin ? KeteDarwinFfi.AT_FDCWD : KeteLinuxFfi.AT_FDCWD
  const strict = KeteLinuxFfi.RESOLVE_NO_SYMLINKS | KeteLinuxFfi.RESOLVE_NO_MAGICLINKS
  const fd = sys.openat2(cwd, "/", F.O_PATH | F.O_DIRECTORY | F.O_CLOEXEC, 0, strict)
  if (!fd.ok) return refuse(`could not open / (${KeteLinuxFfi.errnoName(fd.errno)})`)
  if (darwin) {
    const probe = sys.openat2(cwd, "/var", F.O_PATH | F.O_DIRECTORY, 0, KeteLinuxFfi.RESOLVE_NO_SYMLINKS)
    if (probe.ok) sys.close(probe.value)
    if (probe.ok || probe.errno !== KeteLinuxFfi.errno.ELOOP) {
      sys.close(fd.value)
      return refuse("O_NOFOLLOW_ANY is not honoured")
    }
  }
  const root: KeteConfinedFs.Root = { lexical: "/", real: "/", fd: fd.value, sys }
  return { kind: "nofollow", root, ops: KeteConfinedFs.ops(root) }
}

/** The platform layer for this process. Effect caches a Reference's default, so `load` runs once; tests provide their own. */
export const CurrentPlatform = Context.Reference<Platform>("@kete/VerifiedOpen/Platform", {
  defaultValue: () => {
    try {
      return load()
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  },
})

export class ChangedError extends Error {
  constructor(readonly path: string, readonly expected: string, detail: string) {
    super(`${path} no longer leads to ${expected}: ${detail}`)
    this.name = "KeteVerifiedOpenChangedError"
  }
}

const CHANGED = "The file changed while it was being opened; try again."

/** Run a tool call with its own registry; a refused open reaches the model as a clear `ToolFailure`. */
export const scoped = <A, R>(effect: Effect.Effect<A, ToolFailure, R>): Effect.Effect<A, ToolFailure, R> =>
  Effect.suspend(() => {
    const registry: Registry = { paths: new Map(), changed: false }
    return effect.pipe(
      Effect.provideService(Expected, registry),
      Effect.catch((error: ToolFailure) =>
        registry.changed
          ? Effect.fail(new ToolFailure({ message: `${CHANGED} ${error.message}`, error: error.error }))
          : Effect.fail(error),
      ),
    )
  })

const key = (absolute: string) => path.resolve(absolute)

/**
 * Remember the real path checked for `absolute` and, when it is an existing file, its device and inode now, so
 * the open is compared with the file that was checked and never looked up by path again. A second, different
 * answer makes the entry always refused.
 */
export const record = (absolute: string, real: string) =>
  Effect.gen(function* () {
    const registry = yield* Expected
    if (registry === undefined) return
    const info = yield* Effect.promise(() => fs.stat(real, { bigint: true }).catch(() => undefined))
    const link = yield* Effect.promise(async () => {
      if (!(await fs.lstat(absolute).catch(() => undefined))?.isSymbolicLink()) return undefined
      const dir = path.dirname(path.resolve(absolute))
      return { linkParent: (await fs.realpath(dir).catch(() => undefined)) === dir ? dir : undefined }
    })
    const base: Entry = info?.isFile() ? { real, id: { dev: info.dev, ino: info.ino } } : { real }
    const entry: Entry = link === undefined ? base : { ...base, link: true, linkParent: link.linkParent }
    const existing = registry.paths.get(key(absolute))
    const agrees =
      existing === undefined ||
      (existing !== CONFLICT &&
        existing.real === entry.real &&
        existing.id?.dev === entry.id?.dev &&
        existing.id?.ino === entry.id?.ino &&
        existing.link === entry.link &&
        existing.linkParent === entry.linkParent)
    registry.paths.set(key(absolute), agrees ? entry : CONFLICT)
  })

/** What was checked for `absolute` in this tool call, or `undefined` when nothing was (not verified). */
export const expected = (absolute: string) =>
  Effect.gen(function* (): Effect.fn.Return<Entry | undefined> {
    const found = (yield* Expected)?.paths.get(key(absolute))
    return found === CONFLICT ? { real: KeteRealPath.UNRESOLVED } : found
  })

const same = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right

/**
 * The descriptor is the file that was checked. A file that existed at the check is compared by identity only
 * (no path lookup after the open, which a process swapping folders could fool); a file created since falls back
 * to the path: `value` still leads to the checked real path and that is the opened file. Bigint: Windows file
 * indexes exceed 2^53; an index of 0 (some network and FAT volumes) proves nothing and is refused.
 */
const verify = async (opened: BigIntStats, value: string, entry: Entry) => {
  const expectedPath = entry.real
  if (!opened.isFile()) throw new ChangedError(value, expectedPath, "it is not a regular file")
  if (entry.id !== undefined) {
    if (entry.id.ino === 0n || opened.ino === 0n) throw new ChangedError(value, expectedPath, "this volume has no file identity")
    if (opened.dev !== entry.id.dev || opened.ino !== entry.id.ino)
      throw new ChangedError(value, expectedPath, "the opened file is not the one that was checked")
    return opened
  }
  const real = await fs.realpath(value).catch((cause: unknown) => {
    throw new ChangedError(value, expectedPath, `realpath failed (${(cause as NodeJS.ErrnoException)?.code})`)
  })
  if (!same(real, expectedPath)) throw new ChangedError(value, expectedPath, "it no longer leads to the checked file")
  const now = await fs.stat(real, { bigint: true }).catch((cause: unknown) => {
    throw new ChangedError(value, expectedPath, `stat failed (${(cause as NodeJS.ErrnoException)?.code})`)
  })
  if (now.dev !== opened.dev || now.ino !== opened.ino)
    throw new ChangedError(value, expectedPath, "the opened file is not the one at that path")
  return opened
}

const code = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.code

/** A write through a hard link would change every other name of the file, some perhaps outside the workspace. */
const single = (opened: BigIntStats) => {
  if (opened.nlink > 1n) throw new Error("it has other hard links; refused to write it")
}

/** A swapped link was found: remember it for the tool's message, log it and fail `Failed`. */
const changed = (value: string, entry: Entry, cause: ChangedError) =>
  Effect.gen(function* () {
    const registry = yield* Expected
    if (registry !== undefined) registry.changed = true
    yield* Effect.logWarning(`Refused to open ${value}: it is no longer the checked ${entry.real}`)
    return yield* new Failed({ path: value, cause })
  })

const unsupported = (value: string, reason: string) =>
  new Failed({ path: value, cause: new Error(`Kete Code can't open ${value} without following symbolic links here (${reason}); refused.`) })

const run = <A>(value: string, entry: Entry, body: () => Promise<A>, missing: boolean) =>
  Effect.tryPromise({ try: body, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (cause instanceof ChangedError) return yield* changed(value, entry, cause)
        if (missing && (code(cause) === "ENOENT" || code(cause) === "ENOTDIR")) return yield* new NotFound({ path: value })
        return yield* new Failed({ path: value, cause })
      }),
    ),
  )

// Non-blocking where it exists: a FIFO swapped in after the driver's type check must not hang the open.
const READ_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)

interface ReadResult {
  readonly info: { readonly type: "file"; readonly size: number; readonly mtimeMs: number }
  readonly bytes: Uint8Array
}
interface Range {
  readonly offset: number
  readonly length: number
}

const readIdentity = async (value: string, entry: Entry, range?: Range): Promise<ReadResult> => {
  const handle = await fs.open(value, READ_FLAGS)
  try {
    const opened = await verify(await handle.stat({ bigint: true }), value, entry)
    const info = { type: "file" as const, size: Number(opened.size), mtimeMs: Number(opened.mtimeNs) / 1e6 }
    if (range === undefined) return { info, bytes: await handle.readFile() }
    const buffer = new Uint8Array(range.length)
    const result = await handle.read(buffer, 0, range.length, range.offset)
    return { info, bytes: buffer.subarray(0, result.bytesRead) }
  } finally {
    await handle.close()
  }
}

const writeIdentity = async (value: string, entry: Entry, bytes: Uint8Array) => {
  const expectedPath = entry.real
  let created = false
  const handle = await fs.open(value, "r+").catch(async (cause: unknown) => {
    if (code(cause) !== "ENOENT") throw cause
    await fs.mkdir(path.dirname(value), { recursive: true })
    created = true
    return fs.open(expectedPath, "wx+").catch((error: unknown) => {
      if (code(error) === "EEXIST") throw new ChangedError(value, expectedPath, "it appeared while it was being created")
      throw error
    })
  })
  try {
    const opened = await verify(await handle.stat({ bigint: true }), value, entry).catch(async (error: unknown) => {
      if (created) await discardIdentity(handle, expectedPath)
      throw error
    })
    if (!created) single(opened)
    await handle.truncate(0)
    for (let done = 0; done < bytes.length; ) {
      done += (await handle.write(bytes, done, bytes.length - done, done)).bytesWritten
    }
  } finally {
    await handle.close()
  }
}

/** Remove a file this call just created, only if `expectedPath` still is that file; otherwise leave it. */
const discardIdentity = async (handle: FileHandle, expectedPath: string) => {
  const mine = await handle.stat({ bigint: true })
  const there = await fs.lstat(expectedPath, { bigint: true }).catch(() => undefined)
  if (there !== undefined && there.dev === mine.dev && there.ino === mine.ino) await fs.unlink(expectedPath).catch(() => undefined)
}

// ---- no-follow I/O (Linux, macOS) ----

type NoFollow = Extract<Platform, { kind: "nofollow" }>

const callback = <A>(call: (done: (error: NodeJS.ErrnoException | null, value: A) => void) => void) =>
  new Promise<A>((resolve, reject) => call((error, value) => (error ? reject(error) : resolve(value))))
const fstatOf = (fd: number) => callback<BigIntStats>((done) => fsFstat(fd, { bigint: true }, done))

const REASONS: Readonly<Record<string, string>> = {
  EACCES: "permission denied (on macOS Kete Code also needs read permission on every folder it opens or creates in)",
}
/** A failed syscall as an error with its errno `code`; the message says what to do for the cases users hit. */
const errorFor = (reason: string) => Object.assign(new Error(REASONS[reason] === undefined ? reason : `${reason}: ${REASONS[reason]}`), { code: reason })

/** The descriptor of an `Outcome`, or the error the driver reports for it. The caller closes the descriptor. */
const descriptor = (value: string, entry: Entry, outcome: KeteConfinedFs.Outcome<number>): number => {
  switch (outcome.kind) {
    case "ok":
      return outcome.value
    case "missing":
      throw errorFor("ENOENT")
    case "refused":
      throw new ChangedError(value, entry.real, "a symbolic link is in the way")
    case "wrongKind":
      throw new ChangedError(value, entry.real, "it is not a regular file")
    case "failed":
      throw errorFor(outcome.reason)
  }
}

/** `UNRESOLVED` and `{ real: "never" }` are not paths: never open them. */
const absolute = (value: string, entry: Entry) => {
  if (!path.isAbsolute(entry.real)) throw new ChangedError(value, entry.real, "the checked path is not usable")
}

const readNoFollow = async (platform: NoFollow, value: string, entry: Entry, range?: Range): Promise<ReadResult> => {
  absolute(value, entry)
  const F = platform.root.sys.flags
  const fd = descriptor(value, entry, platform.ops.open(entry.real, F.O_RDONLY | F.O_NOCTTY | F.O_NONBLOCK))
  try {
    const opened = await verify(await fstatOf(fd), value, entry)
    const info = { type: "file" as const, size: Number(opened.size), mtimeMs: Number(opened.mtimeNs) / 1e6 }
    if (range === undefined) return { info, bytes: await callback<Buffer>((done) => fsReadFile(fd, done)) }
    const buffer = new Uint8Array(range.length)
    const count = await callback<number>((done) => fsRead(fd, buffer, 0, range.length, range.offset, done))
    return { info, bytes: buffer.subarray(0, count) }
  } finally {
    platform.root.sys.close(fd)
  }
}

const writeNoFollow = async (platform: NoFollow, value: string, entry: Entry, bytes: Uint8Array) => {
  absolute(value, entry)
  const { ops, root } = platform
  const F = root.sys.flags
  let created = false
  let opened = ops.open(entry.real, F.O_WRONLY | F.O_NOCTTY | F.O_NONBLOCK)
  if (opened.kind === "missing") {
    if (entry.id !== undefined) throw new ChangedError(value, entry.real, "the checked file is gone")
    created = true
    opened = ops.create(entry.real, 0o666)
    if (opened.kind === "failed" && opened.reason === "EEXIST")
      throw new ChangedError(value, entry.real, "it appeared while it was being created")
  }
  const fd = descriptor(value, entry, opened)
  try {
    const stat = await verify(await fstatOf(fd), value, entry).catch(async (error: unknown) => {
      if (created) await discardNoFollow(platform, fd, entry.real)
      throw error
    })
    if (!created) single(stat)
    await callback<void>((done) => fsFtruncate(fd, 0, (error) => done(error, undefined)))
    for (let done = 0; done < bytes.length; ) {
      done += await callback<number>((next) => fsWrite(fd, bytes, done, bytes.length - done, done, next))
    }
  } finally {
    root.sys.close(fd)
  }
}

/** Best effort, like `discardIdentity`: unlink the file this call created if `real` still is it; any error leaves it. */
const discardNoFollow = async ({ ops, root }: NoFollow, fd: number, real: string) => {
  const F = root.sys.flags
  try {
    const mine = await fstatOf(fd)
    const there = ops.open(real, F.O_PATH | F.O_NOFOLLOW)
    if (there.kind !== "ok") return
    const theirs = await fstatOf(there.value).finally(() => root.sys.close(there.value))
    if (theirs.dev !== mine.dev || theirs.ino !== mine.ino) return
    const dir = ops.open(path.dirname(real), F.O_PATH | F.O_DIRECTORY)
    if (dir.kind !== "ok") return
    try {
      root.sys.unlinkat(dir.value, path.basename(real), 0)
    } finally {
      root.sys.close(dir.value)
    }
  } catch {
    // The file stays; the verification error that got us here is what the caller reports.
  }
}

/** Read `value` through a descriptor proven to be the checked file. */
export const read = (value: string, entry: Entry, range?: Range) =>
  Effect.gen(function* () {
    const platform = yield* CurrentPlatform
    if (platform.kind === "unsupported") return yield* unsupported(value, platform.reason)
    return yield* run(
      value,
      entry,
      platform.kind === "identity" ? () => readIdentity(value, entry, range) : () => readNoFollow(platform, value, entry, range),
      true,
    )
  })

/**
 * Write `bytes` to `value` through a descriptor proven to be the file at `entry.real`; nothing is truncated
 * before that. A missing file is created exclusively at `entry.real` (never through a final symlink).
 */
export const write = (value: string, entry: Entry, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const platform = yield* CurrentPlatform
    if (platform.kind === "unsupported") return yield* unsupported(value, platform.reason)
    return yield* run(
      value,
      entry,
      platform.kind === "identity" ? () => writeIdentity(value, entry, bytes) : () => writeNoFollow(platform, value, entry, bytes),
      false,
    ).pipe(
      // `missing` is false, so NotFound can't occur; narrow the type to the driver's contract.
      Effect.catchTag("Environment.NotFound", (cause) => Effect.fail(new Failed({ path: value, cause }))),
    )
  })

/** The entries of a checked folder, listed without following a swapped link; `undefined` when the platform has no no-follow layer (use the upstream listing). */
export const list = (value: string, entry: Entry) =>
  Effect.gen(function* () {
    const platform = yield* CurrentPlatform
    if (platform.kind === "identity") return undefined
    if (platform.kind === "unsupported") return yield* unsupported(value, platform.reason)
    if (!path.isAbsolute(entry.real)) return yield* changed(value, entry, new ChangedError(value, entry.real, "the checked path is not usable"))
    const result = yield* Effect.promise(() => platform.ops.list(entry.real))
    switch (result.kind) {
      case "ok":
        return result.value
      case "missing":
        return yield* new NotFound({ path: value })
      case "wrongKind":
        return yield* new WrongKind({ path: value, actual: result.actual })
      case "refused":
        return yield* changed(value, entry, new ChangedError(value, entry.real, "a symbolic link is in the way"))
      case "failed":
        return yield* new Failed({ path: value, cause: errorFor(result.reason) })
    }
  })

/**
 * Delete a checked file with `unlinkat(…, 0)` under a no-follow parent; `true` when handled, `false` when the
 * caller should use the upstream delete. A folder is never deleted (EISDIR on Linux, EPERM on macOS), and a
 * path that is itself a symbolic link is refused (the checked real path is the link's target, not the link).
 */
export const remove = (value: string, entry: Entry) =>
  Effect.gen(function* () {
    const platform = yield* CurrentPlatform
    if (platform.kind === "identity") return false
    if (platform.kind === "unsupported") return yield* unsupported(value, platform.reason)
    // Decided from the check, not from the path now (a swap since could turn a link into a file or back): a path
    // checked as a link is deleted as an entry of the folder that held it (unlinkat never follows the last component).
    if (entry.link === true && entry.linkParent === undefined)
      return yield* new Failed({ path: value, cause: new Error("refused to delete a symbolic link inside a linked folder") })
    const target = entry.linkParent !== undefined ? { real: path.join(entry.linkParent, path.basename(value)) } : entry
    yield* run(value, target, () => removeNoFollow(platform, value, target), false).pipe(
      // `missing` is false, so NotFound can't occur; narrow the type to the driver's contract.
      Effect.catchTag("Environment.NotFound", (cause) => Effect.fail(new Failed({ path: value, cause }))),
    )
    return true
  })

const removeNoFollow = async ({ ops, root }: NoFollow, value: string, entry: Entry) => {
  absolute(value, entry)
  const F = root.sys.flags
  const E = KeteLinuxFfi.errno
  const parent = ops.open(path.dirname(entry.real), F.O_PATH | F.O_DIRECTORY)
  if (parent.kind === "missing") return // nothing to delete
  const dirfd = descriptor(value, entry, parent)
  try {
    const gone = root.sys.unlinkat(dirfd, path.basename(entry.real), 0)
    if (gone.ok || gone.errno === E.ENOENT) return
    if (gone.errno === E.EISDIR || gone.errno === E.EPERM)
      throw Object.assign(new Error(`${KeteLinuxFfi.errnoName(gone.errno)}: only files are deleted here, not folders (or the file may not be deleted)`), {
        code: KeteLinuxFfi.errnoName(gone.errno),
      })
    throw errorFor(KeteLinuxFfi.errnoName(gone.errno))
  } finally {
    root.sys.close(dirfd)
  }
}

/**
 * Whether the formatter may run on `value`: a checked file is formatted only if `value` still resolves to the
 * checked real path just before the formatter starts, and that real path still opens as a regular file without
 * following links.
 * shortcut: the formatter rewrites by path, so a swap during its own spawn (milliseconds) is not covered;
 * disable formatting in Work sessions if the security review asks.
 */
export const formattable = (value: string) =>
  Effect.gen(function* () {
    const checked = yield* expected(value)
    if (checked === undefined) return true
    const platform = yield* CurrentPlatform
    if (platform.kind === "identity") return true
    const refused = (why: string) => Effect.logWarning(`Not formatting ${value}: ${why}`).pipe(Effect.as(false))
    if (platform.kind === "unsupported") return yield* refused(platform.reason)
    if (!path.isAbsolute(checked.real)) return yield* refused("the checked path is not usable")
    // The formatter opens the path itself, following links: it must still lead to the checked file now. A link that
    // was there at the check (a linked workspace folder, macOS /var) is fine as long as it still leads there.
    const now = yield* Effect.promise(() => fs.realpath(value).catch(() => undefined))
    if (now === undefined || !same(now, checked.real)) return yield* refused("it no longer leads to the checked file")
    // A hard link to an outside file swapped in after the write keeps the same path but has two links.
    const links = yield* Effect.promise(() => fs.lstat(checked.real, { bigint: true }).then((info) => info.nlink, () => undefined))
    if (links !== 1n) return yield* refused("it has other hard links")
    const info = yield* Effect.promise(() => platform.ops.stat(checked.real))
    if (info.kind === "ok" && info.value.type === "file") return true
    return yield* refused(info.kind === "failed" ? info.reason : `it is no longer a regular file without links in its path (${info.kind})`)
  })
