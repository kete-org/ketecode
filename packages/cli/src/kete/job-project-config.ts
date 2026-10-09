// `kete job run`'s project-config trust check (task 2026-10-05-unattended-secret-hygiene, B1).
//
// The runtime loads a repository's own config (`kete.json`/`kete.jsonc`, `.kete/`) like any other.
// In an unattended run nobody reviews it, and a repository — a pull request — could use it to send
// prompts and keys elsewhere (a provider's baseURL, apiKey or headers), start its own MCP servers,
// load plugin code into the runtime, turn on session sharing, widen `kete.unattended.passEnv`, or
// configure hooks (`kete.hooks`, which run only once trusted anyway — core/src/kete/hooks.ts).
// So before the run contacts the server (nothing from the repository is loaded yet), this reads the
// files the runtime would load and lists the settings a repository may not control:
//
// - in every directory from the run's directory up to the repository root (only the run's
//   directory outside a repository — the directories above belong to the machine's owner, not the
//   repository): `kete.json`, `kete.jsonc`, `.kete/kete.json`, `.kete/kete.jsonc`, and code in
//   `.kete/plugin/` or `.kete/plugins/` (core/src/plugin/source-directory.ts loads those);
// - the guarded keys are `guardedKeys` below. A file that can't be read or parsed is reported too:
//   the check fails closed rather than guessing what the runtime would make of it.
//
// `job.ts` skips the check for `--trust-project-config` / `KETE_TRUST_PROJECT_CONFIG=1`, and job mode
// never runs it (its server doesn't load project config at all). Global config, `KETE_CONFIG` and
// `KETE_CONFIG_CONTENT` are the machine owner's and aren't inspected.

export * as KeteJobProjectConfig from "./job-project-config"

import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import { parse, type ParseError } from "jsonc-parser"
import { Brand } from "@opencode/util/kete/brand"
import { KeteEnv } from "@opencode/util/kete/env"

/** The internal name of KETE_TRUST_PROJECT_CONFIG (bridged by util/src/kete/env.ts). */
export const trustVariable = "OPENCODE_TRUST_PROJECT_CONFIG"
export const trustPublicName = KeteEnv.publicName(trustVariable)

export interface Finding {
  /** The file (or plugin directory) that sets something a repository may not control. */
  readonly file: string
  /** What it sets, as dotted config paths (`providers.openai`, `mcp.tools`), or why it was refused. */
  readonly keys: ReadonlyArray<string>
}

export interface Fs {
  /** The file's text, or `undefined` when it doesn't exist. Any other failure throws. */
  readonly readFile: (file: string) => Promise<string | undefined>
  /** The directory's entry names, or `undefined` when it doesn't exist. */
  readonly readDir: (directory: string) => Promise<ReadonlyArray<string> | undefined>
}

const missing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

export const nodeFs: Fs = {
  readFile: (file) => readFile(file, "utf8").catch((error) => (missing(error) ? undefined : Promise.reject(error))),
  readDir: (directory) => readdir(directory).catch((error) => (missing(error) ? undefined : Promise.reject(error))),
}

/** Whether the trust override is set: `1` only; anything else (including a typo) is "not trusted". */
export function trusted(flag: boolean, env: Record<string, string | undefined>): boolean {
  return flag || env[trustVariable] === "1"
}

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

/** The directories the runtime's project config walk would visit that the repository controls:
 * `directory` up to and including `stop` (only `directory` when `stop` isn't an ancestor). */
export function directories(directory: string, stop: string): string[] {
  const start = path.resolve(directory)
  const root = path.resolve(stop)
  const relative = path.relative(root, start)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [start]
  const result: string[] = []
  let current = start
  for (;;) {
    result.push(current)
    if (current === root) return result
    const parent = path.dirname(current)
    if (parent === current) return result
    current = parent
  }
}

async function inspectFile(fs: Fs, file: string): Promise<Finding | undefined> {
  let text: string | undefined
  try {
    text = await fs.readFile(file)
  } catch (error) {
    return { file, keys: [`could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`] }
  }
  if (text === undefined) return undefined
  const errors: ParseError[] = []
  const document: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return { file, keys: ["could not be parsed"] }
  const keys = guardedKeys(document)
  return keys.length > 0 ? { file, keys } : undefined
}

async function inspectPlugins(fs: Fs, directory: string): Promise<Finding | undefined> {
  let names: ReadonlyArray<string> | undefined
  try {
    names = await fs.readDir(directory)
  } catch (error) {
    return { file: directory, keys: [`could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`] }
  }
  if (names === undefined || names.length === 0) return undefined
  return { file: directory, keys: ["plugin code"] }
}

/** Every finding in the project config under `directory` (see the header), in walk order. */
export async function inspect(directory: string, stop: string, fs: Fs = nodeFs): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const current of directories(directory, stop)) {
    const project = path.join(current, Brand.projectDirectory)
    const checks = [
      ...Brand.configFiles.map((name) => inspectFile(fs, path.join(current, name))),
      ...Brand.configFiles.map((name) => inspectFile(fs, path.join(project, name))),
      inspectPlugins(fs, path.join(project, "plugin")),
      inspectPlugins(fs, path.join(project, "plugins")),
    ]
    for (const finding of await Promise.all(checks)) if (finding !== undefined) findings.push(finding)
  }
  return findings
}
