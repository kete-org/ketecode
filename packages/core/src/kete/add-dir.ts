// Extra working directories (`--add-dir`, `/add-dir`; docs/permissions.md): a session may be given
// folders outside its workspace, kept in the session metadata under `kete.dirs`. This module is the
// rules: what folders may be added (`validate`), the guard the session service runs on every metadata
// write (`guard`), and reading a session's folders (`dirs`). The permission grant, the `/add-dir`
// command and the RPC are in add-dir-plugin.ts (kept apart: the session service imports this file,
// so it must not import the session).
//
// Folders are stored as real paths. A folder can't be: a file-system root, the home folder or a folder
// above it, a credential folder or Kete Code's own, or anything inside the workspace; at most `MAX`.
// Job mode (cloud and self-hosted jobs) has one workspace, so adding is always refused there.

export * as KeteAddDir from "./add-dir.js"

import path from "path"
import type { Permission } from "@opencode/schema/permission"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Effect, Option } from "effect"
import { Project } from "../project.js"
import { AbsolutePath } from "../schema.js"
import type { SessionSchema } from "../session/schema.js"
import { SECRET_HOME_DIRS } from "./memory-imports.js"

export const metadataKey = "kete.dirs"
export const MAX = 10

/** Longest ancestor chain followed when looking for the root session's folders. */
const MAX_DEPTH = 32

export class RefusedError extends Error {
  constructor(reason: string) {
    super(`Can't change this session's "${metadataKey}": ${reason}`)
    this.name = "KeteAddDirRefusedError"
  }
}

type Files = Pick<FSUtil.Interface, "existsSafe" | "resolve" | "isDir">

/** Real paths of what a folder is checked against. */
export interface Context {
  /** Relative paths are resolved from here (the location's directory). */
  readonly base: string
  readonly home: string
  readonly workspace: ReadonlyArray<string>
  /** Kete Code's own folders (global config, data, state, cache). */
  readonly kete: ReadonlyArray<string>
  /** Folders accepted already (counted against `MAX`, and an exact repeat is not an error). */
  readonly existing: ReadonlyArray<string>
}

export type Result = { readonly ok: true; readonly real: string } | { readonly ok: false; readonly reason: string }

const no = (reason: string): Result => ({ ok: false, reason })

/** Everything but `existing`, for a location. Real paths: a symlinked workspace or home still matches. */
export const context = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string) {
  const root = yield* Project.root(fs, AbsolutePath.make(directory))
  const workspace = (yield* Effect.forEach([directory, ...(root === undefined ? [] : [root])], (value) => fs.resolve(value))).filter(
    // A project at "/" must not make every folder "inside the workspace".
    (value) => path.dirname(value) !== value,
  )
  return {
    base: directory,
    home: yield* fs.resolve(Global.Path.home),
    workspace,
    kete: yield* Effect.forEach([Global.Path.config, Global.Path.data, Global.Path.state, Global.Path.cache], (value) => fs.resolve(value)),
  } satisfies Omit<Context, "existing">
})

// Same expansion as FileAccess.resolvePath (`~`, Windows shell paths); not imported from there because
// the session service imports this file and file-access.ts imports the permission service.
const expand = (base: string, input: string, home: string) => {
  const normalized = FSUtil.windowsPath(input)
  return path.resolve(
    base,
    normalized === "~"
      ? home
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(home, normalized.slice(2))
        : normalized,
  )
}

/** Whether one path may be added; the real path on success. Never touches the file system beyond reading it. */
export const validate = Effect.fnUntraced(function* (fs: Files, input: string, ctx: Context) {
  if (KeteJobMode.enabled()) return no("adding folders isn't available in a job: a job has one workspace")
  if (input.trim() === "") return no("the path is empty")
  const target = expand(ctx.base, input, ctx.home)
  if (!(yield* fs.existsSafe(target))) return no(`${input} doesn't exist`)
  const real = yield* fs.resolve(target)
  if (!(yield* fs.isDir(real))) return no(`${input} isn't a folder`)
  if (path.dirname(real) === real) return no(`${input} is a file-system root`)
  if (FSUtil.contains(real, ctx.home)) return no(`${input} is your home folder or contains it`)
  if (SECRET_HOME_DIRS.some((dir) => FSUtil.overlaps(real, path.join(ctx.home, dir))))
    return no(`${input} is or contains a folder of credentials`)
  if (ctx.kete.some((dir) => FSUtil.overlaps(real, dir))) return no(`${input} is or contains Kete Code's own folders`)
  if (ctx.workspace.some((dir) => FSUtil.contains(dir, real))) return no(`${input} is inside the workspace already`)
  if (ctx.existing.includes(real)) return { ok: true, real } satisfies Result
  if (ctx.existing.length >= MAX) return no(`a session can have at most ${MAX} extra folders`)
  return { ok: true, real } satisfies Result
})

/** The valid folder list in a metadata value (anything else is no folders). */
export const parse = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/**
 * The metadata to store for a write: `next`, with `kete.dirs` (when present) checked and rewritten as
 * real paths. Entries `before` already had pass unchanged; every new one goes through `validate`. A
 * refusal is a defect (`RefusedError`), the way `KeteUnattendedPolicy.guardMetadata` refuses: session
 * hooks can't fail a write, so the service calls this itself.
 */
export const guard = Effect.fnUntraced(function* (
  fs: Files,
  context: Effect.Effect<Omit<Context, "existing">>,
  before: SessionSchema.Metadata | undefined,
  next: SessionSchema.Metadata,
) {
  if (!(metadataKey in next)) return next
  const ctx = yield* context
  const value: unknown = next[metadataKey]
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    return yield* Effect.die(new RefusedError("it must be a list of folder paths"))
  if (value.length > MAX) return yield* Effect.die(new RefusedError(`a session can have at most ${MAX} extra folders`))
  const kept = parse(before?.[metadataKey])
  const accepted: string[] = []
  for (const entry of value as string[]) {
    if (kept.includes(entry) && !KeteJobMode.enabled()) {
      if (!accepted.includes(entry)) accepted.push(entry)
      continue
    }
    const result = yield* validate(fs, entry, { ...ctx, existing: accepted })
    if (!result.ok) return yield* Effect.die(new RefusedError(result.reason))
    if (!accepted.includes(result.real)) accepted.push(result.real)
  }
  return { ...next, [metadataKey]: accepted }
})

export interface Lookup {
  readonly session: (sessionID: SessionSchema.ID) => Effect.Effect<Option.Option<SessionSchema.Info>>
}

/** The folders of the root-most session in `sessionID`'s family that has any (a subagent shares its root's). */
export const dirs = Effect.fnUntraced(function* (lookup: Lookup, sessionID: SessionSchema.ID) {
  let found: string[] = []
  let current: SessionSchema.ID | undefined = sessionID
  for (let depth = 0; current !== undefined && depth <= MAX_DEPTH; depth++) {
    const session: Option.Option<SessionSchema.Info> = yield* lookup.session(current)
    if (Option.isNone(session)) break
    const own = parse(session.value.metadata?.[metadataKey])
    if (own.length > 0) found = own
    current = session.value.parentID
  }
  return found
})

const slash = (value: string) => value.replaceAll("\\", "/")

/** Allow rules for the folders, for the subagent ceiling (permission-ceiling.ts), which only tightens. */
export const rules = (folders: ReadonlyArray<string>): Permission.Rule[] =>
  folders.flatMap((folder): Permission.Rule[] => [
    { action: "external_directory", resource: slash(folder), effect: "allow" },
    { action: "external_directory", resource: slash(folder) + "/*", effect: "allow" },
  ])
