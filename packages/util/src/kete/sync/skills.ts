// Managed skills on disk: <config>/managed/<organization id>/skills/<slug>/
//   SKILL.md          the skill's instructions (from the sync response)
//   <files…>          its supporting files (GET /api/v1/sync/skills/{id}/files)
//   .kete-skill.json  what was written: id, version, and each file's SHA-256
// Files are downloaded only when the manifest's SHA-256s differ from what is on disk, and every
// downloaded file must match its SHA-256. A skill is written into a staging folder and swapped in
// whole, so a reader sees the old skill or the new one. Paths from the platform must stay inside
// the skill's folder. Files marked executable are written without the executable bit: running one
// then needs a shell command, which goes through the permission rules; nothing runs it on its own.

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { KeteSyncCache } from "./cache.js"
import { KeteSyncClient } from "./client.js"
import { SkillFilesResponse, type SyncedSkill } from "./contract.js"

const MANIFEST = ".kete-skill.json"

const Manifest = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  instructions: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
})
type Manifest = typeof Manifest.Type

export type Result = {
  readonly written: string[]
  readonly unchanged: string[]
  readonly removed: string[]
  readonly failed: Array<{ readonly slug: string; readonly error: string }>
}

export function directory(config: string, organization: string, join: (...parts: string[]) => string = path.join) {
  return join(KeteSyncCache.directory(config, organization, join), "skills")
}

/** The skill's folder; its SKILL.md is what the runtime registers. */
export function skillDirectory(config: string, organization: string, slug: string) {
  return path.join(directory(config, organization), slug)
}

/**
 * The platform's relative path as a safe relative path, or undefined when it would leave the skill's
 * folder (absolute, a drive letter, `..`, or empty segments). Backslashes count as separators.
 */
export function safeRelative(value: string) {
  const parts = value.replaceAll("\\", "/").split("/")
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return undefined
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined
  if (parts[0] === MANIFEST || (parts.length === 1 && parts[0]!.toLowerCase() === "skill.md")) return undefined
  return path.join(...parts)
}

/** Brings the skills on disk in line with `skills`: writes changed ones, removes the others. */
export async function sync(input: {
  config: string
  organization: string
  platform: string
  key: string
  skills: readonly SyncedSkill[]
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}): Promise<Result> {
  const root = directory(input.config, input.organization)
  const result: Result = { written: [], unchanged: [], removed: [], failed: [] }
  for (const skill of input.skills) {
    const target = path.join(root, skill.slug)
    const current = await readManifest(target)
    if (current && upToDate(current, skill)) {
      result.unchanged.push(skill.slug)
      continue
    }
    await write(input, skill, target, current).then(
      () => result.written.push(skill.slug),
      (error: unknown) => result.failed.push({ slug: skill.slug, error: error instanceof Error ? error.message : String(error) }),
    )
  }
  const keep = new Set(input.skills.map((skill) => skill.slug))
  const present = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of present) {
    if (!entry.isDirectory() || keep.has(entry.name) || entry.name.includes(".tmp-") || entry.name.includes(".old-"))
      continue
    await rm(path.join(root, entry.name), { recursive: true, force: true })
    result.removed.push(entry.name)
  }
  return result
}

/** Slugs of the skills fully on disk (written with a manifest). */
export async function present(config: string, organization: string) {
  const root = directory(config, organization)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const slugs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes(".tmp-") && !entry.name.includes(".old-"))
      .map(async (entry) => ((await readManifest(path.join(root, entry.name))) ? entry.name : undefined)),
  )
  return new Set(slugs.filter((slug): slug is string => slug !== undefined))
}

function upToDate(current: Manifest, skill: SyncedSkill) {
  if (current.id !== skill.id || current.version !== skill.version) return false
  if (current.instructions !== sha256(skill.instructions)) return false
  const wanted = Object.fromEntries(skill.files.map((file) => [file.path, file.sha256]))
  return JSON.stringify(sorted(current.files)) === JSON.stringify(sorted(wanted))
}

async function write(
  input: Parameters<typeof sync>[0],
  skill: SyncedSkill,
  target: string,
  current: Manifest | undefined,
) {
  const files = skill.files.map((file) => {
    const relative = safeRelative(file.path)
    if (!relative) throw new Error(`unsafe file path ${JSON.stringify(file.path)}`)
    return { ...file, relative }
  })
  // Download only when a file changed; an instructions-only change needs no request.
  const unchangedFiles = current !== undefined && files.every((file) => current.files[file.path] === file.sha256)
  const contents = new Map<string, string>()
  // Reuse the files on disk when they are current and still there; otherwise download them.
  const local = unchangedFiles
    ? await Promise.all(files.map((file) => readFile(path.join(target, file.relative), "utf8"))).catch(() => undefined)
    : undefined
  if (local) files.forEach((file, index) => contents.set(file.path, local[index]!))
  if (files.length > 0 && !local) {
    const response = await fetchFiles(input, skill.id)
    for (const file of files) {
      const downloaded = response.files.find((item) => item.path === file.path)
      if (!downloaded) throw new Error(`the platform sent no content for ${file.path}`)
      if (sha256(downloaded.content) !== file.sha256) throw new Error(`${file.path} does not match its SHA-256`)
      contents.set(file.path, downloaded.content)
    }
  }
  const staging = `${target}.tmp-${randomUUID()}`
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const cleanup = () => rm(staging, { recursive: true, force: true })
  try {
    await writeFile(path.join(staging, "SKILL.md"), skill.instructions, { mode: 0o600 })
    for (const file of files) {
      const destination = path.join(staging, file.relative)
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      // Never executable, even when the platform marks it so (see the header).
      await writeFile(destination, contents.get(file.path) ?? "", { mode: 0o600 })
    }
    const manifest: Manifest = {
      id: skill.id,
      version: skill.version,
      instructions: sha256(skill.instructions),
      files: Object.fromEntries(files.map((file) => [file.path, file.sha256])),
    }
    await writeFile(path.join(staging, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
    const old = `${target}.old-${randomUUID()}`
    const hadOld = await rename(target, old).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    await rename(staging, target).catch(async (error: unknown) => {
      if (hadOld) await rename(old, target)
      throw error
    })
    if (hadOld) await rm(old, { recursive: true, force: true })
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function fetchFiles(input: Parameters<typeof sync>[0], id: string) {
  const send = input.fetch ?? fetch
  const response = await send(`${input.platform}/api/v1/sync/skills/${encodeURIComponent(id)}/files`, {
    method: "GET",
    headers: { authorization: `Bearer ${input.key}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new KeteSyncClient.SyncError(`Could not reach the platform at ${input.platform}`, "network")
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new KeteSyncClient.SyncError(`The platform refused the skill files (HTTP ${response.status})`, "rejected")
  }
  const body = Schema.decodeUnknownOption(SkillFilesResponse)(await response.json().catch(() => undefined))
  if (body._tag === "None" || body.value.skill.id !== id)
    throw new KeteSyncClient.SyncError("The platform sent unexpected skill files", "invalid_response")
  return body.value
}

async function readManifest(target: string) {
  const text = await readFile(path.join(target, MANIFEST), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text)
  return decoded._tag === "Some" ? decoded.value : undefined
}

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function sorted(record: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)))
}

export * as KeteSyncSkills from "./skills.js"
