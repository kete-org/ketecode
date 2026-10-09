// Which config hooks apply (kete/hooks.ts): `kete.hooks` from every configuration document, split by
// who wrote it. Documents under the global config directory are the user's own and run directly; any
// other document (a repository's `kete.json`, `.kete/`) is project configuration, which runs only
// after the user trusts it. The `kete` object isn't merged across files elsewhere (config-kete
// card); this reads every document, like the sandbox settings do.
//
// What the user trusts (`fingerprint`): every project hook's event, matcher, timeout, network and
// sandbox settings and exact command, plus the contents of every repository file a command names
// (`referencedFiles`: the program, and any argument that is a file in the repository), so editing
// `scripts/hook.sh` asks again.

export * as KeteHooksSettings from "./settings.js"

import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import { ConfigKete } from "@opencode/schema/config/kete"
import type { ConfigPolicy } from "@opencode/schema/config/policy"
import { Wildcard } from "../../util/wildcard.js"

export type Event = ConfigKete.HookEvent
export const events = ConfigKete.HookEvents

export interface Entry {
  readonly event: Event
  readonly command: string
  readonly match?: string
  /** Seconds. */
  readonly timeout: number
  /** Network inside the OS sandbox. */
  readonly network: boolean
  /** `false`: asked to run outside the OS sandbox (honoured only for user hooks). */
  readonly sandbox: boolean
  readonly source: "user" | "project"
}

export interface Document {
  /** The file the document came from; documents without one count as project configuration. */
  readonly path?: string
  readonly hooks?: ConfigKete.Hooks
}

export const DEFAULT_TIMEOUT = 60
/** Bytes of a referenced file hashed; a larger file is hashed up to this and its size recorded. */
export const MAX_HASHED_BYTES = 10 * 1024 * 1024

export function inside(file: string, directory: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Every hook, in document order (lowest priority first), user and project alike. */
export function collect(documents: ReadonlyArray<Document>, globalDirectory: string): Entry[] {
  const result: Entry[] = []
  for (const doc of documents) {
    if (!doc.hooks) continue
    const source = doc.path !== undefined && inside(doc.path, globalDirectory) ? "user" : "project"
    for (const event of events)
      for (const hook of doc.hooks[event] ?? [])
        result.push({
          event,
          command: hook.command,
          ...(hook.match === undefined ? {} : { match: hook.match }),
          timeout: hook.timeout ?? DEFAULT_TIMEOUT,
          network: hook.network === true,
          sandbox: hook.sandbox !== false,
          source,
        })
  }
  return result
}

/** Whether the global config lets trusted project hooks run without an active OS sandbox. */
export function unsandboxedOptIn(documents: ReadonlyArray<Document>, globalDirectory: string) {
  return documents.some((doc) => doc.path !== undefined && inside(doc.path, globalDirectory) && doc.hooks?.unsandboxed === true)
}

// Control characters other than tab, and characters that reorder or hide text (bidi controls).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/
const BIDI = /[؜‎‏‪-‮⁦-⁩]/

/** Why a command can't be shown faithfully in a trust question, if it can't. */
export function unsafeCommand(command: string): string | undefined {
  if (CONTROL.test(command)) return "it contains control characters"
  if (BIDI.test(command)) return "it contains characters that reorder text (bidi controls)"
  return undefined
}

/** Splits a command line into words, honouring simple quotes (enough to find file names). */
export function words(command: string): string[] {
  const result: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)/g
  for (const match of command.matchAll(pattern)) result.push(match[1] ?? match[2] ?? match[3] ?? "")
  return result
}

export interface Referenced {
  /** Relative to the repository, with forward slashes. */
  readonly path: string
  readonly sha256: string
}

/** Repository files a command names (its program or arguments), with their content hashes. */
export async function referencedFiles(command: string, repository: string, cwd: string): Promise<Referenced[]> {
  const root = await fs.realpath(repository).catch(() => path.resolve(repository))
  const seen = new Map<string, Referenced>()
  for (const word of words(command)) {
    if (word === "" || word.startsWith("-") || word.includes("$") || word.includes("%")) continue
    const candidate = path.resolve(cwd, word.replace(/^file:/, ""))
    const real = await fs.realpath(candidate).catch(() => undefined)
    if (real === undefined || !inside(real, root) || seen.has(real)) continue
    const stat = await fs.stat(real).catch(() => undefined)
    if (!stat?.isFile()) continue
    const handle = await fs.open(real, "r").catch(() => undefined)
    if (!handle) continue
    try {
      const length = Math.min(stat.size, MAX_HASHED_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      const hash = createHash("sha256").update(buffer).update(String(stat.size)).digest("hex")
      seen.set(real, { path: path.relative(root, real).split(path.sep).join("/"), sha256: hash })
    } finally {
      await handle.close()
    }
  }
  return [...seen.values()]
}

/** The fingerprint the user trusts: the project hooks and the repository files they name. */
export function fingerprint(entries: ReadonlyArray<Entry>, files: ReadonlyArray<Referenced> = []): string {
  const project = entries
    .filter((entry) => entry.source === "project")
    .map((entry) => [entry.event, entry.match ?? null, entry.timeout, entry.network, entry.sandbox, entry.command])
  const referenced = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, file.sha256])
  return createHash("sha256").update(JSON.stringify({ project, referenced })).digest("hex")
}

/** Whether a tool hook's `match` covers this tool: wildcards, alternatives separated by `|`. */
export function matches(entry: Pick<Entry, "match">, tool: string | undefined): boolean {
  if (entry.match === undefined || tool === undefined) return true
  return entry.match.split("|").some((pattern) => {
    const trimmed = pattern.trim()
    return trimmed !== "" && Wildcard.match(tool, trimmed)
  })
}

type Statement = Pick<ConfigPolicy.Info, "action" | "resource" | "effect">

/**
 * Whether a policy turns this event's hooks off: a `permission` statement denying `hooks:<event>`
 * (or `hooks:*`); the last matching statement wins, as in config/plugin/policy.ts. The caller passes
 * only the global config's and the organization's statements (a repository can't switch off the
 * user's own hooks).
 */
export function disabledByPolicy(policies: ReadonlyArray<Statement>, event: Event) {
  const statement = policies.findLast((policy) => policy.action === "permission" && Wildcard.match(`hooks:${event}`, policy.resource))
  return statement?.effect === "deny"
}

/** Whether a policy denies leaving the OS sandbox (`sandbox_off`) for hooks. */
export function sandboxOffDenied(policies: ReadonlyArray<Statement>) {
  const statement = policies.findLast((policy) => policy.action === "permission" && Wildcard.match("sandbox_off:hook", policy.resource))
  return statement?.effect === "deny"
}

export type Placement =
  | { readonly kind: "sandboxed"; readonly network: boolean }
  | { readonly kind: "unsandboxed" }
  | { readonly kind: "refused"; readonly reason: string }

/** Where a hook runs: in the OS sandbox by default; outside only where allowed (docs/hooks.md). */
export function placement(
  entry: Pick<Entry, "source" | "sandbox" | "network">,
  input: {
    readonly mode: "off" | "auto" | "required"
    readonly available: boolean
    readonly unavailableReason?: string
    readonly projectOptIn: boolean
    readonly policyDeniesSandboxOff: boolean
  },
): Placement {
  const active = input.mode !== "off" && input.available
  const escape = entry.source === "user" && entry.sandbox === false
  if (active && !escape) return { kind: "sandboxed", network: entry.network }
  const why = active ? "it asks to run outside the OS sandbox" : input.mode === "off" ? "the OS sandbox is turned off" : `the OS sandbox isn't available (${input.unavailableReason ?? "unknown"})`
  if (input.policyDeniesSandboxOff) return { kind: "refused", reason: `${why}, and a policy requires the sandbox` }
  if (input.mode === "required" && !input.available) return { kind: "refused", reason: `${why}, and the sandbox is required` }
  if (entry.source === "project" && !input.projectOptIn)
    return { kind: "refused", reason: `${why}; project hooks then run only with kete.hooks.unsandboxed in the global config` }
  return { kind: "unsandboxed" }
}
