// `kete skill add|list|update|remove` (docs/tasks/2026-10-17-kete-skill-commands): skills installed from a
// git repository or a local folder into `.kete/skills/<name>/` (or the global config's `skills/`), pinned
// to a commit in `skills.lock.json`. Everything touching the machine goes through `Deps`, so tests run
// the real flows on temporary folders and real `git` fixtures.
//
// This installs third-party instructions and scripts, so: the source is fetched without running anything
// (no repo hooks, submodules, LFS smudge or credential prompts); only regular files are accepted
// (symlinks, `..` paths and a `.git` folder never are); the person sees every file, scripts marked,
// before anything is written; nothing is written without a yes; files are written without the
// executable bit; and an organization policy (`skill.install`) can deny a source or force the question.
//
// The CLI can't import @opencode/core, so the policy wildcard matcher below mirrors
// core/src/util/wildcard.ts (and util's `frontmatter` mirrors core's front-matter rules): keep them in step.
// Exit codes (as kete trust): 0 done, 1 failed (git, I/O), 2 refused or bad input; a refusal writes nothing.

export * as KeteSkillFlow from "./skill-flow"

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteRedact } from "@opencode/util/kete/redact"
import { KeteSkillLock } from "@opencode/util/kete/skill-lock"
import { KeteSkillSource } from "@opencode/util/kete/skill-source"
import type { SyncedPolicy } from "@opencode/util/kete/sync/contract"
import { KeteSyncPolicy } from "@opencode/util/kete/sync/policy"
import { KeteSyncSkills } from "@opencode/util/kete/sync/skills"
import { JobGit } from "./job-git"

export const EXIT = { ok: 0, failed: 1, refused: 2 } as const

/** Organization policies: undefined when nobody is signed in (none apply), "no-cache" when signed in but never synced. */
export type PolicyInput = readonly SyncedPolicy[] | "no-cache" | undefined

export interface Deps {
  readonly cwd: string
  /** The global config directory (`~/.config/kete`). */
  readonly globalDir: string
  /** Where temporary clones go. */
  readonly tmp: string
  readonly interactive: boolean
  readonly confirm: (message: string) => Promise<boolean>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  /** Throws when the policy can't be read: the flow then refuses. */
  readonly policies: () => Promise<PolicyInput>
  /** Slugs of the organization-synced skills (read-only). */
  readonly orgSkills: () => Promise<ReadonlySet<string>>
  readonly git?: typeof JobGit.run
  /** Extra environment for git (tests). */
  readonly gitEnv?: Record<string, string>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly now?: () => Date
}

export interface Options {
  readonly global: boolean
  readonly yes: boolean
}

const MAX_FILES = 256
const MAX_BYTES = 10 * 1024 * 1024
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".psm1", ".bat", ".cmd", ".exe"])
const show = KeteFolderTrustRules.safe
const cli = Brand.cliName

class Refused extends Error {
  override readonly name = "Refused"
}
const refuse = (message: string): never => {
  throw new Refused(message)
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const inside = (root: string, file: string) => file.startsWith(root + path.sep)

/** Mirrors core/src/util/wildcard.ts `match`; `ignoreCase` for git sources, whose resource is lower-case (a pattern written `github.com/Acme/*` must still match). */
function match(input: string, pattern: string, ignoreCase = process.platform === "win32") {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", ignoreCase ? "si" : "s").test(input.replaceAll("\\", "/"))
}

/** Runs one subcommand's work: a refusal is exit 2, anything else exit 1; messages never carry credentials. */
async function guard(deps: Deps, work: () => Promise<void>): Promise<number> {
  try {
    await work()
    return EXIT.ok
  } catch (error) {
    const message = KeteRedact.text(error instanceof Error ? error.message : String(error))
    const refused = error instanceof Refused || error instanceof KeteSkillSource.SourceError
    deps.err(`${cli} skill: ${message.split(/\r?\n/).map(show).join("\n")}\n`)
    return refused ? EXIT.refused : EXIT.failed
  }
}

const scopeOf = (deps: Deps, options: Pick<Options, "global">) => (options.global ? deps.globalDir : path.join(deps.cwd, Brand.projectDirectory))
const skillsOf = (scope: string) => path.join(scope, "skills")
const isLink = (file: string) => lstat(file).then((info) => info.isSymbolicLink(), () => false)

/**
 * The scope to install into. A project's `.kete`, `.kete/skills` and lockfile come from the repository, so a
 * symlink there (`.kete/skills -> ../../../.config`) would aim an install, update or remove at folders outside
 * the project: refuse symlinks and anything that resolves outside it. The global scope is the person's own.
 */
async function scopeFor(deps: Deps, options: Pick<Options, "global">) {
  const scope = scopeOf(deps, options)
  if (options.global) return scope
  for (const file of [scope, skillsOf(scope), KeteSkillLock.file(scope)])
    if (await isLink(file)) refuse(`${show(file)} is a symlink; ${cli} only installs skills into a real folder inside the project`)
  const [root, real] = await Promise.all([realpath(deps.cwd), realpath(scope).catch(() => undefined)])
  if (real !== undefined && !real.startsWith(root + path.sep)) refuse(`${show(scope)} resolves outside the project`)
  return scope
}

/** `skills/<name>` in the scope; a symlink there is refused (update would read through it). */
async function targetFor(scope: string, name: string) {
  const target = path.join(skillsOf(scope), name)
  if (await isLink(target)) refuse(`${show(target)} is a symlink; not touching it`)
  return target
}

// ---- policy and confirmation ----

/** Whether the person must be asked even with --yes. Throws Refused on a deny or an unreadable policy. */
async function policyGate(deps: Deps, source: KeteSkillSource.Source): Promise<boolean> {
  const resource = KeteSkillSource.policyResource(source)
  const policies = await deps.policies().catch((error: unknown) =>
    refuse(`the organization policy can't be read (${error instanceof Error ? error.message : String(error)}); not installing`),
  )
  if (policies === undefined) return false
  if (policies === "no-cache") {
    deps.out(`Your organization's policy hasn't been synced yet, so you'll be asked first. Run \`${cli} sync\` to fetch it.\n`)
    return true
  }
  const ignoreCase = source.kind === "git" || process.platform === "win32"
  const decision = KeteSyncPolicy.evaluate(policies, { action: "skill.install", resources: [resource], environment: "development" }, (input, pattern) =>
    match(input, pattern, ignoreCase),
  ).enforced
  if (decision?.effect === "deny") refuse(`your organization's policy "${decision.policy.name}" doesn't allow skills from ${resource}`)
  return decision?.effect === "ask"
}

/** Stops with Refused unless the person says yes (--yes counts, unless `force`). */
async function approve(deps: Deps, question: string, options: { yes: boolean; force: boolean }) {
  if (options.yes && !options.force) return
  if (!deps.interactive)
    refuse(`${question} needs your confirmation: run it in a terminal${options.force ? " (your organization's policy requires it, even with --yes)" : ` or pass --yes`}`)
  if (!(await deps.confirm(question))) refuse("cancelled; nothing was changed")
}

// ---- git ----

interface Workspace {
  readonly root: string
  readonly hooks: string
  readonly clone: string
}

async function withWorkspace<T>(deps: Deps, work: (workspace: Workspace) => Promise<T>) {
  const root = await mkdtemp(path.join(deps.tmp, "kete-skill-"))
  try {
    const hooks = path.join(root, "hooks")
    await mkdir(hooks)
    return await work({ root, hooks, clone: path.join(root, "clone") })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }

/** One git call with hooks, submodule recursion and LFS filters off and no credential prompts. Never throws on a non-zero exit. */
function git(deps: Deps, workspace: Workspace, cwd: string, args: string[]) {
  // Only https and ssh (no ext::, file:// or remote helpers), and no redirects: git fetches the URL the policy checked.
  const config = [
    ...["-c", `core.hooksPath=${workspace.hooks}`, "-c", "submodule.recurse=false"],
    ...["-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false"],
    ...["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "http.followRedirects=false"],
  ]
  return (deps.git ?? JobGit.run)(cwd, [...config, ...args], {
    timeoutMs: deps.timeoutMs ?? 120_000,
    signal: deps.signal,
    childEnv: { ...GIT_ENV, ...deps.gitEnv },
  })
}

function succeeded(result: JobGit.Result, what: string, source: KeteSkillSource.Source) {
  if (result.exitCode === 0) return result.stdout
  const scrub = (text: string) => (source.kind === "git" ? text.replaceAll(source.url, KeteSkillSource.display(source)) : text)
  if (result.timedOut) throw new Error(`git ${what} timed out`)
  throw new Error(`git ${what} failed: ${scrub(result.stderr.trim() || `exit code ${result.exitCode}`)}`)
}

/** Fetches `ref` (default HEAD) of a git source into the workspace's clone folder and returns the commit. */
async function fetchGit(deps: Deps, workspace: Workspace, source: KeteSkillSource.Source & { kind: "git" }, ref: string | undefined) {
  const run = (cwd: string, args: string[], what: string) => git(deps, workspace, cwd, args).then((result) => succeeded(result, what, source))
  await run(workspace.root, ["init", "-q", workspace.clone], "init")
  const first = await git(deps, workspace, workspace.clone, ["fetch", "--depth", "1", "--no-tags", "-q", "--", source.url, ref ?? "HEAD"])
  if (first.exitCode === 0) {
    await run(workspace.clone, ["checkout", "--detach", "-q", "FETCH_HEAD"], "checkout")
  } else if (!first.timedOut && KeteSkillSource.pinned(ref)) {
    // A server may refuse to serve an unadvertised commit at depth 1: fetch it all, then check it out.
    await run(workspace.clone, ["fetch", "--no-tags", "-q", "--", source.url], "fetch")
    await run(workspace.clone, ["checkout", "--detach", "-q", ref!], "checkout")
  } else {
    succeeded(first, "fetch", source)
  }
  return (await run(workspace.clone, ["rev-parse", "HEAD"], "rev-parse")).trim()
}

/** The commit a ref points at on the remote, without cloning; undefined if it can't be told. */
async function remoteCommit(deps: Deps, workspace: Workspace, source: KeteSkillSource.Source & { kind: "git" }, ref: string | undefined) {
  const result = await git(deps, workspace, workspace.root, ["ls-remote", "--", source.url, ref ?? "HEAD"])
  if (result.exitCode !== 0) return undefined
  // An annotated tag lists the tag object first and the commit it points at as `<ref>^{}`.
  const lines = result.stdout.split("\n")
  const line = lines.find((entry) => entry.endsWith("^{}")) ?? lines[0]
  return /^([0-9a-f]{40,64})\s/.exec(line ?? "")?.[1]
}

// ---- reading a skill folder ----

interface Item {
  readonly rel: string
  readonly data: Buffer
  readonly script: boolean
}

/** Every file of the folder (read once, so what is reviewed is what is written), or Refused. */
async function collect(folder: string): Promise<Item[]> {
  const items: Item[] = []
  let total = 0
  const root = await realpath(folder)
  const visit = async (directory: string, prefix: string): Promise<void> => {
    // A folder swapped for a symlink after its lstat must not pull in files from elsewhere.
    const real = await realpath(directory)
    if (real !== root && !inside(root, real)) refuse(`${show(prefix)} moved outside the skill while it was read`)
    for (const entry of (await readdir(directory)).toSorted()) {
      if (entry === ".git") continue
      const rel = prefix === "" ? entry : `${prefix}/${entry}`
      if (entry.includes("\\") || entry.includes("\0")) refuse(`${show(rel)} has a name that isn't allowed in a skill`)
      const absolute = path.join(directory, entry)
      const info = await lstat(absolute)
      if (info.isDirectory()) {
        await visit(absolute, rel)
        continue
      }
      if (!info.isFile()) refuse(`${show(rel)} is a symlink or special file; a skill may only contain regular files`)
      if (rel !== "SKILL.md" && KeteSyncSkills.safeRelative(rel) === undefined) refuse(`${show(rel)} is not an allowed path in a skill`)
      if (items.length >= MAX_FILES) refuse(`the skill has more than ${MAX_FILES} files`)
      // Open without following a symlink (or blocking on a FIFO) and check what was opened, so a file swapped
      // after lstat can't smuggle in another one; a hard link could be any file of the person's, so it is
      // refused too. shortcut: Windows has no O_NOFOLLOW, so only the lstat guards it there.
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() =>
        refuse(`${show(rel)} changed while it was read; try again`),
      )
      const data = await (async () => {
        try {
          const opened = await handle.stat()
          if (!opened.isFile()) refuse(`${show(rel)} is a symlink or special file; a skill may only contain regular files`)
          if (opened.nlink > 1) refuse(`${show(rel)} is a hard link; a skill may only contain plain files`)
          if (total + opened.size > MAX_BYTES) refuse(`the skill is larger than ${MAX_BYTES / 1024 / 1024} MiB`)
          return await handle.readFile()
        } finally {
          await handle.close()
        }
      })()
      total += data.length
      if (total > MAX_BYTES) refuse(`the skill is larger than ${MAX_BYTES / 1024 / 1024} MiB`)
      const script =
        (data[0] === 0x23 && data[1] === 0x21) ||
        (process.platform !== "win32" && (info.mode & 0o111) !== 0) ||
        SCRIPT_EXTENSIONS.has(path.extname(entry).toLowerCase())
      items.push({ rel, data, script })
    }
  }
  await visit(root, "")
  return items
}

interface Prepared {
  readonly name: string
  readonly description?: string
  readonly items: readonly Item[]
  readonly hashes: Record<string, string>
  readonly commit?: string
}

/** Fetches (git) or opens (local) the source, finds the skill folder and validates it. */
async function prepare(
  deps: Deps,
  workspace: Workspace,
  source: KeteSkillSource.Source,
  input: { path?: string; ref?: string; name?: string },
): Promise<Prepared> {
  let base: string
  let commit: string | undefined
  if (source.kind === "git") {
    commit = await fetchGit(deps, workspace, source, input.ref)
    base = workspace.clone
  } else {
    base = source.path
  }
  let folder = base
  const sub = input.path
  if (sub !== undefined) {
    if (KeteSyncSkills.safeRelative(sub) === undefined) refuse(`--path ${show(sub)} must be a folder path inside the source`)
    folder = path.join(base, sub)
    const [real, inside] = await Promise.all([realpath(folder), realpath(base)]).catch(() => refuse(`${show(sub)} is not in the source`))
    if (!real.startsWith(inside + path.sep)) refuse(`${show(sub)} leaves the source folder`)
    if (!(await stat(folder)).isDirectory()) refuse(`${show(sub)} is not a folder`)
  }
  const items = await collect(folder)
  const skill = items.find((item) => item.rel === "SKILL.md")
  if (!skill) return refuse(`no SKILL.md at the top of ${input.path !== undefined ? show(input.path) : "the source"}`)
  const front = KeteSkillSource.frontmatter(skill.data.toString("utf8"))
  const fallback = path.basename(input.path !== undefined ? folder : source.kind === "local" ? source.path : KeteSkillSource.policyResource(source))
  const name = input.name ?? front.name ?? fallback
  if (!KeteSkillSource.validName(name))
    refuse(`${show(JSON.stringify(name))} isn't a usable skill name (lower-case letters, digits, . _ -; up to 64); pass --name`)
  return { name, description: front.description, items, hashes: Object.fromEntries(items.map((item) => [item.rel, sha256(item.data)])), commit }
}

function describeFiles(deps: Deps, items: readonly Item[], only?: readonly string[]) {
  for (const item of items) {
    if (only && !only.includes(item.rel)) continue
    deps.out(`    ${show(item.rel)}  ${item.data.length} bytes${item.script ? "  [script]" : ""}\n`)
  }
}

async function install(scope: string, name: string, items: readonly Item[]) {
  const staging = path.join(scope, `.kete-skill-tmp-${randomUUID()}`)
  const target = path.join(skillsOf(scope), name)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    for (const item of items) {
      const destination = path.join(staging, ...item.rel.split("/"))
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      // Never executable: running a skill's script then needs a shell command, which goes through the permission rules.
      await writeFile(destination, item.data, { mode: 0o600 })
    }
    await mkdir(skillsOf(scope), { recursive: true, mode: 0o700 })
    const old = path.join(scope, `.kete-skill-old-${randomUUID()}`)
    const hadOld = await rename(target, old).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    await KeteSkillLock.renameRetry(staging, target).catch(async (error: unknown) => {
      if (hadOld) await rename(old, target)
      throw error
    })
    if (hadOld) await rm(old, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** The lockfile; one this version can't read is a refusal (never overwritten). */
const readLock = (scope: string) => KeteSkillLock.read(scope).catch((error: unknown) => refuse(error instanceof Error ? error.message : String(error)))

const exists = (file: string) => lstat(file).then(() => true, () => false)

/** The lockfile's source, held to the same rules as `add` (someone may have edited the file). */
function sourceOf(entry: KeteSkillLock.Entry): KeteSkillSource.Source {
  if (entry.commit === undefined) {
    if (!path.isAbsolute(entry.source)) refuse(`the lockfile's source ${show(entry.source)} isn't an absolute folder path`)
    return { kind: "local", path: entry.source }
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(entry.commit)) refuse(`the lockfile's commit ${show(entry.commit)} isn't a commit id`)
  return { kind: "git", url: KeteSkillSource.gitUrl(entry.source) }
}


function flagChecks(source: KeteSkillSource.Source, input: { ref?: string; path?: string; name?: string }) {
  if (input.ref !== undefined && (input.ref.startsWith("-") || input.ref === "")) refuse("--ref must be a branch, tag or commit")
  if (input.ref !== undefined && source.kind === "local") refuse("--ref only applies to a git source")
  if (input.path?.startsWith("-")) refuse("--path must be a folder path inside the source")
  if (input.name !== undefined && !KeteSkillSource.validName(input.name)) refuse("--name must be lower-case letters, digits, . _ -; up to 64")
}

// ---- subcommands ----

export function add(deps: Deps, input: { source: string; path?: string; ref?: string; name?: string }, options: Options) {
  return guard(deps, async () => {
    const source = await KeteSkillSource.parse(input.source, deps.cwd)
    flagChecks(source, input)
    const force = await policyGate(deps, source)
    const scope = await scopeFor(deps, options)
    const lock = await readLock(scope)
    await withWorkspace(deps, async (workspace) => {
      const found = await prepare(deps, workspace, source, input)
      if ((await deps.orgSkills()).has(found.name)) refuse(`${found.name} is a skill your organization manages; pick another name with --name`)
      if (lock.skills[found.name]) refuse(`${found.name} is already installed; run \`${cli} skill update ${found.name}\``)
      const target = await targetFor(scope, found.name)
      if (await exists(target)) refuse(`${show(target)} already exists and wasn't installed by ${cli}; pick another name with --name or remove it yourself`)
      deps.out(`Skill ${show(found.name)}${found.description ? `: ${show(found.description)}` : ""}\n`)
      deps.out(`  from ${show(KeteSkillSource.display(source))}${input.path ? ` (${show(input.path)})` : ""}${found.commit ? ` at ${found.commit}` : ""}\n`)
      deps.out(`  into ${show(target)}\n  ${found.items.length} ${found.items.length === 1 ? "file" : "files"}:\n`)
      describeFiles(deps, found.items)
      if (found.items.some((item) => item.script))
        deps.out(`  Files marked [script] can run code if the agent is told to. They are installed without the executable bit.\n`)
      await approve(deps, `Install skill ${found.name}?`, { yes: options.yes, force })
      // Checked again: the question may stay open a long time, and the folders may change meanwhile.
      await scopeFor(deps, options)
      await targetFor(scope, found.name)
      if (await exists(target)) refuse(`${show(target)} appeared while you were asked; nothing was changed`)
      await install(scope, found.name, found.items)
      await KeteSkillLock.upsert(scope, found.name, {
        source: KeteSkillSource.display(source),
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(found.commit !== undefined ? { commit: found.commit } : {}),
        files: found.hashes,
        installedAt: (deps.now?.() ?? new Date()).toISOString(),
      }).catch(async (error: unknown) => {
        await rm(target, { recursive: true, force: true })
        throw error
      })
      deps.out(`Installed ${show(found.name)}.\n`)
    })
  })
}

export function list(deps: Deps, options: Pick<Options, "global">) {
  return guard(deps, async () => {
    const scope = await scopeFor(deps, options)
    const lock = await readLock(scope)
    const tracked = Object.entries(lock.skills)
    const folders = async (directory: string) =>
      (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name)
    const local = [...new Set([...(await folders(skillsOf(scope))), ...(await folders(path.join(scope, "skill")))])].filter((name) => !lock.skills[name]).toSorted()
    const org = [...(await deps.orgSkills())].toSorted()
    if (tracked.length + local.length + org.length === 0) {
      deps.out(`No skills found. Install one with \`${cli} skill add <source>\`.\n`)
      return
    }
    for (const [name, entry] of tracked)
      deps.out(`${show(name)}  ${show(entry.source)}${entry.path ? ` (${show(entry.path)})` : ""}${entry.commit ? ` @ ${show(entry.commit.slice(0, 12))}` : ""}${KeteSkillSource.pinned(entry.ref) ? "  pinned" : ""}\n`)
    for (const name of local) deps.out(`${show(name)}  local (not tracked)\n`)
    for (const name of org) deps.out(`${show(name)}  org (read-only)\n`)
  })
}

export function remove(deps: Deps, name: string, options: Options) {
  return guard(deps, async () => {
    if (!KeteSkillSource.validName(name)) refuse(`${show(JSON.stringify(name))} isn't a skill name`)
    const scope = await scopeFor(deps, options)
    const lock = await readLock(scope)
    if (!lock.skills[name]) {
      if ((await deps.orgSkills()).has(name)) refuse(`${name} is managed by your organization and can't be removed here`)
      return refuse(`${name} wasn't installed with \`${cli} skill add\` in this scope; ${cli} only removes skills it installed, since a folder you made may be your own work`)
    }
    const target = await targetFor(scope, name)
    await approve(deps, `Remove skill ${name}?`, { yes: options.yes, force: false })
    await scopeFor(deps, options)
    await targetFor(scope, name)
    await rm(target, { recursive: true, force: true })
    await KeteSkillLock.remove(scope, name)
    deps.out(`Removed ${show(name)}.\n`)
  })
}

export async function update(deps: Deps, name: string | undefined, options: Options) {
  let lock: KeteSkillLock.Lock | undefined
  let scope = ""
  const read = await guard(deps, async () => {
    scope = await scopeFor(deps, options)
    lock = await readLock(scope)
    if (name !== undefined && !lock.skills[name]) {
      if ((await deps.orgSkills()).has(name)) refuse(`${name} is managed by your organization and can't be updated here`)
      refuse(`${show(name)} wasn't installed with \`${cli} skill add\` in this scope`)
    }
    if (Object.keys(lock.skills).length === 0) deps.out(`No skills installed with ${cli}.\n`)
  })
  if (read !== EXIT.ok || lock === undefined) return read
  let code: number = EXIT.ok
  for (const [skill, entry] of Object.entries(lock.skills)) {
    if (name !== undefined && skill !== name) continue
    code = Math.max(code, await guard(deps, () => updateOne(deps, scope, skill, entry, options)))
  }
  return code
}

async function updateOne(deps: Deps, scope: string, name: string, entry: KeteSkillLock.Entry, options: Options) {
  if (!KeteSkillSource.validName(name)) refuse(`the lockfile names ${show(JSON.stringify(name))}, which isn't a skill name; not touching it`)
  if (KeteSkillSource.pinned(entry.ref)) return void deps.out(`${show(name)} is pinned to ${show(entry.ref ?? "")}; nothing to update.\n`)
  const source = sourceOf(entry)
  // A project lockfile comes with the repository: copying a folder from elsewhere on this machine into the
  // project is the person's call every time, --yes or not.
  const outside = !options.global && source.kind === "local" && !inside(await realpath(deps.cwd), source.path)
  const force = (await policyGate(deps, source)) || outside
  const target = await targetFor(scope, name)
  // Files edited (or deleted) since install; a lockfile path that isn't a safe one inside the skill is refused.
  const edited: string[] = []
  for (const [rel, hash] of Object.entries(entry.files)) {
    if (rel !== "SKILL.md" && KeteSyncSkills.safeRelative(rel) === undefined) refuse(`the lockfile lists ${show(rel)}, which isn't a path inside the skill`)
    const file = path.join(target, ...rel.split("/"))
    const info = await lstat(file).catch(() => undefined)
    const data = info?.isFile() && info.size <= MAX_BYTES ? await readFile(file).catch(() => undefined) : undefined
    if (data === undefined || sha256(data) !== hash) edited.push(rel)
  }
  await withWorkspace(deps, async (workspace) => {
    if (source.kind === "git" && (await remoteCommit(deps, workspace, source, entry.ref)) === entry.commit)
      return void deps.out(`${show(name)} is up to date${edited.length ? `, but ${edited.length} of its files were edited locally` : ""}.\n`)
    const next = await prepare(deps, workspace, source, { path: entry.path, ref: entry.ref, name })
    const changes = KeteSkillLock.diff(entry.files, next.hashes)
    if (changes.added.length + changes.removed.length + changes.changed.length === 0)
      return void deps.out(`${show(name)} is up to date.\n`)
    deps.out(`Update ${show(name)}${next.commit ? ` ${show(entry.commit?.slice(0, 12) ?? "?")} -> ${next.commit.slice(0, 12)}` : ""}\n`)
    deps.out(`  from ${show(KeteSkillSource.display(source))}\n  into ${show(target)}\n`)
    if (edited.length > 0) {
      deps.out(`  Edited since install (an update overwrites them):\n`)
      for (const rel of edited) deps.out(`    ${show(rel)}\n`)
    }
    deps.out(`  added:\n`)
    describeFiles(deps, next.items, changes.added)
    deps.out(`  changed:\n`)
    describeFiles(deps, next.items, changes.changed)
    deps.out(`  removed:\n`)
    for (const rel of changes.removed) deps.out(`    ${show(rel)}\n`)
    await approve(deps, `Update skill ${name}?`, { yes: options.yes, force: force || edited.length > 0 })
    await scopeFor(deps, options)
    await targetFor(scope, name)
    await install(scope, name, next.items)
    await KeteSkillLock.upsert(scope, name, {
      ...entry,
      ...(next.commit !== undefined ? { commit: next.commit } : {}),
      files: next.hashes,
      installedAt: (deps.now?.() ?? new Date()).toISOString(),
    }).catch((error: unknown) => {
      throw new Error(`${name}'s files were updated but the lockfile couldn't be written (${error instanceof Error ? error.message : String(error)}); run \`${cli} skill update ${name}\` again`)
    })
    deps.out(`Updated ${show(name)}.\n`)
  })
}
