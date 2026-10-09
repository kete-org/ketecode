// Which repositories' hooks the user trusts (kete/hooks.ts): one file in Kete Code's state
// directory, mapping a repository's real path to the fingerprint of the project hooks the user
// accepted (settings.ts `fingerprint`). Any change to those hooks gives a new fingerprint, so the user
// is asked again. Written atomically (temp file + rename), at most 500 repositories (oldest dropped);
// a file that can't be read or doesn't match the schema counts as "nothing trusted".

export * as KeteHooksTrust from "./trust.js"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"

export const FILE = "hooks-trust.json"
export const MAX_ENTRIES = 500

const Entry = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  commands: Schema.Array(Schema.String),
  trusted: Schema.Number,
})
const Store = Schema.Struct({
  version: Schema.Literal(1),
  repositories: Schema.Record(Schema.String, Entry),
})
type Store = typeof Store.Type

const decode = Schema.decodeUnknownOption(Store)

async function read(file: string): Promise<Store> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return { version: 1, repositories: {} }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { version: 1, repositories: {} }
  }
  const decoded = decode(value)
  return decoded._tag === "Some" ? decoded.value : { version: 1, repositories: {} }
}

export function make(stateDirectory: string) {
  const file = path.join(stateDirectory, FILE)
  // Writes are serialized within the process; the rename keeps a reader from seeing half a file.
  let queue: Promise<unknown> = Promise.resolve()

  return {
    file,
    async trusted(repository: string, fingerprint: string): Promise<boolean> {
      return (await read(file)).repositories[repository]?.fingerprint === fingerprint
    },
    trust(repository: string, fingerprint: string, commands: ReadonlyArray<string>): Promise<void> {
      const next = queue.then(async () => {
        const store = await read(file)
        const repositories = { ...store.repositories, [repository]: { fingerprint, commands: [...commands], trusted: Date.now() } }
        const kept = Object.entries(repositories)
          .sort(([, a], [, b]) => b.trusted - a.trusted)
          .slice(0, MAX_ENTRIES)
        await fs.mkdir(stateDirectory, { recursive: true })
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(temp, JSON.stringify({ version: 1, repositories: Object.fromEntries(kept) }, null, 2), { mode: 0o600 })
        await fs.rename(temp, file)
      })
      queue = next.catch(() => undefined)
      return next
    },
  }
}

export type Trust = ReturnType<typeof make>
