// The last successful sync, per organization: <config>/managed/<organization id>/agents.json.
// Managed agents live apart from user-authored agents (<config>/agents, .kete/agents), and the whole
// response is one file: writing it replaces the set, so an agent the platform stopped returning is
// gone from the cache. Writes are atomic (a temporary file renamed over the old one), so a reader
// sees the previous set or the new one, never half a file.

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { SyncResponse } from "./contract.js"

export const Cached = Schema.Struct({
  // 1: the format before `delegable` (sync v1's "all" mapping, ADR 0017). A cached copy at 1 is
  // still read (it decodes the same way), but ./sync.ts never sends its ETag, so the next sync
  // fetches a fresh 200 rather than getting 304 for a delegable flag it stripped before it existed.
  version: Schema.Literals([1, 2]),
  /** The response's ETag, sent back as If-None-Match. */
  etag: Schema.String,
  /** When this copy was fetched (ISO 8601). */
  synced_at: Schema.String,
  response: SyncResponse,
})
export type Cached = typeof Cached.Type

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `id` is an organization GUID — the only thing allowed to become a directory name here. */
export function validOrganization(id: string) {
  return guid.test(id)
}

/** `join` is path.join; tests pass path.win32.join to check Windows paths on any platform. */
export function directory(config: string, organization: string, join: (...parts: string[]) => string = path.join) {
  // The id becomes a directory name: never let anything but a GUID near the filesystem.
  if (!validOrganization(organization)) throw new Error(`Invalid organization id: ${organization}`)
  return join(config, "managed", organization.toLowerCase())
}

export function file(config: string, organization: string) {
  return path.join(directory(config, organization), "agents.json")
}

/** The cached copy, or undefined when there is none. An unreadable or invalid file is reported, not ignored. */
export async function read(config: string, organization: string) {
  const location = file(config, organization)
  const text = await readFile(location, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Cached))(text)
  if (decoded._tag === "None") throw new Error(`${location} is not a valid managed-agent cache`)
  return decoded.value
}

export async function write(config: string, cached: Cached) {
  const target = file(config, cached.response.organization.id)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(cached, null, 2) + "\n", { mode: 0o600 })
  await replace(temporary, target).catch(async (error: unknown) => {
    await rm(temporary, { force: true })
    throw error
  })
}

/** Removes an organization's cache (after `kete logout`). */
export function remove(config: string, organization: string) {
  return rm(directory(config, organization), { recursive: true, force: true })
}

// On Windows, renaming over a file another process has open briefly fails with EPERM/EBUSY/EACCES
// (a reader, or an antivirus scan); a few short retries ride that out.
async function replace(from: string, to: string, attempt = 0): Promise<void> {
  return rename(from, to).catch(async (error: NodeJS.ErrnoException) => {
    if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error
    await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    return replace(from, to, attempt + 1)
  })
}

export * as KeteSyncCache from "./cache.js"
