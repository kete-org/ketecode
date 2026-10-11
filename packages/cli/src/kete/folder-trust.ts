// Folder trust on the CLI side (task 2026-10-11-folder-trust; docs/folder-trust.md). The runtime holds
// back an untrusted folder's guarded project settings (core/src/kete/folder-trust.ts); this module
// reads the same files the same way (util/src/kete/folder-trust.ts), so `kete trust add` stores the
// fingerprint the runtime will look for, and `kete run` can say what was held back.
//
// - `inspect(directory)`: the project config files the runtime's discovery would load (every
//   directory from `directory` up to the filesystem root: `kete.json(c)` and `.kete/kete.json(c)`,
//   skipping the global config directory), what in them is held back, the trust root, the fingerprint
//   and whether the store trusts it.
// - `connection`: `kete run`/`kete job run --trust-project-config` (or KETE_TRUST_PROJECT_CONFIG=1)
//   trusts for that run only. It needs a private server, which it starts with RUN_TRUST_VARIABLE set to
//   this process's id; the server honours it only when that is its parent (`runTrusted`), so a
//   background service that inherits it never trusts everything. Nothing is stored.

export * as KeteFolderTrustCli from "./folder-trust"

import os from "node:os"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteFolderTrustStore } from "@opencode/util/kete/folder-trust-store"

export interface Paths {
  /** The global config directory (never project config). */
  readonly config: string
  /** Kete Code's state directory (the trust store). */
  readonly state: string
  readonly home: string
}

/** This machine's paths, as the runtime resolves them (util/src/global.ts: KETE_CONFIG_DIR wins). */
export function defaultPaths(env: Record<string, string | undefined> = process.env): Paths {
  return { config: env.OPENCODE_CONFIG_DIR ?? Global.Path.config, state: Global.Path.state, home: Global.Path.home }
}

export interface Inspection {
  readonly directory: string
  readonly root: KeteFolderTrustRules.Root
  /** The store key, when the root resolved. */
  readonly key?: string
  /** What the runtime would hold back while untrusted, for a person to read. */
  readonly held: ReadonlyArray<string>
  readonly fingerprint: KeteFolderTrustRules.Fingerprint
  /** Why this folder can never be trusted (home, filesystem root, too large, unresolvable). */
  readonly refusal?: string
  /** Whether the store trusts this root for this fingerprint. */
  readonly trusted: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const realOr = (fs: KeteFolderTrustRules.Fs, file: string) => fs.realpath(file).catch(() => path.resolve(file))

/** The `allow` rules in a raw document, described (the runtime holds them back while untrusted). */
function allowRules(document: unknown): string[] {
  if (!isRecord(document)) return []
  const items: string[] = []
  for (const key of KeteFolderTrustRules.PERMISSION_KEYS)
    if (key in document)
      for (const rule of KeteFolderTrustRules.rawRules(key, document[key]))
        if (rule.effect === "allow") items.push(KeteFolderTrustRules.describeRule(rule, key))
  for (const group of KeteFolderTrustRules.AGENT_KEYS) {
    const agents = document[group]
    if (!isRecord(agents)) continue
    for (const [name, agent] of Object.entries(agents)) {
      if (!isRecord(agent)) continue
      for (const key of KeteFolderTrustRules.PERMISSION_KEYS)
        if (key in agent)
          for (const rule of KeteFolderTrustRules.rawRules(key, agent[key]))
            if (rule.effect === "allow") items.push(KeteFolderTrustRules.describeRule(rule, `agent ${JSON.stringify(name)}`))
    }
  }
  return items
}

/** The project config files and `.kete/` directories the runtime's discovery would load, like
 * core/src/config/discovery.ts. */
export async function discover(directory: string, paths: Paths, fs: KeteFolderTrustRules.Fs = KeteFolderTrustRules.nodeFs) {
  const start = path.resolve(directory)
  const globalDirectory = await realOr(fs, paths.config)
  const globalFiles = await Promise.all(Brand.configFiles.map((name) => realOr(fs, path.join(paths.config, name))))
  const files: string[] = []
  const directories: string[] = []
  if ((await realOr(fs, start)) === globalDirectory) return { files, directories }
  let current = start
  for (;;) {
    for (const name of Brand.configFiles) {
      const file = path.join(current, name)
      const info = await fs.stat(file)
      if (info?.kind === "file" && !globalFiles.includes(await realOr(fs, file))) files.push(file)
    }
    const project = path.join(current, Brand.projectDirectory)
    const info = await fs.stat(project)
    if (info?.kind === "directory" && (await realOr(fs, project)) !== globalDirectory) {
      directories.push(project)
      for (const name of Brand.configFiles) {
        const file = path.join(project, name)
        if ((await fs.stat(file))?.kind === "file") files.push(file)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return { files, directories }
    current = parent
  }
}

/**
 * Why the documents can't be trusted once substituted, if they can't: each is substituted as the
 * runtime would (`KeteFolderTrustRules.substitute`, from the bytes the fingerprint read) and must set
 * exactly what its raw text showed (`substitutionMismatch`; the runtime checks the same on what it
 * actually loads).
 */
export function substitutionRefusal(
  documents: ReadonlyArray<KeteFolderTrustRules.DocumentInput>,
  files: ReadonlyMap<string, string>,
  top: string,
  env: Record<string, string | undefined>,
  home: string = os.homedir(),
): string | undefined {
  for (const document of documents) {
    if (document.unparsed || document.text === undefined) continue
    const text = KeteFolderTrustRules.substitute(document.text, document.path, files, env, home)
    if (text === undefined)
      return `substituting {env:…}/{file:…} in ${KeteFolderTrustRules.shown(KeteFolderTrustRules.display(document.path, top))} reads a file that wasn't checked`
    const errors: ParseError[] = []
    const substituted: unknown = parse(text, errors, { allowTrailingComma: true })
    // One that doesn't parse once substituted never loads.
    if (errors.length > 0) continue
    const at = KeteFolderTrustRules.substitutionMismatch(document.document, substituted, (token) =>
      files.get(KeteFolderTrustRules.fileTarget(token, document.path, home)),
    )
    if (at !== undefined) return KeteFolderTrustRules.mismatchReason(document.path, top, at)
  }
  return undefined
}

export async function inspect(
  directory: string,
  paths: Paths,
  fs: KeteFolderTrustRules.Fs = KeteFolderTrustRules.nodeFs,
  env: Record<string, string | undefined> = process.env,
): Promise<Inspection> {
  const found = await discover(directory, paths, fs)
  const root = await KeteFolderTrustRules.trustRoot(directory, fs)
  const top = root.kind === "ok" ? root.top : path.resolve(directory)
  const shownPath = (file: string) => KeteFolderTrustRules.display(file, top)
  const documents: KeteFolderTrustRules.DocumentInput[] = []
  const held: string[] = []
  let unparsed: string | undefined
  for (const file of found.files) {
    const read = await KeteFolderTrustRules.readBounded(file, fs)
    if (read.kind === "large") {
      unparsed ??= `${KeteFolderTrustRules.shown(shownPath(file))} is too large to check`
      held.push(`${KeteFolderTrustRules.shown(shownPath(file))} (too large to check)`)
      continue
    }
    if (read.kind !== "ok") continue
    const text = read.text
    const tokens = KeteFolderTrustRules.substitutionTokens(text)
    const errors: ParseError[] = []
    const document: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      // A file that parses neither raw nor substituted never loads; one that only parses substituted
      // can't be checked (the runtime refuses to trust the folder too).
      documents.push({ path: file, document: undefined, text, unparsed: true })
      if (tokens.env.length > 0 || tokens.files.length > 0) {
        unparsed ??= KeteFolderTrustRules.unparsedReason(file, top)
        held.push(`${KeteFolderTrustRules.shown(shownPath(file))} (it can't be read before substitution)`)
      }
      continue
    }
    documents.push({ path: file, document, text })
    held.push(...KeteFolderTrustRules.describeTokens(tokens, shownPath(file)))
    if (KeteFolderTrustRules.runtimeGuarded(document).length === 0) continue
    held.push(...KeteFolderTrustRules.describe(document), ...allowRules(document))
  }
  const plugins: string[] = []
  const agents: string[] = []
  const loosening: string[] = []
  for (const project of found.directories) {
    plugins.push(...(await KeteFolderTrustRules.pluginDirectories(project, fs)))
    agents.push(...(await KeteFolderTrustRules.agentFiles(project, fs)))
    loosening.push(...(await KeteFolderTrustRules.agentPermissionFiles(project, fs)))
  }
  held.push(...plugins.map((item) => `plugin code in ${KeteFolderTrustRules.shown(shownPath(item))}`))
  held.push(...loosening.map((item) => `permission rules in agent file ${KeteFolderTrustRules.shown(shownPath(item))}`))
  const fingerprint = await KeteFolderTrustRules.fingerprint({ top, documents, plugins, agents }, fs)
  if (root.kind !== "ok")
    return { directory, root, held, fingerprint, refusal: root.reason, trusted: false }
  const key = KeteFolderTrustRules.storeKey(root.root)
  const home = await realOr(fs, paths.home)
  const refusal =
    KeteFolderTrustRules.neverTrusted(key, home) ??
    unparsed ??
    (fingerprint.kind === "unavailable" ? fingerprint.reason : substitutionRefusal(documents, fingerprint.files, top, env))
  const trusted =
    refusal === undefined && fingerprint.kind === "ok"
      ? await KeteFolderTrustStore.make(paths.state).trusted(key, fingerprint.value)
      : false
  return { directory, root, key, held, fingerprint, ...(refusal ? { refusal } : {}), trusted }
}

const MAX_WARNING_ITEMS = 200

/** The one-line warning `kete run` prints when the folder's settings are held back. */
export function warning(inspection: Pick<Inspection, "held">): string {
  let names = ""
  let shown = 0
  for (const raw of inspection.held) {
    const item = KeteFolderTrustRules.safe(raw)
    const next = names ? `${names}; ${item}` : item
    if (next.length > MAX_WARNING_ITEMS && shown > 0) break
    names = next.length > MAX_WARNING_ITEMS ? `${next.slice(0, MAX_WARNING_ITEMS)}…` : next
    shown++
  }
  const more = inspection.held.length - shown
  return `Warning: this folder isn't trusted, so ${Brand.displayName} held back its project settings: ${names}${more > 0 ? ` and ${more} more` : ""}. Trust it with \`${Brand.cliName} trust add\`, or for this run only with --trust-project-config.`
}

export type ConnectionArgs = { readonly server?: string; readonly standalone?: boolean }

export type Connection<Args extends ConnectionArgs> =
  | { readonly ok: true; readonly args: Omit<Args, "standalone"> & { readonly standalone?: boolean }; readonly note?: string }
  | { readonly ok: false; readonly message: string }

/**
 * Run trust: a private server that trusts this run's folder, and nothing stored. Sets
 * RUN_TRUST_VARIABLE in `env` (in place) to `pid`, which the server it starts honours only as its
 * parent. `kete run` refuses `--server` with it; `kete job run` keeps `--server` and notes that the
 * attached server applies its own folder trust.
 */
export function connection<Args extends ConnectionArgs>(
  args: Args,
  trusted: boolean,
  command: "run" | "job",
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
): Connection<Args> {
  if (!trusted) return { ok: true, args }
  if (args.server !== undefined) {
    if (command === "run")
      return {
        ok: false,
        message: `--trust-project-config (or KETE_TRUST_PROJECT_CONFIG=1) needs a private server, and --server connects to another one. Drop --server, or trust the folder with \`${Brand.cliName} trust add\`.`,
      }
    return {
      ok: true,
      args,
      note: `Note: --server is set, so that server applies its own folder trust; --trust-project-config covers only ${Brand.cliName} job run's own check of the repository's config.`,
    }
  }
  env[KeteFolderTrustRules.RUN_TRUST_VARIABLE] = String(pid)
  return { ok: true, args: { ...args, standalone: true } }
}

/** Whether a form is the folder-trust question (`kete run` leaves it alone: held back, not cancelled). */
export function isTrustForm(form: { readonly metadata?: Readonly<Record<string, unknown>> }): boolean {
  return form.metadata?.kind === KeteFolderTrustRules.FORM_KIND
}

/** `kete run`: prints `warning` to stderr when this folder's project settings are held back. A failed
 * check says so rather than staying silent. */
export async function warnIfHeld(
  directory: string,
  paths: Paths = defaultPaths(),
  write: (text: string) => void = (text) => process.stderr.write(text),
): Promise<void> {
  let result: Inspection
  try {
    result = await inspect(directory, paths)
  } catch (error) {
    write(`Note: couldn't check whether this folder is trusted (${error instanceof Error ? error.message : String(error)}).\n`)
    return
  }
  if (!result.trusted && result.held.length > 0) write(warning(result) + "\n")
}
