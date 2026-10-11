// A small trust store: one JSON file in Kete Code's state directory (outside any project's reach),
// `{ version: 1, <collection>: { <key>: <entry> } }`. Shared by the hooks trust store
// (core/src/kete/hooks/trust.ts, `hooks-trust.json`) and folder trust (./folder-trust-store.ts,
// `folder-trust.json`).
//
// - Fail closed: a missing, unreadable or malformed file, or one that doesn't match the schema, reads
//   as empty, so nothing is trusted.
// - Atomic: written to a temporary file created with mode 0600, then renamed over the store.
// - Capped: at most `max` entries; the oldest (by `trusted`) are dropped.
// - Writes are serialized within the process.

export * as KeteTrustStore from "./trust-store.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

export interface Options<E extends { readonly trusted: number }> {
  readonly stateDirectory: string
  readonly file: string
  /** The name of the map in the file (`repositories`, `folders`). */
  readonly collection: string
  readonly entry: Schema.Codec<E, unknown>
  readonly max: number
}

export function make<E extends { readonly trusted: number }>(options: Options<E>) {
  const file = path.join(options.stateDirectory, options.file)
  const decode = Schema.decodeUnknownOption(
    Schema.Struct({ version: Schema.Literal(1), [options.collection]: Schema.Record(Schema.String, options.entry) }),
  )
  let queue: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<Record<string, E>> => {
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) return {}
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return {}
    }
    const decoded = decode(value)
    if (decoded._tag !== "Some") return {}
    return (decoded.value as Record<string, unknown>)[options.collection] as Record<string, E>
  }

  const write = (change: (entries: Record<string, E>) => Record<string, E>): Promise<void> => {
    const next = queue.then(async () => {
      const kept = Object.entries(change(await read()))
        .sort(([, a], [, b]) => b.trusted - a.trusted)
        .slice(0, options.max)
      await fs.mkdir(options.stateDirectory, { recursive: true })
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await fs.writeFile(temp, JSON.stringify({ version: 1, [options.collection]: Object.fromEntries(kept) }, null, 2), {
          mode: 0o600,
          flag: "wx",
        })
        await fs.rename(temp, file)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    queue = next.catch(() => undefined)
    return next
  }

  return {
    file,
    /** Every entry (empty when the file is missing or invalid). */
    list: read,
    get: async (key: string): Promise<E | undefined> => {
      const entries = await read()
      return Object.hasOwn(entries, key) ? entries[key] : undefined
    },
    set: (key: string, entry: E) => write((entries) => ({ ...entries, [key]: entry })),
    remove: (key: string) =>
      write((entries) => {
        const { [key]: _removed, ...rest } = entries
        return rest
      }),
  }
}

export type Store<E extends { readonly trusted: number }> = ReturnType<typeof make<E>>

/** The hooks trust store's entry (core/src/kete/hooks/trust.ts): the fingerprint of the project hooks
 * accepted, their commands, and when. */
export const HooksEntry = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  commands: Schema.Array(Schema.String),
  trusted: Schema.Number,
})
export type HooksEntry = typeof HooksEntry.Type

/** `hooks-trust.json`: repositories' real paths to the project hooks the user trusts. */
export const hooks = (stateDirectory: string) =>
  make<HooksEntry>({ stateDirectory, file: "hooks-trust.json", collection: "repositories", entry: HooksEntry, max: 500 })
