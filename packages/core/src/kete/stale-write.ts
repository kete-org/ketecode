// Stops a session overwriting a file whose current version it hasn't seen. With agents working in
// parallel (subagents, several sessions in one checkout), a whole-file `write` based on an old
// read silently discards whatever another agent or the user changed since.
//
// Each session's reads, writes, edits and patches record a fingerprint (SHA-256) of the file as it
// then was. `write` to an existing file is refused unless the file still matches the session's
// last fingerprint of it: "read it again first". `edit` and `patch` aren't checked: they match on
// the surrounding text, so they already fail rather than clobber when that text changed.
//
// Files larger than 5 MiB aren't fingerprinted, and so aren't protected. Fingerprints live in
// memory, per location, bounded to the most recent 5000; after a restart a session reads again.

export * as KeteStaleWrite from "./stale-write.js"

import { createHash } from "node:crypto"
import { Tool } from "@opencode/schema/tool"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Effect, Predicate } from "effect"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"

export const MAX_BYTES = 5 * 1024 * 1024
export const MAX_ENTRIES = 5000

/** "missing": no file; "untracked": too large or not a regular file. */
export type Fingerprint = string | "missing" | "untracked"

/** The latest fingerprint each session has seen of each file, least recently used first. */
export class Seen {
  private readonly entries = new Map<string, string>()

  constructor(private readonly limit = MAX_ENTRIES) {}

  private key(sessionID: string, file: string) {
    return `${sessionID}\u0000${file}`
  }

  get(sessionID: string, file: string) {
    return this.entries.get(this.key(sessionID, file))
  }

  set(sessionID: string, file: string, fingerprint: Fingerprint) {
    const key = this.key(sessionID, file)
    this.entries.delete(key)
    if (fingerprint === "missing" || fingerprint === "untracked") return
    this.entries.set(key, fingerprint)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break
      this.entries.delete(oldest)
    }
  }
}

/** Why a write of `current` by a session that last saw `seen` must not go ahead, if it mustn't. */
export function refusal(path: string, current: Fingerprint, seen: string | undefined) {
  if (current === "missing" || current === "untracked" || current === seen) return undefined
  if (seen === undefined)
    return `${path} already exists and this session hasn't read it. Read it first, then write it, or use edit for a partial change.`
  return `${path} changed since this session last read it (another agent or the user edited it). Read it again before overwriting it.`
}

const stringField = (input: unknown, field: string) =>
  Predicate.isObject(input) && Predicate.hasProperty(input, field) && typeof input[field] === "string"
    ? input[field]
    : undefined

export const Plugin = {
  id: "kete.stale-write",
  effect: Effect.fn("KeteStaleWrite.Plugin")(function* (ctx: PluginContext) {
    const access = yield* FileAccess.Service
    const environment = yield* Environment.Service
    const seen = new Seen()

    const fingerprint = (absolute: string): Effect.Effect<Fingerprint> =>
      Effect.gen(function* () {
        const info = yield* environment.files.stat(absolute)
        if (info.type !== "file" || info.size > MAX_BYTES) return "untracked" as const
        const { bytes } = yield* environment.files.read(absolute)
        return createHash("sha256").update(bytes).digest("hex")
      }).pipe(
        Effect.catchTag("Environment.NotFound", () => Effect.succeed("missing" as const)),
        Effect.catch(() => Effect.succeed("untracked" as const)),
      )

    const absolute = (path: string) =>
      access.resolve({ path, kind: "file" }).pipe(
        Effect.map((target): string => target.absolute),
        Effect.option,
      )

    const remember = (sessionID: string, file: string) =>
      fingerprint(file).pipe(Effect.map((current) => seen.set(sessionID, file, current)))

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (event.tool !== "write") return
        const path = stringField(event.input, "path")
        if (path === undefined) return
        const file = yield* absolute(path)
        if (file._tag === "None") return
        const message = refusal(path, yield* fingerprint(file.value), seen.get(event.sessionID, file.value))
        if (message !== undefined) return yield* new Tool.Error({ message })
      }),
    )

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.status !== "completed") return
        if (event.tool === "read" || event.tool === "edit") {
          const path = stringField(event.input, "path")
          const file = path === undefined ? undefined : yield* absolute(path)
          if (file?._tag === "Some") yield* remember(event.sessionID, file.value)
          return
        }
        if (event.tool === "write") {
          const target = stringField(event.result.output, "target")
          if (target !== undefined) yield* remember(event.sessionID, target)
          return
        }
        if (event.tool === "patch") {
          const output = event.result.output
          const applied = Predicate.isObject(output) && Array.isArray(output.applied) ? output.applied : []
          for (const item of applied) {
            const target = stringField(item, "target")
            if (target !== undefined) yield* remember(event.sessionID, target)
          }
        }
      }),
    )
  }),
}
