// `skills.lock.json` v1, beside the `skills/` folder `kete skill add` installs into: per skill, where it
// came from, the resolved commit and the SHA-256 of each file. A file this version can't read is
// refused, never overwritten. Writes re-read just before writing and replace the file atomically, so
// two installs at once keep each other's entries.

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

export const Entry = Schema.Struct({
  source: Schema.String,
  path: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  files: Schema.Record(Schema.String, Schema.String),
  installedAt: Schema.String,
})
export type Entry = typeof Entry.Type

export const Lock = Schema.Struct({ version: Schema.Literal(1), skills: Schema.Record(Schema.String, Entry) })
export type Lock = typeof Lock.Type

export const file = (scope: string) => path.join(scope, "skills.lock.json")

/** The lockfile (empty when there is none); throws when it is unreadable or not a v1 lockfile. */
export async function read(scope: string): Promise<Lock> {
  const location = file(scope)
  const text = await readFile(location, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return { version: 1, skills: {} }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Lock))(text)
  if (decoded._tag === "None") throw new Error(`${location} is not a version 1 skills lockfile; not changing it`)
  return decoded.value
}

async function update(scope: string, change: (skills: Record<string, Entry>) => void) {
  const lock = await read(scope)
  const skills = { ...lock.skills }
  change(skills)
  await mkdir(scope, { recursive: true, mode: 0o700 })
  const temporary = `${file(scope)}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ version: 1, skills }, null, 2) + "\n", { mode: 0o600 })
  await renameRetry(temporary, file(scope)).catch(async (error: unknown) => {
    await rm(temporary, { force: true })
    throw error
  })
}

export const upsert = (scope: string, name: string, entry: Entry) =>
  update(scope, (skills) => {
    skills[name] = entry
  })

export const remove = (scope: string, name: string) =>
  update(scope, (skills) => {
    delete skills[name]
  })

/** Files added, removed and changed between two `{path: sha256}` maps. */
export function diff(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>) {
  const names = (keep: (name: string) => boolean, from: Readonly<Record<string, string>>) => Object.keys(from).filter(keep).toSorted()
  return {
    added: names((name) => !(name in before), after),
    removed: names((name) => !(name in after), before),
    changed: names((name) => name in before && before[name] !== after[name], after),
  }
}

/** On Windows a rename can briefly fail with EPERM/EBUSY/EACCES (antivirus, an open reader); retry a few times. */
export async function renameRetry(from: string, to: string, attempt = 0): Promise<void> {
  return rename(from, to).catch(async (error: NodeJS.ErrnoException) => {
    if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error
    await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    return renameRetry(from, to, attempt + 1)
  })
}

export * as KeteSkillLock from "./skill-lock.js"
