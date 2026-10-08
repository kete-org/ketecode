// Builds a command's sandbox policy (policy.ts) from the machine (ADR 0013): real paths, the git
// layout, the toolchain caches, credential paths and the configured extras. Uses `node:fs` directly:
// the sandbox never runs in job mode, where the runtime's file system is wrapped (job-fs-util.ts).
//
// On Linux, protected paths that don't exist yet get a placeholder (`Placeholders`) so bwrap can bind
// them read-only: an empty directory for `.kete`/`.claude`/`.agents`, and for `kete.json(c)` a file
// holding `{}` with mode 000 (the runtime's config loader reads an unreadable file as missing, and a
// root runtime reads an empty object). Placeholders are counted per path and removed, if unchanged,
// when the last command using them ends.

export * as KeteSandboxResolve from "./resolve.js"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { KeteSandboxSettings } from "./settings.js"
import { KeteSandboxSettings as Settings } from "./settings.js"
import type { Hidden, Policy } from "./policy.js"

export type Platform = "darwin" | "linux"

/** Kete Code's own directories (`Global`): never writable; config, data, state and logs never readable. */
export interface KeteDirectories {
  readonly config: string
  readonly data: string
  readonly cache: string
  readonly state: string
  readonly log: string
  readonly bin: string
  readonly tmp: string
  readonly repos: string
}

export interface Input {
  readonly platform: Platform
  readonly home: string
  /** The project's worktree root (writable). */
  readonly workspace: string
  /** Where configuration is looked up from (the runtime location's directory). */
  readonly directory: string
  readonly kete: KeteDirectories
  /** This project's shell output directory: readable, so the agent can search a long output. */
  readonly shellOutput: string
  readonly settings: KeteSandboxSettings.Settings
  readonly network: boolean
  readonly env?: Record<string, string | undefined>
}

/** Credential paths, relative to the home directory, that sandboxed commands can't read. */
export const credentials = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".gnupg",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".config/git/credentials",
  ".config/gh",
  ".config/hub",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".terraform.d/credentials.tfrc.json",
  ".vault-token",
  ".password-store",
  ".config/op",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".local/share/keyrings",
  "Library/Keychains",
] as const

/** Readable after all inside a hidden path: SSH's host keys and client config (not keys). */
export const credentialExceptions = [".ssh/known_hosts", ".ssh/known_hosts2", ".ssh/config"] as const

/** Package-manager and build caches, relative to the home directory (per platform). */
export function caches(platform: Platform, env: Record<string, string | undefined>): string[] {
  const home = [
    ".npm",
    ".bun/install/cache",
    ".pnpm-store",
    ".yarn/berry/cache",
    ".cargo/registry",
    ".cargo/git",
    "go/pkg/mod",
    ".gradle/caches",
    ".m2/repository",
    ".cache/uv",
  ]
  const perPlatform =
    platform === "darwin"
      ? ["Library/Caches/go-build", "Library/Caches/pip", "Library/Caches/Yarn", "Library/pnpm/store", "Library/Caches/deno"]
      : [".cache/go-build", ".cache/pip", ".cache/yarn", ".local/share/pnpm/store", ".cache/deno"]
  const fromEnv = ["GOCACHE", "GOMODCACHE", "npm_config_cache", "PIP_CACHE_DIR", "UV_CACHE_DIR", "BUN_INSTALL_CACHE_DIR"]
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && path.isAbsolute(value))
  return [...home, ...perPlatform, ...fromEnv]
}

/** The configuration names Kete Code loads from each directory it searches (config/discovery.ts). */
export const configNames = [
  { name: ".kete", directory: true },
  { name: ".claude", directory: true },
  { name: ".agents", directory: true },
  { name: "kete.json", directory: false },
  { name: "kete.jsonc", directory: false },
] as const

const exists = (value: string) =>
  fs.lstat(value).then(
    () => true,
    () => false,
  )

/** The real path of `value`, following symlinks through its deepest existing ancestor. */
export async function real(value: string): Promise<string> {
  let existing = path.resolve(value)
  const rest: string[] = []
  for (;;) {
    const resolved = await fs.realpath(existing).catch(() => undefined)
    if (resolved !== undefined) return path.join(resolved, ...rest)
    const parent = path.dirname(existing)
    if (parent === existing) return path.join(existing, ...rest)
    rest.unshift(path.basename(existing))
    existing = parent
  }
}

const within = (child: string, parent: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values)]

/** A git directory's layout: `.git` as a directory, or a linked worktree's `.git` file. */
export interface GitLayout {
  /** `.git` is a directory inside the workspace. */
  readonly local?: string
  /** A linked worktree: its own git directory and the shared one, both outside the workspace. */
  readonly linked?: { readonly gitdir: string; readonly common: string; readonly file: string }
  /** `core.hooksPath`, resolved. */
  readonly hooksPath?: string
}

/** `core.hooksPath` from a git config file's text (a small reader: `[core]` section, `hooksPath = …`). */
export function hooksPath(text: string): string | undefined {
  let section = ""
  let found: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("#") || line.startsWith(";") || line === "") continue
    const header = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line)
    if (header) {
      section = header[1]!.toLowerCase()
      continue
    }
    if (section !== "core") continue
    const entry = /^hookspath\s*=\s*(.*)$/i.exec(line)
    if (!entry) continue
    let value = entry[1]!.replace(/\s+[#;].*$/, "").trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    if (value !== "") found = value
  }
  return found
}

export async function gitLayout(workspace: string, home: string): Promise<GitLayout> {
  const dotgit = path.join(workspace, ".git")
  const stat = await fs.lstat(dotgit).catch(() => undefined)
  let config: string | undefined
  let layout: { local?: string; linked?: GitLayout["linked"] } = {}
  if (stat?.isDirectory()) {
    layout = { local: dotgit }
    config = path.join(dotgit, "config")
  } else if (stat?.isFile()) {
    const text = await fs.readFile(dotgit, "utf8").catch(() => "")
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]
    if (pointer) {
      const gitdir = await real(path.resolve(workspace, pointer))
      const commonText = await fs.readFile(path.join(gitdir, "commondir"), "utf8").catch(() => undefined)
      const common = commonText ? await real(path.resolve(gitdir, commonText.trim())) : gitdir
      layout = { linked: { gitdir, common, file: dotgit } }
      config = path.join(common, "config")
    }
  }
  const hooks = config ? hooksPath(await fs.readFile(config, "utf8").catch(() => "")) : undefined
  const resolvedHooks = hooks ? await real(Settings.expand(hooks, home, workspace)) : undefined
  return { ...layout, ...(resolvedHooks ? { hooksPath: resolvedHooks } : {}) }
}

/** The files in a git directory that run code, existing ones only, for bwrap (seatbelt uses patterns). */
async function gitInternals(directory: string): Promise<string[]> {
  const out: string[] = []
  let budget = 400
  const visit = async (dir: string, depth: number) => {
    for (const name of ["config", "config.worktree", "commondir", "gitdir", "hooks", "info/attributes"]) {
      const candidate = path.join(dir, name)
      if (await exists(candidate)) out.push(candidate)
    }
    if (depth >= 4) return
    for (const group of ["modules", "worktrees"]) {
      const entries = await fs.readdir(path.join(dir, group), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || budget-- <= 0) continue
        await visit(path.join(dir, group, entry.name), depth + 1)
      }
    }
  }
  await visit(directory, 0)
  return out
}

/** Counted placeholders for missing protected paths (Linux). Shared by the whole process (`shared`):
 * two locations whose search paths meet (both under /tmp) must not remove each other's placeholder
 * while a command still relies on it. */
export class Placeholders {
  private readonly held = new Map<string, { count: number; readonly created: Promise<boolean> }>()

  /** Makes sure `target` exists until the returned release function runs. Synchronous bookkeeping
   * first, so two commands asking at once share one placeholder. */
  async acquire(target: string, directory: boolean): Promise<() => Promise<void>> {
    let entry = this.held.get(target)
    if (entry) entry.count++
    else {
      entry = { count: 1, created: create(target, directory) }
      this.held.set(target, entry)
    }
    const current = entry
    try {
      await current.created
    } catch (error) {
      await this.release(target, directory, current)
      throw error
    }
    return () => this.release(target, directory, current)
  }

  private async release(target: string, directory: boolean, entry: { count: number; readonly created: Promise<boolean> }) {
    entry.count--
    if (entry.count > 0) return
    if (this.held.get(target) === entry) this.held.delete(target)
    if (!(await entry.created.catch(() => false))) return
    // Only an unchanged placeholder is removed.
    if (directory) {
      await fs.rmdir(target).catch(() => undefined)
      return
    }
    const stat = await fs.lstat(target).catch(() => undefined)
    if (stat?.isFile() && (stat.mode & 0o777) === 0 && stat.size === PLACEHOLDER.length)
      await fs.unlink(target).catch(() => undefined)
  }
}

const PLACEHOLDER = "{}\n"

/** Creates a placeholder; false if something already exists there. */
async function create(target: string, directory: boolean): Promise<boolean> {
  if (await exists(target)) return false
  try {
    if (directory) await fs.mkdir(target)
    else {
      const handle = await fs.open(target, "wx", 0o600)
      try {
        await handle.writeFile(PLACEHOLDER)
        await handle.chmod(0o000)
      } finally {
        await handle.close()
      }
    }
    return true
  } catch (error) {
    // Created by someone else in between: it exists now, which is all bwrap needs.
    if (await exists(target)) return false
    throw error
  }
}

/** The process's placeholders. */
export const shared = new Placeholders()

export interface Resolved {
  readonly policy: Policy
  /** Removes the placeholders this command created. */
  readonly release: () => Promise<void>
}

export async function resolve(input: Input, placeholders: Placeholders): Promise<Resolved> {
  const env = input.env ?? process.env
  const linux = input.platform === "linux"
  const home = await real(input.home)
  let workspace = await real(input.workspace)
  const directory = await real(input.directory)
  // A project at "/" (a directory outside any repository opened at the root) would make everything writable.
  if (workspace === path.parse(workspace).root) workspace = directory
  const homeRelative = (value: string) => real(path.join(home, value))
  const expand = (value: string) => real(Settings.expand(value, home, workspace))

  // Temp directories: TMPDIR, /tmp, and on macOS the per-user cache directory next to TMPDIR (clang modules, xcrun).
  const tmpCandidates = [os.tmpdir(), env.TMPDIR, "/tmp", "/var/tmp"].filter((value): value is string => !!value)
  const tmp = unique(await Promise.all(tmpCandidates.map(real)))
  if (input.platform === "darwin") {
    const userTemp = tmp.find((value) => value.startsWith("/private/var/folders/") && path.basename(value) === "T")
    if (userTemp) tmp.push(path.join(path.dirname(userTemp), "C"))
  }

  const cacheDirs = input.settings.caches
    ? await Promise.all(caches(input.platform, env).map((value) => (path.isAbsolute(value) ? real(value) : homeRelative(value))))
    : []
  const allowWrite = await Promise.all(input.settings.allowWrite.map(expand))
  const git = await gitLayout(workspace, home)
  const gitExternal = git.linked ? unique([git.linked.gitdir, git.linked.common]) : []

  let writable = unique([workspace, ...tmp, ...cacheDirs, ...allowWrite, ...gitExternal])
  if (linux) writable = (await Promise.all(writable.map(async (value) => ((await exists(value)) ? value : undefined)))).filter(
    (value): value is string => value !== undefined,
  )
  const isWritable = (value: string) => writable.some((root) => within(value, root))

  const kete = await Promise.all(
    [input.kete.config, input.kete.data, input.kete.cache, input.kete.state, input.kete.log, input.kete.bin, input.kete.tmp, input.kete.repos].map(real),
  )
  const denyWrite = await Promise.all(input.settings.denyWrite.map(expand))

  // Where configuration is looked up: the location's directory and its parents, as far as they are writable.
  const chain: string[] = []
  for (let dir = directory; ; dir = path.dirname(dir)) {
    if (isWritable(dir)) chain.push(dir)
    if (path.dirname(dir) === dir) break
  }

  const releases: Array<() => Promise<void>> = []
  try {
    const readOnly: string[] = [...kete, ...denyWrite]
    const pinned: string[] = []
    if (git.hooksPath) readOnly.push(git.hooksPath)

    if (linux) {
      for (const dir of chain)
        for (const item of configNames) {
          const target = path.join(dir, item.name)
          releases.push(await placeholders.acquire(target, item.directory))
          readOnly.push(target)
        }
      const gitDirs = [...(git.local ? [git.local] : []), ...gitExternal]
      for (const gitDir of gitDirs) {
        const hooks = path.join(gitDir, "hooks")
        if (!(await exists(hooks))) await fs.mkdir(hooks).catch(() => undefined)
        readOnly.push(...(await gitInternals(gitDir)))
      }
      if (git.local) pinned.push(git.local)
      if (git.linked) readOnly.push(git.linked.file)
      if (git.hooksPath && !(await exists(git.hooksPath))) await fs.mkdir(git.hooksPath, { recursive: true }).catch(() => undefined)
    } else {
      for (const dir of chain) for (const item of configNames) readOnly.push(path.join(dir, item.name))
    }

    // Credentials, Kete Code's private directories, and configured extras.
    const allowRead = await Promise.all(input.settings.allowRead.map(expand))
    const hiddenPaths = unique([
      ...(await Promise.all(credentials.map(homeRelative))),
      ...(await Promise.all([input.kete.config, input.kete.data, input.kete.state, input.kete.log].map(real))),
      ...(await Promise.all(input.settings.denyRead.map(expand))),
    ]).filter((value) => !allowRead.includes(value))
    const visibleCandidates = unique([
      ...(await Promise.all(credentialExceptions.map(homeRelative))),
      await real(input.shellOutput),
      ...allowRead,
    ]).filter((value) => hiddenPaths.some((hidden) => within(value, hidden) && value !== hidden))

    const hidden: Hidden[] = []
    for (const value of hiddenPaths) {
      const stat = await fs.stat(value).catch(() => undefined)
      if (linux && !stat) continue
      hidden.push({ path: value, directory: stat ? stat.isDirectory() : true })
    }
    const visible = linux
      ? (await Promise.all(visibleCandidates.map(async (value) => ((await exists(value)) ? value : undefined)))).filter(
          (value): value is string => value !== undefined,
        )
      : visibleCandidates

    const readOnlyFinal = unique(readOnly).filter((value) => (linux ? isWritable(value) : true))
    const readOnlyExisting = linux
      ? (await Promise.all(readOnlyFinal.map(async (value) => ((await exists(value)) ? value : undefined)))).filter(
          (value): value is string => value !== undefined,
        )
      : readOnlyFinal

    const policy: Policy = {
      workspace,
      writable,
      readOnly: readOnlyExisting,
      gitDirectories: gitExternal,
      pinned,
      hidden,
      visible,
      network: input.network,
      sockets: unique([workspace, ...tmp]),
    }
    return {
      policy,
      release: async () => {
        for (const release of releases) await release()
      },
    }
  } catch (error) {
    for (const release of releases) await release()
    throw error
  }
}
