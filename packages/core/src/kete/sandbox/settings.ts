// The local sandbox's settings (ADR 0013, docs/sandbox.md): `kete.sandbox` in configuration and
// the KETE_SANDBOX variable, combined so that only the user can loosen them.
//
// A repository's own `.kete/kete.jsonc` is written by whoever wrote the repository, so it may only
// make the sandbox stricter (CLAUDE.md §5: for security policy the more restrictive setting wins):
// `mode` and `network` count only when stricter, `caches: false` counts, `denyRead`/`denyWrite` add
// paths, and `allowWrite`/`allowRead` are ignored (reported in `ignored`). The global config
// (`~/.config/kete/`) and KETE_SANDBOX, which only the user sets, may loosen. The `kete` object
// isn't merged across files elsewhere (config-kete card); this reads every document instead.

export * as KeteSandboxSettings from "./settings.js"

import path from "path"
import type { ConfigKete } from "@opencode/schema/config/kete"
import { KeteEnv } from "@opencode/util/kete/env"

/** The internal name env.ts's bridge renames KETE_SANDBOX to. */
export const variable = "OPENCODE_SANDBOX"
export const publicName = KeteEnv.publicName(variable)

export const modes = ["off", "auto", "required"] as const
export type Mode = (typeof modes)[number]
export const networks = ["all", "approved", "none"] as const
export type Network = (typeof networks)[number]

export interface Settings {
  readonly mode: Mode
  /** Where `mode` came from, for messages. */
  readonly modeSource: "default" | "global config" | typeof publicName | "project config"
  readonly network: Network
  readonly caches: boolean
  readonly allowWrite: ReadonlyArray<string>
  readonly allowRead: ReadonlyArray<string>
  readonly denyRead: ReadonlyArray<string>
  readonly denyWrite: ReadonlyArray<string>
  /** Loosening a project config asked for, and that was ignored. */
  readonly ignored: ReadonlyArray<string>
  /** KETE_SANDBOX held something other than off/auto/required: treated as "required" (fail closed). */
  readonly invalid?: string
}

export interface Document {
  /** The file the document came from; documents without one count as project configuration. */
  readonly path?: string
  readonly sandbox?: ConfigKete.Sandbox
}

const stricter = <T extends string>(order: ReadonlyArray<T>, a: T, b: T) => (order.indexOf(a) >= order.indexOf(b) ? a : b)

function inside(file: string, directory: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Combines the documents (lowest to highest priority) with the environment. `globalDirectory` is
 * the global config directory: documents from there are the user's own.
 */
export function resolve(input: {
  readonly documents: ReadonlyArray<Document>
  readonly globalDirectory: string
  readonly env?: Record<string, string | undefined>
}): Settings {
  const env = input.env ?? process.env
  const user = input.documents.filter((doc) => doc.sandbox && doc.path && inside(doc.path, input.globalDirectory))
  const project = input.documents.filter((doc) => doc.sandbox && !user.includes(doc))
  const ignored: string[] = []

  let mode: Mode = "auto"
  let modeSource: Settings["modeSource"] = "default"
  let network: Network = "approved"
  let caches = true
  const allowWrite: string[] = []
  const allowRead: string[] = []
  const denyRead: string[] = []
  const denyWrite: string[] = []

  for (const doc of user) {
    const sandbox = doc.sandbox!
    if (sandbox.mode) {
      mode = sandbox.mode
      modeSource = "global config"
    }
    if (sandbox.network) network = sandbox.network
    if (sandbox.caches !== undefined) caches = sandbox.caches
    if (sandbox.allowWrite) allowWrite.splice(0, allowWrite.length, ...sandbox.allowWrite)
    if (sandbox.allowRead) allowRead.splice(0, allowRead.length, ...sandbox.allowRead)
    denyRead.push(...(sandbox.denyRead ?? []))
    denyWrite.push(...(sandbox.denyWrite ?? []))
  }

  const raw = env[variable]?.trim()
  let invalid: string | undefined
  if (raw !== undefined && raw !== "") {
    const value = raw.toLowerCase()
    if ((modes as ReadonlyArray<string>).includes(value)) mode = value as Mode
    else {
      invalid = raw.length > 50 ? `${raw.slice(0, 50)}…` : raw
      mode = "required"
    }
    modeSource = publicName
  }

  for (const doc of project) {
    const sandbox = doc.sandbox!
    if (sandbox.mode) {
      const next = stricter(modes, mode, sandbox.mode)
      if (next !== mode) {
        mode = next
        modeSource = "project config"
      } else if (sandbox.mode !== mode) ignored.push(`mode "${sandbox.mode}"`)
    }
    if (sandbox.network) {
      const next = stricter(networks, network, sandbox.network)
      if (next === network && sandbox.network !== network) ignored.push(`network "${sandbox.network}"`)
      network = next
    }
    if (sandbox.caches === false) caches = false
    else if (sandbox.caches === true && !caches) ignored.push("caches true")
    if (sandbox.allowWrite?.length) ignored.push("allowWrite")
    if (sandbox.allowRead?.length) ignored.push("allowRead")
    denyRead.push(...(sandbox.denyRead ?? []))
    denyWrite.push(...(sandbox.denyWrite ?? []))
  }

  return {
    mode,
    modeSource,
    network,
    caches,
    allowWrite,
    allowRead,
    denyRead,
    denyWrite,
    ignored: [...new Set(ignored)],
    ...(invalid !== undefined ? { invalid } : {}),
  }
}

/**
 * An absolute path for a configured one: `~` and `~/…` are the home directory, relative paths are
 * relative to `base` (the workspace). Other `~user` forms aren't expanded and stay relative.
 */
export function expand(value: string, home: string, base: string) {
  if (value === "~") return home
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2))
  return path.resolve(base, value)
}
