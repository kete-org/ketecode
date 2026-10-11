// Folder trust (task 2026-10-11-folder-trust, A10): the shared, pure part. A repository's own config
// (`kete.json`/`kete.jsonc`, `.kete/`) is written by whoever wrote the repository, so the settings in
// it that can run code on this machine or send data somewhere else are held back until the person
// says they trust the folder (core/src/kete/folder-trust.ts gates config loading; `kete trust` and
// `kete run` read the same files through cli/src/kete/folder-trust.ts). Both sides use this module,
// so what is guarded, the trust root and the fingerprint can't drift apart.
//
// Two guarded lists:
// - `guardedKeys` is `kete job run`'s list, moved here verbatim from cli/src/kete/job-project-config.ts
//   (job mode loads no project config; that check refuses a repository that sets any of these). It
//   stays exactly as it was, so `kete job run` doesn't start refusing repositories over the keys the
//   runtime list adds.
// - The runtime list (`guardedValues`, `runtimeGuarded`) is the job list plus `formatter` (unless it
//   is `false`: `true` or any object turns on the built-in formatters, which run project-local
//   binaries), `shell`, `worktree` (where worktrees and their setup script run) and permission rules
//   that loosen: `allow` rules, and an `ask` rule overlapping a machine-level `deny` (rules are
//   last-match-wins, so that ask would turn the deny into a question). Legacy keys (`permission`,
//   `tools`, `agent`, `mode`) count too.
//
// The fingerprint covers the raw (pre-substitution) values of every guarded key in every project
// document, the contents of the `.kete/plugin(s)/` directories, and every project agent markdown file
// that looks like it carries permission rules (`agentPermissionFiles`, a text test so no YAML parser
// is needed here). Rotating an `{env:…}` secret doesn't change it, and no secret is ever stored. The
// caps (`MAX_FILES`, `MAX_BYTES`) bound the work; over a cap there is no fingerprint and the folder
// can't be trusted (fail closed).
//
// Everything here takes parsed documents and an injected file system, so it carries no JSONC parser
// and can be tested with fakes.

export * as KeteFolderTrustRules from "./folder-trust.js"

import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

/** The form kind the runtime raises for an untrusted folder (`"global"` owner). */
export const FORM_KIND = "kete.folder.trust"
/** Set by `kete run`/`kete job run --trust-project-config` on the private server it starts: trusts
 * that run only, and only when it equals the server's parent process id (`runTrusted`). */
export const RUN_TRUST_VARIABLE = "OPENCODE_TRUST_RUN_PARENT"
/** Files hashed for one fingerprint (plugin files and agent files together). */
export const MAX_FILES = 5_000
/** Bytes hashed for one fingerprint. */
export const MAX_BYTES = 50 * 1024 * 1024
/** Plugin directory names inside `.kete/` (kept equal to core/src/plugin/source-directory.ts; tested). */
export const PLUGIN_DIRECTORIES = ["plugin", "plugins"] as const
/** Agent markdown directories inside `.kete/` (core/src/config/plugin/agent.ts): recursive, then one level. */
export const AGENT_DIRECTORIES = { recursive: ["agent", "agents"], flat: ["mode", "modes"] } as const

// ---------------------------------------------------------------------------------------------
// The job list (verbatim from cli/src/kete/job-project-config.ts)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function entries(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) return [prefix]
  const names = Object.keys(value)
  return names.length === 0 ? [prefix] : names.map((name) => `${prefix}.${name}`)
}

/** The settings in one parsed config document a repository may not control in an unattended run. */
export function guardedKeys(document: unknown): string[] {
  if (!isRecord(document)) return []
  const found: string[] = []
  for (const key of ["providers", "provider", "mcp"]) if (key in document) found.push(...entries(document[key], key))
  for (const key of ["plugins", "plugin", "enterprise"]) if (key in document) found.push(key)
  if ("share" in document && document.share !== "disabled") found.push("share")
  if ("autoshare" in document && document.autoshare !== false) found.push("autoshare")
  const kete = document.kete
  if (isRecord(kete)) for (const key of ["integrations", "platform", "unattended", "hooks"]) if (key in kete) found.push(`kete.${key}`)
  return found
}

// ---------------------------------------------------------------------------------------------
// The runtime list

/** Top-level keys whose value is held back whole (job list and runtime additions). */
export const JOB_GUARDED = ["providers", "provider", "mcp", "plugins", "plugin", "enterprise", "share", "autoshare"] as const
export const KETE_GUARDED = ["integrations", "platform", "unattended", "hooks"] as const
export const RUNTIME_GUARDED = [...JOB_GUARDED, "formatter", "shell", "worktree"] as const
/** Raw keys that carry permission rules: native, and the v1 forms config/normalize.ts migrates. */
export const PERMISSION_KEYS = ["permissions", "permission", "tools"] as const
/** Raw keys holding agents (native, and v1). */
export const AGENT_KEYS = ["agents", "agent", "mode"] as const

/** Whether a top-level key's value is exempt: it only switches the feature off. */
function exempt(key: string, value: unknown): boolean {
  if (key === "share") return value === "disabled"
  if (key === "autoshare") return value === false
  if (key === "formatter") return value === false
  return false
}

/** Every runtime-guarded raw value in one parsed document, keyed by dotted name: what the fingerprint
 * covers. Permission values are whole (deny rules too), so what was reviewed is what is hashed. */
export function guardedValues(document: unknown): Record<string, unknown> {
  if (!isRecord(document)) return {}
  const found: Record<string, unknown> = {}
  for (const key of RUNTIME_GUARDED) if (key in document && !exempt(key, document[key])) found[key] = document[key]
  const kete = document.kete
  if (isRecord(kete)) for (const key of KETE_GUARDED) if (key in kete) found[`kete.${key}`] = kete[key]
  for (const key of PERMISSION_KEYS) if (key in document) found[key] = document[key]
  for (const group of AGENT_KEYS) {
    const agents = document[group]
    if (!isRecord(agents)) continue
    for (const [name, agent] of Object.entries(agents)) {
      if (!isRecord(agent)) continue
      for (const key of PERMISSION_KEYS) if (key in agent) found[`${group}.${name}.${key}`] = agent[key]
    }
  }
  return found
}

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: string
}

/** Rules from a raw permission value (native `permissions`, v1 `permission`, v1 `tools`), as far as
 * they can be read; anything unreadable is skipped (the runtime's normalizer rejects it too). */
export function rawRules(key: string, value: unknown): Rule[] {
  if (key === "permissions") {
    if (!Array.isArray(value)) return []
    return value.flatMap((rule) =>
      isRecord(rule) && typeof rule.action === "string" && typeof rule.resource === "string" && typeof rule.effect === "string"
        ? [{ action: rule.action, resource: rule.resource, effect: rule.effect }]
        : [],
    )
  }
  if (key === "tools") {
    if (!isRecord(value)) return []
    return Object.entries(value).flatMap(([action, enabled]) =>
      typeof enabled === "boolean" ? [{ action, resource: "*", effect: enabled ? "allow" : "deny" }] : [],
    )
  }
  if (typeof value === "string") return [{ action: "*", resource: "*", effect: value }]
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([action, raw]) => {
    if (typeof raw === "string") return [{ action, resource: "*", effect: raw }]
    if (!isRecord(raw)) return []
    return Object.entries(raw).flatMap(([resource, effect]) => (typeof effect === "string" ? [{ action, resource, effect }] : []))
  })
}

/**
 * Splits rules into the ones that still apply in an untrusted folder and the ones held back: every
 * `allow`, and an `ask` whose action overlaps a machine-level `deny` (by `match` in either direction;
 * conservative, so it may hold back a harmless ask). `deny` and other `ask` rules are kept.
 */
export function loosening<R extends Rule>(
  rules: ReadonlyArray<R>,
  machineDeny: ReadonlyArray<Rule>,
  match: (input: string, pattern: string) => boolean,
): { readonly kept: R[]; readonly held: R[] } {
  const kept: R[] = []
  const held: R[] = []
  for (const rule of rules) {
    const loosens =
      rule.effect === "allow" ||
      (rule.effect === "ask" &&
        machineDeny.some((deny) => deny.effect === "deny" && (match(rule.action, deny.action) || match(deny.action, rule.action))))
    ;(loosens ? held : kept).push(rule)
  }
  return { kept, held }
}

/** How a held-back permission rule is shown. */
export function describeRule(rule: Rule, where?: string): string {
  return `permission${where ? ` (${where})` : ""}: ${JSON.stringify(rule.action)} ${JSON.stringify(rule.resource)} → ${rule.effect}`
}

/** The runtime-guarded settings one parsed document would have held back, by name. Permission keys
 * count only when they hold an `allow` (machine-level denies aren't known here; the runtime also holds
 * back an `ask` that overlaps one). */
export function runtimeGuarded(document: unknown): string[] {
  if (!isRecord(document)) return []
  const found = guardedKeys(document)
  for (const key of ["formatter", "shell", "worktree"]) if (key in document && !exempt(key, document[key])) found.push(key)
  for (const key of PERMISSION_KEYS)
    if (key in document && rawRules(key, document[key]).some((rule) => rule.effect === "allow")) found.push(key)
  for (const group of AGENT_KEYS) {
    const agents = document[group]
    if (!isRecord(agents)) continue
    for (const [name, agent] of Object.entries(agents)) {
      if (!isRecord(agent)) continue
      for (const key of PERMISSION_KEYS)
        if (key in agent && rawRules(key, agent[key]).some((rule) => rule.effect === "allow")) found.push(`${group}.${name}.${key}`)
    }
  }
  return found
}

const MAX_ITEM = 300
const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > MAX_ITEM ? `${text.slice(0, MAX_ITEM)}…` : text
}

const SECRET_KEY = /key|token|secret|password|authorization|credential/i
const ENDPOINT_KEY = /url|endpoint|host|base/i

/** Endpoint-like string fields in a provider's settings (never a key, token or header value). */
function endpoints(value: unknown, prefix: string, depth = 0): string[] {
  if (!isRecord(value) || depth > 3) return []
  const found: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    if (key === "headers" && isRecord(item)) {
      const names = Object.keys(item)
      if (names.length > 0) found.push(`${prefix}headers ${names.map((name) => JSON.stringify(name)).join(", ")}`)
      continue
    }
    if (typeof item === "string" && ENDPOINT_KEY.test(key)) found.push(`${prefix}${key} ${shown(item)}`)
    else if (isRecord(item)) found.push(...endpoints(item, `${prefix}${key}.`, depth + 1))
  }
  return found
}

function mcpServers(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return []
  if (isRecord(value.servers)) return Object.entries(value.servers)
  return Object.entries(value).filter(([name]) => name !== "timeout" && name !== "servers")
}

/**
 * What one parsed document would have held back, for a person to read: local MCP server commands,
 * remote MCP URLs, provider endpoints and header *names*, plugin specs, formatter commands, the shell,
 * the worktree directory, and every other guarded key by name. Never an API key or a header value.
 * Permission rules are described by the caller (`describeRule`), which knows which ones are held.
 */
export function describe(document: unknown): string[] {
  if (!isRecord(document)) return []
  const items: string[] = []
  if ("mcp" in document) {
    const servers = mcpServers(document.mcp)
    if (servers.length === 0) items.push("mcp")
    for (const [name, server] of servers) {
      if (isRecord(server) && server.command !== undefined)
        items.push(`MCP server ${JSON.stringify(name)}: runs ${shown(server.command)}${server.args === undefined ? "" : ` ${shown(server.args)}`}`)
      else if (isRecord(server) && typeof server.url === "string") items.push(`MCP server ${JSON.stringify(name)}: connects to ${shown(server.url)}`)
      else items.push(`MCP server ${JSON.stringify(name)}`)
    }
  }
  for (const key of ["providers", "provider"]) {
    if (!(key in document)) continue
    const providers = document[key]
    if (!isRecord(providers) || Object.keys(providers).length === 0) {
      items.push(key)
      continue
    }
    for (const [name, provider] of Object.entries(providers)) {
      const found = endpoints(provider, "")
      items.push(found.length ? `provider ${JSON.stringify(name)}: ${found.join("; ")}` : `provider ${JSON.stringify(name)}`)
    }
  }
  for (const key of ["plugins", "plugin"]) {
    if (!(key in document)) continue
    const value = document[key]
    const specs = Array.isArray(value) ? value : [value]
    for (const spec of specs)
      items.push(`plugin ${shown(isRecord(spec) && spec.package !== undefined ? spec.package : Array.isArray(spec) ? spec[0] : spec)}`)
  }
  if ("enterprise" in document)
    items.push(isRecord(document.enterprise) && typeof document.enterprise.url === "string" ? `enterprise: ${shown(document.enterprise.url)}` : "enterprise")
  if ("share" in document && !exempt("share", document.share)) items.push(`share: ${shown(document.share)}`)
  if ("autoshare" in document && !exempt("autoshare", document.autoshare)) items.push(`autoshare: ${shown(document.autoshare)}`)
  if (isRecord(document.kete)) for (const key of KETE_GUARDED) if (key in document.kete) items.push(`kete.${key}`)
  if ("formatter" in document && !exempt("formatter", document.formatter)) {
    const formatter = document.formatter
    if (isRecord(formatter)) {
      items.push("formatter: built-in formatters (they run tools installed in the project)")
      for (const [name, entry] of Object.entries(formatter))
        if (isRecord(entry) && entry.command !== undefined) items.push(`formatter ${JSON.stringify(name)}: runs ${shown(entry.command)}`)
    } else items.push("formatter: built-in formatters (they run tools installed in the project)")
  }
  if ("shell" in document) items.push(`shell: ${shown(document.shell)}`)
  if ("worktree" in document)
    items.push(isRecord(document.worktree) && document.worktree.directory !== undefined ? `worktree directory: ${shown(document.worktree.directory)}` : "worktree")
  return items
}

// ---------------------------------------------------------------------------------------------
// File system access (injected; `nodeFs` is the real one)

export type Kind = "file" | "directory" | "symlink" | "other"

export interface Fs {
  /** The real path; rejects when it can't be resolved. */
  readonly realpath: (file: string) => Promise<string>
  /** What the entry itself is (symlinks not followed), or `undefined` when it doesn't exist. */
  readonly lstat: (file: string) => Promise<{ readonly kind: Kind; readonly size: number } | undefined>
  /** What the entry resolves to (symlinks followed), or `undefined` when it doesn't exist. */
  readonly stat: (file: string) => Promise<{ readonly kind: Kind; readonly size: number } | undefined>
  /** The file's text, or `undefined` when it doesn't exist. Any other failure rejects. */
  readonly readFile: (file: string) => Promise<string | undefined>
  /** The file's bytes, or `undefined` when it doesn't exist. Any other failure rejects. */
  readonly readBytes: (file: string) => Promise<Uint8Array | undefined>
  /** The directory's entry names, or `undefined` when it doesn't exist. Any other failure rejects. */
  readonly readDir: (directory: string) => Promise<ReadonlyArray<string> | undefined>
}

const missing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}
const orMissing = <A>(promise: Promise<A>): Promise<A | undefined> =>
  promise.catch((error) => (missing(error) ? undefined : Promise.reject(error)))
const kind = (info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): Kind =>
  info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other"

export const nodeFs: Fs = {
  realpath: (file) => realpath(file),
  lstat: (file) => orMissing(lstat(file)).then((info) => (info ? { kind: kind(info), size: info.size } : undefined)),
  stat: (file) => orMissing(stat(file)).then((info) => (info ? { kind: kind(info), size: info.size } : undefined)),
  readFile: (file) => orMissing(readFile(file, "utf8")),
  readBytes: (file) => orMissing(readFile(file)),
  readDir: (directory) => orMissing(readdir(directory)),
}

// ---------------------------------------------------------------------------------------------
// Trust root and store keys

export type Root =
  | { readonly kind: "ok"; readonly root: string; readonly top: string }
  | { readonly kind: "unresolvable"; readonly reason: string }

const GITDIR = /^gitdir:\s*(.+?)\s*$/m

/** The main working tree a linked worktree's `.git` file belongs to, only when git's back-link
 * (`<commondir>/worktrees/<name>/gitdir`) points back at this very `.git` file; otherwise undefined. */
async function linkedMain(top: string, dotGit: string, fs: Fs): Promise<string | undefined> {
  const text = await fs.readFile(dotGit)
  const match = text === undefined ? undefined : GITDIR.exec(text)
  if (!match?.[1]) return undefined
  const gitdir = await fs.realpath(path.resolve(top, match[1])).catch(() => undefined)
  if (gitdir === undefined) return undefined
  const commondirText = await fs.readFile(path.join(gitdir, "commondir")).catch(() => undefined)
  if (commondirText === undefined) return undefined
  const common = await fs.realpath(path.resolve(gitdir, commondirText.trim())).catch(() => undefined)
  if (common === undefined || path.dirname(gitdir) !== path.join(common, "worktrees")) return undefined
  const back = await fs.readFile(path.join(gitdir, "gitdir")).catch(() => undefined)
  if (back === undefined) return undefined
  const pointed = await fs.realpath(path.resolve(gitdir, back.trim())).catch(() => undefined)
  const self = await fs.realpath(dotGit).catch(() => undefined)
  if (pointed === undefined || self === undefined || pointed !== self) return undefined
  if (path.basename(common) !== ".git") return undefined
  const main = path.dirname(common)
  const info = await fs.lstat(path.join(main, ".git"))
  return info?.kind === "directory" ? main : undefined
}

/**
 * The folder whose trust applies to `directory`: its real path's nearest ancestor with a `.git` entry
 * (a linked worktree maps to its main working tree only when git's back-link verifies, so a forged
 * `.git` file can't borrow another repository's trust), else the directory itself. `top` is the
 * working-tree top the fingerprint's paths are relative to.
 */
export async function trustRoot(directory: string, fs: Fs = nodeFs): Promise<Root> {
  let real: string
  try {
    real = await fs.realpath(directory)
  } catch (error) {
    return { kind: "unresolvable", reason: `can't resolve ${JSON.stringify(directory)} (${(error as NodeJS.ErrnoException).code ?? "error"})` }
  }
  let current = real
  for (;;) {
    const dotGit = path.join(current, ".git")
    const info = await fs.lstat(dotGit).catch(() => undefined)
    if (info?.kind === "directory") return { kind: "ok", root: current, top: current }
    if (info?.kind === "file") {
      const main = await linkedMain(current, dotGit, fs).catch(() => undefined)
      return { kind: "ok", root: main ?? current, top: current }
    }
    const parent = path.dirname(current)
    if (parent === current) return { kind: "ok", root: real, top: real }
    current = parent
  }
}

/** The store key for a trust root: the exact real path, lowercased on Windows (case-insensitive
 * there). Keys are only ever compared for equality, never as prefixes. */
export function storeKey(root: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? root.toLowerCase() : root
}

/** Why a store key can never be trusted (the home directory, or a filesystem root), if it can't.
 * `home` should be the real path of the home directory. */
export function neverTrusted(key: string, home: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const paths = platform === "win32" ? path.win32 : path.posix
  if (key === storeKey(home, platform)) return "it is your home directory; trust a project folder inside it instead"
  if (paths.parse(key).root === key || paths.dirname(key) === key) return "it is the root of the file system; trust a project folder instead"
  return undefined
}

/** Whether this process was started by `kete run --trust-project-config` (or `kete job run`'s): the
 * variable must name exactly the parent process. An inherited value never matches a grandchild. */
export function runTrusted(env: Record<string, string | undefined>, ppid: number): boolean {
  const value = env[RUN_TRUST_VARIABLE]
  if (value === undefined || !/^[1-9][0-9]*$/.test(value) || value === "1") return false
  return ppid > 1 && value === String(ppid)
}

// ---------------------------------------------------------------------------------------------
// Plugin and agent files

/** Whether an agent markdown file may carry loosening permission rules: its front matter (or the
 * whole text when there is none it can find) mentions `permission` and `allow`, or `tools` and
 * `true`. A superset of what the runtime strips (fail closed). */
export function agentTextLoosens(text: string): boolean {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? text
  return (/permission/i.test(front) && /allow/i.test(front)) || (/tools/i.test(front) && /true/i.test(front))
}

async function markdownFiles(directory: string, recursive: boolean, fs: Fs, seen: Set<string>): Promise<string[]> {
  const names = await fs.readDir(directory)
  if (names === undefined) return []
  const real = await fs.realpath(directory)
  if (seen.has(real)) return []
  seen.add(real)
  const found: string[] = []
  for (const name of [...names].sort()) {
    const file = path.join(directory, name)
    const info = await fs.stat(file)
    if (info?.kind === "directory" && recursive) found.push(...(await markdownFiles(file, recursive, fs, seen)))
    else if (info?.kind === "file" && name.endsWith(".md")) found.push(file)
    if (found.length > MAX_FILES) return found
  }
  return found
}

/** Project agent markdown files under one `.kete/` directory that may carry loosening rules. */
export async function agentPermissionFiles(directory: string, fs: Fs = nodeFs): Promise<string[]> {
  const seen = new Set<string>()
  const files = [
    ...(await Promise.all(AGENT_DIRECTORIES.recursive.map((name) => markdownFiles(path.join(directory, name), true, fs, seen)))).flat(),
    ...(await Promise.all(AGENT_DIRECTORIES.flat.map((name) => markdownFiles(path.join(directory, name), false, fs, seen)))).flat(),
  ]
  const result: string[] = []
  for (const file of files) {
    const text = await fs.readFile(file)
    if (text !== undefined && agentTextLoosens(text)) result.push(file)
  }
  return result
}

/** The plugin directories under one `.kete/` directory that have anything in them. */
export async function pluginDirectories(directory: string, fs: Fs = nodeFs): Promise<string[]> {
  const result: string[] = []
  for (const name of PLUGIN_DIRECTORIES) {
    const target = path.join(directory, name)
    const names = await fs.readDir(target)
    if (names !== undefined && names.length > 0) result.push(target)
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// Fingerprint

export interface FingerprintInput {
  /** The working-tree top paths are made relative to. */
  readonly top: string
  /** Every project config document that applies, parsed (pre-substitution). */
  readonly documents: ReadonlyArray<{ readonly path: string; readonly document: unknown }>
  /** Plugin directories (`pluginDirectories`). */
  readonly plugins: ReadonlyArray<string>
  /** Agent files (`agentPermissionFiles`). */
  readonly agents: ReadonlyArray<string>
}

export type Fingerprint = { readonly kind: "ok"; readonly value: string } | { readonly kind: "unavailable"; readonly reason: string }

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

/** A path for the fingerprint: relative to `top` with `/` when inside it, else absolute. */
export function display(file: string, top: string): string {
  const relative = path.relative(top, file)
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  return (inside ? relative : relative === "" ? "." : file).split(path.sep).join("/")
}

/** JSON with object keys sorted at every level. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

class OverCap extends Error {}

/** sha256 over the guarded values, plugin files and agent files (see the header). */
export async function fingerprint(input: FingerprintInput, fs: Fs = nodeFs): Promise<Fingerprint> {
  let files = 0
  let bytes = 0
  const hashFile = async (file: string) => {
    const data = await fs.readBytes(file)
    if (data === undefined) return undefined
    files++
    bytes += data.byteLength
    if (files > MAX_FILES) throw new OverCap(`more than ${MAX_FILES} files to check`)
    if (bytes > MAX_BYTES) throw new OverCap(`more than ${MAX_BYTES / 1024 / 1024} MiB to check`)
    return sha256(data)
  }
  const walk = async (directory: string, base: string, seen: Set<string>): Promise<Array<{ path: string; sha256: string }>> => {
    const real = await fs.realpath(directory)
    if (seen.has(real)) return []
    seen.add(real)
    const names = (await fs.readDir(directory)) ?? []
    const found: Array<{ path: string; sha256: string }> = []
    for (const name of [...names].sort()) {
      const file = path.join(directory, name)
      const info = await fs.stat(file)
      if (info?.kind === "directory") found.push(...(await walk(file, base, seen)))
      else if (info?.kind === "file") {
        const hash = await hashFile(file)
        if (hash !== undefined) found.push({ path: display(file, base), sha256: hash })
      }
    }
    return found
  }
  // Paths are shown from their real location, so a symlinked or differently spelled path (macOS's
  // /var vs /private/var) gives the same fingerprint wherever it is computed.
  const real = (file: string) => fs.realpath(file).catch(() => file)
  try {
    const documents: Array<{ path: string; guarded: Record<string, unknown> }> = []
    for (const item of input.documents) {
      const guarded = guardedValues(item.document)
      if (Object.keys(guarded).length > 0) documents.push({ path: display(await real(item.path), input.top), guarded })
    }
    documents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const plugins: Array<{ path: string; files: Array<{ path: string; sha256: string }> }> = []
    for (const directory of [...input.plugins].sort())
      plugins.push({ path: display(await real(directory), input.top), files: await walk(directory, directory, new Set()) })
    const agents: Array<{ path: string; sha256: string }> = []
    for (const file of [...input.agents].sort()) {
      const hash = await hashFile(file)
      if (hash !== undefined) agents.push({ path: display(await real(file), input.top), sha256: hash })
    }
    plugins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    agents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { kind: "ok", value: sha256(canonical({ v: 1, documents, plugins, agents })) }
  } catch (error) {
    if (error instanceof OverCap) return { kind: "unavailable", reason: error.message }
    return { kind: "unavailable", reason: `couldn't read the folder's files (${(error as NodeJS.ErrnoException).code ?? "error"})` }
  }
}
