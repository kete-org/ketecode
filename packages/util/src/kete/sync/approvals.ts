// Approved stdio MCP commands: <config>/managed/<organization id>/approved.json maps a server key to
// the SHA-256 of the exact command the developer approved (`kete sync --approve <key>`). A synced
// stdio server runs only while its command still matches; a changed command needs approval again.

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { KeteSyncCache } from "./cache.js"

const Approvals = Schema.Record(Schema.String, Schema.String)

export function file(config: string, organization: string) {
  return path.join(KeteSyncCache.directory(config, organization), "approved.json")
}

export function hash(command: string) {
  return createHash("sha256").update(command, "utf8").digest("hex")
}

export async function read(config: string, organization: string): Promise<Record<string, string>> {
  const text = await readFile(file(config, organization), "utf8").catch(() => undefined)
  if (text === undefined) return {}
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Approvals))(text)
  return decoded._tag === "Some" ? { ...decoded.value } : {}
}

export function approved(approvals: Readonly<Record<string, string>>, key: string, command: string) {
  return approvals[key] === hash(command)
}

export async function approve(config: string, organization: string, key: string, command: string) {
  const next = { ...(await read(config, organization)), [key]: hash(command) }
  const target = file(config, organization)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  await rename(temporary, target)
}

export * as KeteSyncApprovals from "./approvals.js"
