// The file tools (read, write, edit, patch) check a path with `FileAccess.resolve` (symlinks followed, inside
// or outside the workspace, permission asked) and open it later by that same path. A process that can
// change the folder in between (a symlink swapped in after the check) would make the open land on a file the
// check never saw (time-of-check/time-of-use). So `FileAccess.resolve` records the real path it checked for
// the current tool call (`record`), and the local driver (environment/local.ts) opens the file, then proves the
// descriptor is the file at that real path (`read`, `write`); on any mismatch nothing is read or written.
// Raw node:fs, like the local driver it is called from (the only caller; nothing above the environment seam
// touches it). No O_NOFOLLOW or other POSIX-only flag, so Windows runs the same code.

export * as KeteVerifiedOpen from "./verified-open.js"

import { ToolFailure } from "@opencode/ai/effect"
import { Context, Effect } from "effect"
import { constants } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Failed, NotFound } from "../environment/files.js"
import { KeteRealPath } from "./real-path.js"

export const CONFLICT = Symbol("conflict")

/** What `FileAccess.resolve` checked: the real path and, for an existing file, its identity at that moment. */
export interface Entry {
  readonly real: string
  readonly id?: { readonly dev: bigint; readonly ino: bigint }
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
    const entry: Entry = info?.isFile() ? { real, id: { dev: info.dev, ino: info.ino } } : { real }
    const existing = registry.paths.get(key(absolute))
    const agrees =
      existing === undefined ||
      (existing !== CONFLICT && existing.real === entry.real && existing.id?.dev === entry.id?.dev && existing.id?.ino === entry.id?.ino)
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
const verify = async (handle: FileHandle, value: string, entry: Entry) => {
  const expectedPath = entry.real
  const opened = await handle.stat({ bigint: true })
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
  if (!same(real, expectedPath)) throw new ChangedError(value, expectedPath, `it now leads to ${real}`)
  const now = await fs.stat(real, { bigint: true }).catch((cause: unknown) => {
    throw new ChangedError(value, expectedPath, `stat failed (${(cause as NodeJS.ErrnoException)?.code})`)
  })
  if (now.dev !== opened.dev || now.ino !== opened.ino)
    throw new ChangedError(value, expectedPath, "the opened file is not the one at that path")
  return opened
}

const code = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.code

const run = <A>(value: string, entry: Entry, body: () => Promise<A>, missing: boolean) =>
  Effect.tryPromise({ try: body, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (cause instanceof ChangedError) {
          const registry = yield* Expected
          if (registry !== undefined) registry.changed = true
          yield* Effect.logWarning(`Refused to open ${value}: it is no longer the checked ${entry.real}`)
          return yield* new Failed({ path: value, cause })
        }
        if (missing && (code(cause) === "ENOENT" || code(cause) === "ENOTDIR")) return yield* new NotFound({ path: value })
        return yield* new Failed({ path: value, cause })
      }),
    ),
  )

// Non-blocking where it exists: a FIFO swapped in after the driver's type check must not hang the open.
const READ_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)

/** Read `value` through a descriptor proven to be the checked file. */
export const read = (value: string, entry: Entry, range?: { readonly offset: number; readonly length: number }) =>
  run(
    value,
    entry,
    async () => {
      const handle = await fs.open(value, READ_FLAGS)
      try {
        const opened = await verify(handle, value, entry)
        const info = { type: "file" as const, size: Number(opened.size), mtimeMs: Number(opened.mtimeNs) / 1e6 }
        if (range === undefined) return { info, bytes: await handle.readFile() }
        const buffer = new Uint8Array(range.length)
        const result = await handle.read(buffer, 0, range.length, range.offset)
        return { info, bytes: buffer.subarray(0, result.bytesRead) }
      } finally {
        await handle.close()
      }
    },
    true,
  )

/**
 * Write `bytes` to `value` through a descriptor proven to be the file at `expectedPath`; nothing is truncated
 * before that. A missing file is created exclusively at `expectedPath` (never through a final symlink).
 */
export const write = (value: string, entry: Entry, bytes: Uint8Array) =>
  run(
    value,
    entry,
    async () => {
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
        await verify(handle, value, entry).catch(async (error: unknown) => {
          if (created) await discard(handle, expectedPath)
          throw error
        })
        await handle.truncate(0)
        for (let done = 0; done < bytes.length; ) {
          done += (await handle.write(bytes, done, bytes.length - done, done)).bytesWritten
        }
      } finally {
        await handle.close()
      }
    },
    false,
    // `missing` is false, so NotFound can't occur; narrow the type to the driver's write contract.
  ).pipe(Effect.catchTag("Environment.NotFound", (cause) => Effect.fail(new Failed({ path: value, cause }))))

/** Remove a file this call just created, only if `expectedPath` still is that file; otherwise leave it. */
const discard = async (handle: FileHandle, expectedPath: string) => {
  const mine = await handle.stat({ bigint: true })
  const there = await fs.lstat(expectedPath, { bigint: true }).catch(() => undefined)
  if (there !== undefined && there.dev === mine.dev && there.ino === mine.ino) await fs.unlink(expectedPath).catch(() => undefined)
}
