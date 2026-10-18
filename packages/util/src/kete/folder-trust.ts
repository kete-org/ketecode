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
//   binaries), `shell`, `worktree` (where worktrees and their setup script run), remote `skills` URLs
//   and git `references` (fetched when they load), permission rules that loosen (`allow` rules, and an
//   `ask` rule overlapping a machine-level `deny`: rules are last-match-wins, so that ask would turn the
//   deny into a question), `experimental.policies` allow statements and the v1 `enabled_providers`
//   (which normalizes into `provider.use` allows; `disabled_providers`, its deny-only sibling, is
//   fingerprinted too, so dropping a denied provider asks again). Legacy keys (`permission`,
//   `tools`, `agent`, `mode`) count too. `{env:…}`/`{file:…}` substitution in a project document is
//   held back as well (`substitutionTokens`): until the folder is trusted the runtime loads project
//   documents with the tokens left as they are.
//
// The fingerprint covers the raw (pre-substitution) values of every guarded key in every project
// document, the substitution tokens each document uses, the contents of every `{file:…}` target a
// guarded value names, the contents of the `.kete/plugin(s)/` directories and every project agent
// markdown file (`agentFiles`; hashed whole, so no YAML is read here) and every local plugin a project
// document configures (`localPluginTargets`). Rotating an `{env:…}` secret doesn't change it, and no
// secret is ever stored. A document that only parses after substitution, has a token outside a JSON
// string value (`misplacedToken`) or a `{file:…}` path built from `{env:…}` can't be fingerprinted.
// The fingerprint hands back the `{file:…}` texts it hashed (substitution uses those, never a second
// read) and per-plugin-directory, per-agent-file and per-configured-plugin digests, so the runtime and
// the TUI can check that what is about to load is still what was trusted (`pluginDigest`,
// `agentDigest`, `targetDigest`). A substituted document must set exactly what its raw text showed
// (`substitutionMismatch`). The caps (`MAX_FILES`, `MAX_BYTES`) bound the work, and sizes are checked
// before anything is read; over a cap there is no fingerprint and the folder can't be trusted (fail
// closed).
//
// Everything shown to a person goes through `safe` (control, format, bidi and zero-width characters
// escaped), and values are shown in full; whoever displays them decides what to do with a long one.
//
// Everything here takes parsed documents and an injected file system, so it carries no JSONC parser
// and can be tested with fakes.

export * as KeteFolderTrustRules from "./folder-trust.js"

import { createHash } from "node:crypto"
import os from "node:os"
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

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

/** Where core/src/config/plugin/command.ts reads markdown commands: `{command,commands}/**\/*.md`. */
export const COMMAND_DIRECTORIES = ["command", "commands"] as const

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
/** v1 provider lists config/normalize.ts turns into `provider.use` policy statements:
 * `enabled_providers` into a deny of every provider plus an allow for each one listed,
 * `disabled_providers` into a deny for each one listed. Fingerprinted whole (so removing a denied
 * provider or adding an allowed one after trust asks again); `enabled_providers` is shown. */
export const PROVIDER_LIST_KEYS = ["enabled_providers", "disabled_providers"] as const
/** Settings read from the machine-level `kete` object even when a project document sets its own
 * `kete` (core/src/kete/folder-trust.ts `shield`): `offline` is on when either says so; the others
 * come from the machine level when the project doesn't set them (or they are held back). */
export const KETE_MACHINE = ["integrations", "platform", "unattended"] as const

/** Whether a top-level key's value is exempt: it only switches the feature off. */
function exempt(key: string, value: unknown): boolean {
  if (key === "share") return value === "disabled"
  if (key === "autoshare") return value === false
  if (key === "formatter") return value === false
  return false
}

/** Whether a `skills` item is fetched from the network (core/src/config/plugin/skill.ts). */
export function remoteSkill(item: unknown): boolean {
  if (typeof item !== "string" || !URL.canParse(item)) return false
  return /^(https?:)$/.test(new URL(item).protocol)
}

/** The skills items in a raw or normalized `skills` value (a list, or v1's `{paths, urls}`). */
function skillItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value)) return [value.paths, value.urls].flatMap((list) => (Array.isArray(list) ? list : list === undefined ? [] : [list]))
  return [value]
}

/** Whether a `references` entry is a git repository (core/src/config/plugin/reference.ts `local`). */
export function gitReference(entry: unknown): boolean {
  if (typeof entry === "string") return !(entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~"))
  return !(isRecord(entry) && "path" in entry)
}

function remoteSkills(value: unknown): unknown[] {
  return skillItems(value).filter((item) => typeof item !== "string" || remoteSkill(item))
}

function gitReferences(value: unknown): Array<[string, unknown]> {
  return isRecord(value) ? Object.entries(value).filter(([, entry]) => gitReference(entry)) : []
}

function policies(document: Record<string, unknown>): unknown {
  return isRecord(document.experimental) ? document.experimental.policies : undefined
}

/** The providers a raw `enabled_providers` allows (config/normalize.ts makes an allow statement for each). */
function enabledProviders(document: Record<string, unknown>): string[] {
  const value = document.enabled_providers
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Policy statements that allow (a project's would outrank a host-injected deny). */
export function allowPolicies(value: unknown): Array<{ action: string; resource: string; effect: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((policy) =>
    isRecord(policy) && policy.effect !== "deny"
      ? [{ action: String(policy.action), resource: String(policy.resource), effect: String(policy.effect) }]
      : [],
  )
}

/** Every runtime-guarded raw value in one parsed document, keyed by dotted name: what the fingerprint
 * covers. Permission and policy values are whole (deny rules too), so what was reviewed is what is
 * hashed; so are `skills` and `references` whenever present. */
export function guardedValues(document: unknown): Record<string, unknown> {
  if (!isRecord(document)) return {}
  const found: Record<string, unknown> = {}
  for (const key of RUNTIME_GUARDED) if (key in document && !exempt(key, document[key])) found[key] = document[key]
  const kete = document.kete
  if (isRecord(kete)) for (const key of KETE_GUARDED) if (key in kete) found[`kete.${key}`] = kete[key]
  for (const key of PERMISSION_KEYS) if (key in document) found[key] = document[key]
  for (const key of ["skills", "references"]) if (key in document) found[key] = document[key]
  for (const key of PROVIDER_LIST_KEYS) if (key in document) found[key] = document[key]
  const policy = policies(document)
  if (policy !== undefined) found["experimental.policies"] = policy
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

/** The rules in an agent markdown file's decoded front matter (`permissions`, v1 `permission` and `tools`). */
export function frontMatterRules(data: unknown): Rule[] {
  if (!isRecord(data)) return []
  return PERMISSION_KEYS.flatMap((key) => (key in data ? rawRules(key, data[key]) : []))
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

/**
 * Text that is safe to show: every control (C0, DEL, C1 including U+009B), format (bidi overrides
 * and isolates, zero-width characters, U+FEFF), line- and paragraph-separator character is written
 * as `\u{…}`, so nothing a repository writes can hide, reorder or restyle what a person reads.
 */
export function safe(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`)
}

/** A value as shown: JSON, in full, made `safe`. */
export const shown = (value: unknown) => safe(JSON.stringify(value) ?? String(value))

/** How a held-back permission rule is shown. */
export function describeRule(rule: Rule, where?: string): string {
  return safe(`permission${where ? ` (${where})` : ""}: ${JSON.stringify(rule.action)} ${JSON.stringify(rule.resource)} → ${rule.effect}`)
}

/** The runtime-guarded settings one parsed document would have held back, by name. Permission keys
 * count only when they hold an `allow` (machine-level denies aren't known here; the runtime also holds
 * back an `ask` that overlaps one). */
export function runtimeGuarded(document: unknown): string[] {
  if (!isRecord(document)) return []
  const found = guardedKeys(document)
  for (const key of ["formatter", "shell", "worktree"]) if (key in document && !exempt(key, document[key])) found.push(key)
  if ("skills" in document && remoteSkills(document.skills).length > 0) found.push("skills")
  if ("references" in document && gitReferences(document.references).length > 0) found.push("references")
  if (enabledProviders(document).length > 0) found.push("enabled_providers")
  if (allowPolicies(policies(document)).length > 0) found.push("experimental.policies")
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

const SECRET_KEY = /key|token|secret|password|authorization|credential/i
const ENDPOINT_KEY = /url|endpoint|host|base/i

/** Endpoint-like string fields, header *names*, packages and environment variable names in a
 * provider's settings (never a key, token or header value). */
function endpoints(value: unknown, prefix: string, depth = 0): string[] {
  if (!isRecord(value) || depth > 4) return []
  const found: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (key === "package" && typeof item === "string") {
      found.push(`${prefix}package ${shown(item)} (installed and run)`)
      continue
    }
    if (key === "env" && Array.isArray(item)) {
      if (item.length > 0) found.push(`${prefix}env ${item.map((name) => shown(name)).join(", ")}`)
      continue
    }
    if (SECRET_KEY.test(key)) continue
    if (key === "headers" && isRecord(item)) {
      const names = Object.keys(item)
      if (names.length > 0) found.push(`${prefix}headers ${names.map((name) => shown(name)).join(", ")}`)
      continue
    }
    if (typeof item === "string" && ENDPOINT_KEY.test(key)) found.push(`${prefix}${safe(key)} ${shown(item)}`)
    else if (isRecord(item)) found.push(...endpoints(item, `${prefix}${safe(key)}.`, depth + 1))
  }
  return found
}

const directServer = (value: unknown) => isRecord(value) && (value.type === "local" || value.type === "remote")
const enabledOnly = (value: unknown) => isRecord(value) && !("type" in value) && typeof value.enabled === "boolean"

/** The MCP servers in a raw or normalized `mcp` value, as config/normalize.ts reads them: native
 * `servers` and legacy top-level servers together; `servers`/`timeout` count as server names when
 * their value is itself a server. */
function mcpServers(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return []
  const servers: Array<[string, unknown]> = []
  for (const [name, item] of Object.entries(value)) {
    if (enabledOnly(item)) continue
    if (name === "servers" && !directServer(item)) {
      if (isRecord(item)) servers.push(...Object.entries(item))
      continue
    }
    if (name === "timeout" && !directServer(item)) continue
    servers.push([name, item])
  }
  return servers
}

function describeServer(name: string, server: unknown): string {
  const label = `MCP server ${shown(name)}`
  if (!isRecord(server)) return label
  const extra: string[] = []
  if (isRecord(server.environment) && Object.keys(server.environment).length > 0)
    extra.push(`environment ${Object.keys(server.environment).map((key) => shown(key)).join(", ")}`)
  if (isRecord(server.headers) && Object.keys(server.headers).length > 0)
    extra.push(`headers ${Object.keys(server.headers).map((key) => shown(key)).join(", ")}`)
  if (server.cwd !== undefined) extra.push(`in ${shown(server.cwd)}`)
  const tail = extra.length ? `; ${extra.join("; ")}` : ""
  if (server.command !== undefined)
    return `${label}: runs ${shown(server.command)}${server.args === undefined ? "" : ` ${shown(server.args)}`}${tail}`
  if (typeof server.url === "string") return `${label}: connects to ${shown(server.url)}${tail}`
  return `${label}${tail}`
}

function describeHooks(hooks: unknown): string[] {
  if (!isRecord(hooks)) return ["kete.hooks"]
  const items: string[] = []
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue
    for (const hook of list) {
      if (!isRecord(hook)) continue
      const match = hook.match === undefined ? "" : ` (match ${shown(hook.match)})`
      const network = hook.network === true ? ", with network access" : ""
      items.push(`hook ${shown(event)}${match}: runs ${shown(hook.command)}${network}`)
    }
  }
  return items.length ? items : ["kete.hooks"]
}

/**
 * What one document would have held back, for a person to read. Works on a raw parsed document (the
 * CLI) and on the parts of a normalized one the runtime held back (core): local MCP server commands
 * (and their environment variable names), remote MCP URLs, provider packages, environment variable
 * names, endpoints and header *names*, plugin specs, project hook commands, formatter commands, the
 * shell, the worktree directory, remote skills URLs, git references, `enabled_providers`, policy allow statements, and
 * every other guarded key by name. Never an API key or a header value. Permission rules are described
 * by the caller (`describeRule`), which knows which ones are held.
 */
export function describe(document: unknown): string[] {
  if (!isRecord(document)) return []
  const items: string[] = []
  if ("mcp" in document) {
    const servers = mcpServers(document.mcp)
    if (servers.length === 0) items.push("mcp")
    for (const [name, server] of servers) items.push(describeServer(name, server))
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
      items.push(found.length ? `provider ${shown(name)}: ${found.join("; ")}` : `provider ${shown(name)}`)
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
  if (isRecord(document.kete))
    for (const key of KETE_GUARDED) {
      if (!(key in document.kete)) continue
      const value = document.kete[key]
      if (key === "hooks") items.push(...describeHooks(value))
      else if (key === "platform" && isRecord(value) && typeof value.url === "string") items.push(`kete.platform: ${shown(value.url)}`)
      else items.push(`kete.${key}`)
    }
  if ("formatter" in document && !exempt("formatter", document.formatter)) {
    const formatter = document.formatter
    items.push("formatter: built-in formatters (they run tools installed in the project)")
    if (isRecord(formatter))
      for (const [name, entry] of Object.entries(formatter))
        if (isRecord(entry) && entry.command !== undefined) items.push(`formatter ${shown(name)}: runs ${shown(entry.command)}`)
  }
  if ("shell" in document) items.push(`shell: ${shown(document.shell)}`)
  if ("worktree" in document)
    items.push(isRecord(document.worktree) && document.worktree.directory !== undefined ? `worktree directory: ${shown(document.worktree.directory)}` : "worktree")
  if ("skills" in document) for (const item of remoteSkills(document.skills)) items.push(`skills from ${shown(item)}`)
  if ("references" in document)
    for (const [name, entry] of gitReferences(document.references))
      items.push(`reference ${shown(name)}: git ${shown(isRecord(entry) ? entry.repository : entry)}${isRecord(entry) && entry.branch !== undefined ? ` (branch ${shown(entry.branch)})` : ""}`)
  const enabled = enabledProviders(document)
  if (enabled.length > 0) items.push(`enabled_providers: allows provider ${enabled.map((name) => shown(name)).join(", ")} (provider.use)`)
  for (const policy of allowPolicies(policies(document)))
    items.push(`policy: ${shown(policy.action)} ${shown(policy.resource)} → ${safe(policy.effect)}`)
  return items
}

// ---------------------------------------------------------------------------------------------
// {env:…} and {file:…} substitution (core/src/config/variable.ts)

export interface Tokens {
  /** Environment variable names (`{env:NAME}`), in order of appearance, without repeats. */
  readonly env: ReadonlyArray<string>
  /** Raw `{file:…}` tokens, as substitution reads them (not on a `//` comment line). */
  readonly files: ReadonlyArray<string>
}

/** The substitution tokens in a config document's raw text, found the way ConfigVariable.substitute
 * finds them. */
export function substitutionTokens(text: string): Tokens {
  const env = [...new Set([...text.matchAll(/\{env:([^}]+)\}/g)].map((match) => match[1]!))]
  const files: string[] = []
  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1
    if (text.slice(lineStart, match.index).trimStart().startsWith("//")) continue
    if (!files.includes(match[0])) files.push(match[0])
  }
  return { env, files }
}

/** How a document's substitution tokens are shown (held back until the folder is trusted). */
export function describeTokens(tokens: Tokens, where: string): string[] {
  return [
    ...tokens.env.map((name) => `reads environment variable ${shown(name)} (in ${shown(where)})`),
    ...tokens.files.map((token) => `reads file ${shown(token.slice("{file:".length, -1))} (in ${shown(where)})`),
  ]
}

/** Where a `{file:…}` token reads from (ConfigVariable: `~/` is the home directory, relative to the document). */
export function fileTarget(token: string, documentPath: string, home: string): string {
  const file = token.slice("{file:".length, -1)
  const expanded = file.startsWith("~/") ? path.join(home, file.slice(2)) : file
  return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(documentPath), expanded)
}

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, into)
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      into.push(key)
      strings(item, into)
    }
  return into
}

const ENV_TOKEN = /\{env:[^}]+\}/g
const FILE_TOKEN = /\{file:[^}]+\}/g

/** The string literals in a JSONC text that parses: where each value string and each property name
 * sits (offsets of the quotes). Comments are skipped; `undefined` when a string or block comment
 * doesn't end (such a text doesn't parse). */
export function stringLiterals(text: string): { values: Array<[number, number]>; names: Array<[number, number]> } | undefined {
  const values: Array<[number, number]> = []
  const names: Array<[number, number]> = []
  const blank = (at: number) => {
    // Skip whitespace and comments; returns the next significant offset.
    for (;;) {
      while (at < text.length && /\s/.test(text[at]!)) at++
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at)
        at = end === -1 ? text.length : end + 1
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2)
        if (end === -1) return -1
        at = end + 2
      } else return at
    }
  }
  let at = 0
  while (at < text.length) {
    const next = blank(at)
    if (next === -1) return undefined
    at = next
    if (at >= text.length) break
    if (text[at] !== '"') {
      at++
      continue
    }
    let end = at + 1
    while (end < text.length && text[end] !== '"' && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1
    if (end >= text.length || text[end] !== '"') return undefined
    const after = blank(end + 1)
    ;(after !== -1 && text[after] === ":" ? names : values).push([at, end])
    at = end + 1
  }
  return { values, names }
}

/**
 * Why a document's substitution tokens can't be checked, if they can't: every `{env:…}` token and
 * every `{file:…}` token ConfigVariable substitutes must sit inside one JSON string *value*. One in a
 * comment, a property name or between values can change the document's structure once substituted
 * (a file's text closing a block comment and adding an MCP server), which the raw text never showed.
 */
export function misplacedToken(text: string, file: string, top: string): string | undefined {
  const tokens = [
    ...[...text.matchAll(ENV_TOKEN)].map((match) => ({ token: match[0], index: match.index })),
    ...[...text.matchAll(FILE_TOKEN)]
      .filter((match) => !text.slice(text.lastIndexOf("\n", match.index - 1) + 1, match.index).trimStart().startsWith("//"))
      .map((match) => ({ token: match[0], index: match.index })),
  ]
  if (tokens.length === 0) return undefined
  const literals = stringLiterals(text)
  const where = shown(display(file, top))
  if (!literals) return `${where} can't be checked for where its {env:…}/{file:…} tokens sit`
  for (const { token, index } of tokens)
    if (!literals.values.some(([start, end]) => index > start && index + token.length <= end))
      return `${shown(token)} in ${where} isn't inside a string value, so substituting it could change what the file sets`
  return undefined
}

/** ConfigVariable.substitute (core/src/config/variable.ts) on the CLI side, where the runtime isn't
 * loaded: `{env:…}` from `env`, then `{file:…}` (not on a `//` line) from `files` (target → text, as
 * the fingerprint read it). `undefined` when a file token's target isn't in `files`. */
export function substitute(
  text: string,
  documentPath: string,
  files: ReadonlyMap<string, string>,
  env: Record<string, string | undefined>,
  home: string = os.homedir(),
): string | undefined {
  const replaced = text.replace(ENV_TOKEN, (token) => env[token.slice("{env:".length, -1)] || "")
  let out = ""
  let cursor = 0
  for (const match of replaced.matchAll(FILE_TOKEN)) {
    out += replaced.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const lineStart = replaced.lastIndexOf("\n", match.index - 1) + 1
    if (replaced.slice(lineStart, match.index).trimStart().startsWith("//")) {
      out += match[0]
      continue
    }
    const content = files.get(fileTarget(match[0], documentPath, home))
    if (content === undefined) return undefined
    out += JSON.stringify(content.trim()).slice(1, -1)
  }
  return out + replaced.slice(cursor)
}

/** Whether `value` is `pattern`'s pieces in order, any text standing in for each `null` piece. */
function globMatches(value: string, pieces: ReadonlyArray<string | null>): boolean {
  const literals: string[] = [""]
  for (const piece of pieces) {
    if (piece === null) literals.push("")
    else literals[literals.length - 1] += piece
  }
  if (literals.length === 1) return value === literals[0]
  const first = literals[0]!
  const last = literals[literals.length - 1]!
  if (!value.startsWith(first) || value.length < first.length + last.length || !value.endsWith(last)) return false
  let at = first.length
  const end = value.length - last.length
  for (const middle of literals.slice(1, -1)) {
    const found = value.indexOf(middle, at)
    if (found === -1 || found + middle.length > end) return false
    at = found + middle.length
  }
  return true
}

/**
 * Where a substituted document differs from what its raw text showed, if anywhere (`$.a.b`): the
 * same shape (types, property names and their order, array lengths, every non-string value), and each
 * string the raw string with its `{file:…}` tokens replaced by the text the fingerprint read
 * (`file`) and its `{env:…}` tokens by anything (the environment is the person's own and isn't
 * fingerprinted). Anything else means substitution changed what the document sets: fail closed.
 */
export function substitutionMismatch(
  raw: unknown,
  substituted: unknown,
  file: (token: string) => string | undefined,
  where = "$",
): string | undefined {
  if (typeof raw === "string") {
    if (typeof substituted !== "string") return where
    const pieces: Array<string | null> = []
    let cursor = 0
    for (const match of raw.matchAll(/\{env:[^}]+\}|\{file:[^}]+\}/g)) {
      pieces.push(raw.slice(cursor, match.index))
      cursor = match.index + match[0].length
      if (match[0].startsWith("{env:")) pieces.push(null)
      else {
        const content = file(match[0])
        if (content === undefined) return where
        pieces.push(content.trim())
      }
    }
    pieces.push(raw.slice(cursor))
    return globMatches(substituted, pieces) ? undefined : where
  }
  if (Array.isArray(raw)) {
    if (!Array.isArray(substituted) || substituted.length !== raw.length) return where
    for (let index = 0; index < raw.length; index++) {
      const found = substitutionMismatch(raw[index], substituted[index], file, `${where}[${index}]`)
      if (found) return found
    }
    return undefined
  }
  if (isRecord(raw)) {
    if (!isRecord(substituted)) return where
    const keys = Object.keys(raw)
    const other = Object.keys(substituted)
    if (keys.length !== other.length || keys.some((key, index) => key !== other[index])) return where
    for (const key of keys) {
      const found = substitutionMismatch(raw[key], substituted[key], file, `${where}.${key}`)
      if (found) return found
    }
    return undefined
  }
  return raw === substituted ? undefined : where
}

/** The reason a substituted document can't be trusted (`substitutionMismatch`), for a person to read. */
export function mismatchReason(file: string, top: string, at: string): string {
  return `substituting {env:…}/{file:…} in ${shown(display(file, top))} changes what it sets (at ${shown(at)}), so it can't be checked`
}

/** The raw `{file:…}` tokens of a document that a guarded value uses (decided on the decoded token,
 * so a JSON escape in the raw text can't hide one; an undecodable token counts). */
export function guardedFileTokens(tokens: Tokens, document: unknown): string[] {
  const guarded = strings(guardedValues(document))
  return tokens.files.filter((token) => {
    let decoded: string
    try {
      decoded = JSON.parse(`"${token}"`) as string
    } catch {
      return true
    }
    return guarded.some((value) => value.includes(decoded) || value.includes(token))
  })
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

/** Whether an agent markdown file may carry loosening permission rules, by its text alone (the CLI,
 * which has no YAML parser): its front matter (or the whole text when there is none it can find)
 * mentions `permission` or `tools`, or uses a YAML escape, tag or alias that could spell one. Only
 * for what is shown; the fingerprint hashes every agent file whole (`agentFiles`), and the runtime
 * decides on the decoded front matter. */
export function agentTextLoosens(text: string): boolean {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? text
  return /permission|tools/i.test(front) || /\\[xuUN0-9]|!!|!<|[:\-,[]\s*[&*][^\s]/.test(front)
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

/** Every agent markdown file under one config directory (core/src/config/plugin/agent.ts reads
 * `{agent,agents}/**\/*.md` and `{mode,modes}/*.md`). */
export async function agentFiles(directory: string, fs: Fs = nodeFs): Promise<string[]> {
  const seen = new Set<string>()
  return [
    ...(await Promise.all(AGENT_DIRECTORIES.recursive.map((name) => markdownFiles(path.join(directory, name), true, fs, seen)))).flat(),
    ...(await Promise.all(AGENT_DIRECTORIES.flat.map((name) => markdownFiles(path.join(directory, name), false, fs, seen)))).flat(),
  ]
}

export type Bounded = { readonly kind: "ok"; readonly text: string } | { readonly kind: "missing" } | { readonly kind: "large" } | { readonly kind: "other" }

/** A file's text, read only after its size (symlinks followed) is checked: a regular file of at most
 * `limit` bytes. A symlink to a huge file or a device is never read. */
export async function readBounded(file: string, fs: Fs = nodeFs, limit = MAX_BYTES): Promise<Bounded> {
  const info = await fs.stat(file)
  if (info === undefined) return { kind: "missing" }
  if (info.kind !== "file") return { kind: "other" }
  if (info.size > limit) return { kind: "large" }
  const text = await fs.readFile(file)
  if (text === undefined) return { kind: "missing" }
  return text.length > limit ? { kind: "large" } : { kind: "ok", text }
}

/** Project agent files whose text may carry loosening rules (`agentTextLoosens`; a file too large
 * to read counts). What the CLI shows. */
export async function agentPermissionFiles(directory: string, fs: Fs = nodeFs): Promise<string[]> {
  const result: string[] = []
  for (const file of await agentFiles(directory, fs)) {
    const read = await readBounded(file, fs)
    if (read.kind === "large" || (read.kind === "ok" && agentTextLoosens(read.text))) result.push(file)
  }
  return result
}

/** Whether a command template runs shell commands when used: ``!`…` `` (config/plugin/command.ts
 * `shellRegex`). Matched on the whole text, so a file that only mentions one in its front matter or a
 * comment counts too. */
export function hasShellInterpolation(text: string): boolean {
  return /!`[^`]+`/.test(text)
}

/** Every markdown command file under one config directory. */
export async function commandFiles(directory: string, fs: Fs = nodeFs): Promise<string[]> {
  const seen = new Set<string>()
  return (await Promise.all(COMMAND_DIRECTORIES.map((name) => markdownFiles(path.join(directory, name), true, fs, seen)))).flat()
}

/** Project command files that run shell commands when used (`hasShellInterpolation`; a file too large
 * to read counts). Trust holds them back and fingerprints them; the runtime runs their shell only
 * while the folder is trusted and the file is the one that was trusted (kete/command-shell.ts). */
export async function shellCommandFiles(directory: string, fs: Fs = nodeFs): Promise<string[]> {
  const result: string[] = []
  for (const file of await commandFiles(directory, fs)) {
    const read = await readBounded(file, fs)
    if (read.kind === "large" || (read.kind === "ok" && hasShellInterpolation(read.text))) result.push(file)
  }
  return result
}

/** The commands a raw config document defines (`commands`, and the older `command` the loader still
 * migrates, core/src/config/normalize.ts) whose template runs shell commands, by name. */
export function documentShellCommands(document: unknown): Record<string, string> {
  if (!isRecord(document)) return {}
  const found: Record<string, string> = {}
  for (const key of ["command", "commands"]) {
    const commands = document[key]
    if (!isRecord(commands)) continue
    for (const [name, command] of Object.entries(commands))
      if (isRecord(command) && typeof command.template === "string" && hasShellInterpolation(command.template))
        found[key === "command" ? `${name} (command)` : name] = command.template
  }
  return found
}

/** How a held-back shell command is named for a person. */
export function describeShellCommand(where: string, name?: string): string {
  return name === undefined ? `shell commands in command file ${shown(where)}` : `shell commands in command ${shown(name)} (${safe(where)})`
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

export interface DocumentInput {
  readonly path: string
  /** The parsed raw text (pre-substitution). */
  readonly document: unknown
  /** The raw text (its substitution tokens are part of the fingerprint). */
  readonly text?: string
  /** The raw text didn't parse. */
  readonly unparsed?: boolean
}

export interface FingerprintInput {
  /** The working-tree top paths are made relative to. */
  readonly top: string
  /** Every project config document that applies, parsed (pre-substitution). */
  readonly documents: ReadonlyArray<DocumentInput>
  /** Plugin directories (`pluginDirectories`). */
  readonly plugins: ReadonlyArray<string>
  /** Every project agent file (`agentFiles`). */
  readonly agents: ReadonlyArray<string>
  /** Project command files that run shell commands (`shellCommandFiles`); none leaves the
   * fingerprint as it was before commands were covered. */
  readonly commands?: ReadonlyArray<string>
  /** The home directory `{file:~/…}` resolves against (ConfigVariable uses `os.homedir()`). */
  readonly home?: string
}

export type Fingerprint =
  | {
      readonly kind: "ok"
      readonly value: string
      /** Every `{file:…}` target a project document reads (resolved path → its text), from the very
       * bytes that were hashed: substitution reads these, never the file again. */
      readonly files: ReadonlyMap<string, string>
      /** Each plugin directory (as given) → `digest` of its files, from the same read. */
      readonly plugins: ReadonlyMap<string, string>
      /** Each agent file (as given) → sha256 of its bytes, from the same read. */
      readonly agents: ReadonlyMap<string, string>
      /** Each shell command file (as given) → sha256 of its bytes, from the same read. */
      readonly commands: ReadonlyMap<string, string>
      /** Each local plugin a project document configures (`localPluginTargets`) → `targetDigest`. */
      readonly configured: ReadonlyMap<string, string | null>
    }
  | { readonly kind: "unavailable"; readonly reason: string }

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

/** Why a document can't be fingerprinted: its raw text only parses after substitution. */
export function unparsedReason(file: string, top: string): string {
  return `${shown(display(file, top))} can't be read before {env:…}/{file:…} substitution, so what it sets can't be checked`
}

class OverCap extends Error {}

type Hashed = { path: string; sha256: string }

/** Bounded reading shared by `fingerprint` and the digests: sizes are checked before anything is
 * read (a symlink to a huge file or a device can't stall it), and over `MAX_FILES`/`MAX_BYTES` it
 * throws `OverCap`. */
function reader(top: string, fs: Fs) {
  let files = 0
  let bytes = 0
  const read = async (file: string): Promise<Uint8Array | undefined> => {
    const info = await fs.stat(file)
    if (info === undefined) return undefined
    if (info.kind !== "file") throw new OverCap(`${shown(display(file, top))} isn't a regular file`)
    files++
    if (files > MAX_FILES) throw new OverCap(`more than ${MAX_FILES} files to check`)
    if (bytes + info.size > MAX_BYTES) throw new OverCap(`more than ${MAX_BYTES / 1024 / 1024} MiB to check`)
    const data = await fs.readBytes(file)
    if (data === undefined) return undefined
    bytes += data.byteLength
    if (bytes > MAX_BYTES) throw new OverCap(`more than ${MAX_BYTES / 1024 / 1024} MiB to check`)
    return data
  }
  const hash = async (file: string) => {
    const data = await read(file)
    return data === undefined ? undefined : sha256(data)
  }
  const walk = async (directory: string, base: string, seen: Set<string>): Promise<Hashed[]> => {
    const real = await fs.realpath(directory)
    if (seen.has(real)) return []
    seen.add(real)
    const names = (await fs.readDir(directory)) ?? []
    const found: Hashed[] = []
    for (const name of [...names].sort()) {
      const file = path.join(directory, name)
      const info = await fs.stat(file)
      if (info?.kind === "directory") found.push(...(await walk(file, base, seen)))
      else if (info?.kind === "file") {
        const sum = await hash(file)
        if (sum !== undefined) found.push({ path: display(file, base), sha256: sum })
      }
    }
    return found
  }
  const target = async (file: string): Promise<string | null> => {
    const info = await fs.stat(file)
    if (info === undefined) return null
    if (info.kind === "directory") return digestOf(await walk(file, file, new Set()))
    return (await hash(file)) ?? null
  }
  return { read, hash, walk, target }
}

/** One digest over a list of hashed files (paths relative to whatever they were listed from). */
export function digestOf(files: ReadonlyArray<Hashed>): string {
  return sha256(canonical([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))))
}

/** A plugin directory's digest now: every file under it (its `node_modules` included), paths relative
 * to it. `undefined` when it can't be read within the caps. The runtime compares it with the digest
 * taken when the folder's trust was decided before plugin code loads; the TUI compares its own with
 * the runtime's before it imports a project plugin. */
export async function pluginDigest(directory: string, fs: Fs = nodeFs): Promise<string | undefined> {
  try {
    return digestOf(await reader(directory, fs).walk(directory, directory, new Set()))
  } catch {
    return undefined
  }
}

/** The local plugin paths a raw document's `plugins`/`plugin` configure, resolved the way
 * core/src/config/plugin/source.ts resolves them (`file://` URLs, `./`/`../` relative to the document,
 * absolute paths); package names aren't local. */
export function localPluginTargets(document: unknown, documentPath: string): string[] {
  if (!isRecord(document)) return []
  const found: string[] = []
  for (const key of ["plugins", "plugin"]) {
    const value = document[key]
    if (value === undefined) continue
    for (const spec of Array.isArray(value) ? value : [value]) {
      const target = isRecord(spec) ? spec.package : Array.isArray(spec) ? spec[0] : spec
      if (typeof target !== "string" || target.startsWith("-")) continue
      let resolved: string | undefined = target
      if (target.startsWith("file://"))
        try {
          resolved = fileURLToPath(target)
        } catch {
          resolved = undefined
        }
      else if (target.startsWith("./") || target.startsWith("../")) resolved = path.resolve(path.dirname(documentPath), target)
      if (resolved !== undefined && path.isAbsolute(resolved) && !found.includes(resolved)) found.push(resolved)
    }
  }
  return found
}

/** A configured local plugin's digest now: a directory's `pluginDigest`, a file's sha256, `null` when
 * it doesn't exist, `undefined` when it can't be read within the caps (or isn't a file or directory). */
export async function targetDigest(target: string, fs: Fs = nodeFs): Promise<string | null | undefined> {
  try {
    return await reader(target, fs).target(target)
  } catch {
    return undefined
  }
}

/** The digest of a `.kete/` directory's agent files, from their hashes (`hashes`: file → sha256). */
export function agentDigestOf(directory: string, files: ReadonlyArray<string>, hashes: ReadonlyMap<string, string>): string {
  return digestOf(files.flatMap((file) => {
    const sum = hashes.get(file)
    return sum === undefined ? [] : [{ path: display(file, directory), sha256: sum }]
  }))
}

/** A `.kete/` directory's agent files' digest now (`agentDigestOf` over `agentFiles`). */
export async function agentDigest(directory: string, fs: Fs = nodeFs): Promise<string | undefined> {
  try {
    const files = await agentFiles(directory, fs)
    const read = reader(directory, fs)
    const hashes = new Map<string, string>()
    for (const file of files) {
      const sum = await read.hash(file)
      if (sum !== undefined) hashes.set(file, sum)
    }
    return agentDigestOf(directory, files, hashes)
  } catch {
    return undefined
  }
}

/** sha256 over the guarded values, substitution tokens and the files they read, plugin files and
 * agent files (see the header). A document whose tokens sit outside string values (`misplacedToken`)
 * or build a file path from `{env:…}` has none. */
export async function fingerprint(input: FingerprintInput, fs: Fs = nodeFs): Promise<Fingerprint> {
  const read = reader(input.top, fs)
  // Paths are shown from their real location, so a symlinked or differently spelled path (macOS's
  // /var vs /private/var) gives the same fingerprint wherever it is computed.
  const real = (file: string) => fs.realpath(file).catch(() => file)
  const home = input.home ?? os.homedir()
  try {
    const documents: Array<{
      path: string
      guarded: Record<string, unknown>
      tokens?: Tokens
      targets?: Array<{ path: string; sha256: string | null }>
      plugins?: Array<{ path: string; digest: string | null }>
    }> = []
    const contents = new Map<string, string>()
    const sums = new Map<string, string | null>()
    const configured = new Map<string, string | null>()
    for (const item of input.documents) {
      const tokens = item.text === undefined ? { env: [], files: [] } : substitutionTokens(item.text)
      const substitutes = tokens.env.length > 0 || tokens.files.length > 0
      // A document that only parses once substituted can't be checked (a document that parses
      // neither way never loads, so it doesn't matter).
      if (item.unparsed) {
        if (substitutes) return { kind: "unavailable", reason: unparsedReason(item.path, input.top) }
        continue
      }
      if (item.text !== undefined) {
        const misplaced = misplacedToken(item.text, item.path, input.top)
        if (misplaced) return { kind: "unavailable", reason: misplaced }
      }
      // Every target is read once, here; substitution uses these bytes (`files`), never a second read.
      for (const token of tokens.files) {
        if (token.includes("{env:")) return { kind: "unavailable", reason: `${shown(token)} builds a file path from {env:…}` }
        const target = fileTarget(token, item.path, home)
        if (sums.has(target)) continue
        const data = await read.read(target)
        sums.set(target, data === undefined ? null : sha256(data))
        if (data !== undefined) contents.set(target, Buffer.from(data).toString("utf8"))
      }
      const guarded = guardedValues(item.document)
      const shellCommands = documentShellCommands(item.document)
      const runsShell = Object.keys(shellCommands).length > 0
      if (Object.keys(guarded).length === 0 && !substitutes && !runsShell) continue
      const targets: Array<{ path: string; sha256: string | null }> = []
      for (const token of guardedFileTokens(tokens, item.document)) {
        const target = fileTarget(token, item.path, home)
        targets.push({ path: display(await real(target), input.top), sha256: sums.get(target) ?? null })
      }
      // Configured local plugin code is covered by its contents, not just its path.
      const local: Array<{ path: string; digest: string | null }> = []
      for (const target of localPluginTargets(item.document, item.path)) {
        if (!configured.has(target)) configured.set(target, await read.target(target))
        local.push({ path: display(await real(target), input.top), digest: configured.get(target) ?? null })
      }
      documents.push({
        path: display(await real(item.path), input.top),
        guarded,
        ...(substitutes ? { tokens: { env: [...tokens.env].sort(), files: [...tokens.files].sort() }, targets } : {}),
        ...(local.length > 0 ? { plugins: local } : {}),
        ...(runsShell ? { commands: shellCommands } : {}),
      })
    }
    documents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const plugins: Array<{ path: string; files: Hashed[] }> = []
    const pluginDigests = new Map<string, string>()
    for (const directory of [...input.plugins].sort()) {
      const files = await read.walk(directory, directory, new Set())
      plugins.push({ path: display(await real(directory), input.top), files })
      pluginDigests.set(directory, digestOf(files))
    }
    const agents: Hashed[] = []
    const agentHashes = new Map<string, string>()
    for (const file of [...input.agents].sort()) {
      const sum = await read.hash(file)
      if (sum === undefined) continue
      agents.push({ path: display(await real(file), input.top), sha256: sum })
      agentHashes.set(file, sum)
    }
    const commands: Hashed[] = []
    const commandHashes = new Map<string, string>()
    for (const file of [...(input.commands ?? [])].sort()) {
      const sum = await read.hash(file)
      if (sum === undefined) continue
      commands.push({ path: display(await real(file), input.top), sha256: sum })
      commandHashes.set(file, sum)
    }
    plugins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    agents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    commands.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return {
      kind: "ok",
      // `commands` only when there are any, so a folder trusted before commands were covered keeps its fingerprint.
      value: sha256(canonical({ v: 2, documents, plugins, agents, ...(commands.length > 0 ? { commands } : {}) })),
      files: contents,
      plugins: pluginDigests,
      agents: agentHashes,
      commands: commandHashes,
      configured,
    }
  } catch (error) {
    if (error instanceof OverCap) return { kind: "unavailable", reason: error.message }
    return { kind: "unavailable", reason: `couldn't read the folder's files (${(error as NodeJS.ErrnoException).code ?? "error"})` }
  }
}
