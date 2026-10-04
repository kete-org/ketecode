#!/usr/bin/env bun
// Merge an OpenCode release into Kete Code. Kete-owned; see docs/upstream-sync.md.
//
//   bun run --cwd packages/kete-tools upstream:sync <vX.Y.Z> [--base main] [--verify] [--pr]
//   bun run --cwd packages/kete-tools upstream:sync --continue [--verify] [--pr]
//   bun run --cwd packages/kete-tools upstream:sync --abort
//
// Steps: preflight → create upstream/<tag> from the base branch → merge the tag
// → (stop on conflicts; resolve, then --continue) → pin .opencode-version →
// upstream checks → optional verify (typecheck + tests vs the base) → report
// → optional push and pull request. Nothing is pushed without --pr.

import fs from "node:fs"
import path from "node:path"
import { printResult, runChecks, type CheckResult } from "./check"
import { addedWorkflows, compareVersions, formatVersion, git, gitOk, parseVersion, run, SyncError } from "./lib"

export interface SyncState {
  readonly version: string
  readonly base: string
  readonly baseSha: string
  readonly branch: string
  readonly previous: string
  /** Files whose conflicts were only upstream's version bumps, resolved automatically. */
  readonly autoResolved?: readonly string[]
  /** bun.lock conflicted: upstream's copy was taken and must be regenerated before committing. */
  readonly lockfile?: boolean
}

export interface SyncOptions {
  readonly cwd: string
  readonly version?: string
  readonly base?: string
  readonly resume?: boolean
  readonly verify?: boolean
  readonly pr?: boolean
  /** Remote holding the base branch; its copy must match the local base. Skipped when undefined. */
  readonly origin?: string
  readonly upstreamRemote?: string
  readonly log?: (line: string) => void
  /** Regenerates bun.lock after a lockfile conflict. Defaults to `bun install`. */
  readonly install?: (cwd: string) => { readonly code: number; readonly stderr: string }
}

export type SyncOutcome =
  | { readonly type: "conflicts"; readonly state: SyncState; readonly conflicts: ConflictReport }
  | { readonly type: "done"; readonly state: SyncState; readonly report: string; readonly checks: CheckResult }

export interface ConflictReport {
  /** Conflicted files Kete has changed since the previous release: keep upstream's change and re-apply Kete's. */
  readonly kete: string[]
  /** Conflicted files Kete has not changed: usually take upstream's side. */
  readonly other: string[]
  /** Resolved automatically (version-bump-only hunks, bun.lock). */
  readonly autoResolved: string[]
}

const gitDir = (cwd: string) => git(cwd, "rev-parse", "--absolute-git-dir")
const stateFile = (cwd: string) => path.join(gitDir(cwd), "kete-upstream-sync.json")
export const reportFile = (cwd: string) => path.join(gitDir(cwd), "kete-upstream-sync-report.md")

export function readState(cwd: string): SyncState | undefined {
  const file = stateFile(cwd)
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SyncState) : undefined
}

function writeState(cwd: string, state: SyncState | undefined) {
  const file = stateFile(cwd)
  if (state) fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n")
  else fs.rmSync(file, { force: true })
}

export function sync(options: SyncOptions): SyncOutcome {
  const { cwd } = options
  const log = options.log ?? console.log
  const upstream = options.upstreamRemote ?? "upstream"
  const install = options.install ?? ((dir: string) => run(["bun", "install"], { cwd: dir }))
  let state = options.resume ? resume(cwd) : start(cwd, options, upstream, log)

  if (!options.resume) {
    log(`merging ${state.version} into ${state.branch}`)
    const merge = run(
      ["git", "merge", "--no-ff", "--no-edit", "-m", `chore(upstream): merge OpenCode ${state.version}`, state.version],
      {
        cwd,
      },
    )
    if (merge.code !== 0) {
      if (!gitOk(cwd, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"))
        throw new SyncError(`git merge failed: ${merge.stderr.trim() || merge.stdout.trim()}`)
      // Upstream tags each release on a commit off its main line, so consecutive
      // release tags always conflict on every package.json "version" and bun.lock.
      const auto = autoResolve(cwd)
      state = { ...state, autoResolved: auto.resolved, lockfile: auto.lockfile }
      writeState(cwd, state)
      if (auto.resolved.length) log(`auto-resolved version-bump conflicts in ${auto.resolved.length} file(s)`)
      const conflicts = conflictReport(cwd, state.previous, state.baseSha, auto.resolved)
      if (conflicts.kete.length + conflicts.other.length > 0) return { type: "conflicts", state, conflicts }
    }
  }

  if (gitOk(cwd, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")) {
    if (state.lockfile) {
      log("regenerating bun.lock (bun install)")
      const result = install(cwd)
      if (result.code !== 0)
        throw new SyncError(`bun install failed: ${result.stderr.trim()}`, "fix it, git add bun.lock, then --continue")
      git(cwd, "add", "bun.lock")
    }
    git(cwd, "commit", "--no-edit")
  }

  // Pin the release. Kept as its own commit so the merge commit stays a pure merge.
  fs.writeFileSync(path.join(cwd, ".opencode-version"), `${state.version}\n`)
  git(cwd, "add", ".opencode-version")
  if (!gitOk(cwd, "diff", "--cached", "--quiet"))
    git(cwd, "commit", "-m", `chore(upstream): pin OpenCode ${state.version}`)

  log("running upstream checks")
  const checks = runChecks({ cwd, base: state.baseSha })
  printResult(checks)

  let verification: string | undefined
  if (options.verify) {
    log(`running typecheck and tests against ${state.base} (this takes a while)`)
    const verify = run(["bun", path.join(import.meta.dir, "verify.ts"), "--base", state.baseSha, "--markdown"], { cwd })
    verification = verify.stdout.trim() || verify.stderr.trim()
  }

  const workflows = addedWorkflows(cwd, state.previous, state.version)
  const report = renderReport(cwd, state, checks, workflows, verification)
  fs.writeFileSync(reportFile(cwd), report)
  writeState(cwd, undefined)

  if (options.pr) openPullRequest(cwd, state, report, checks, log)
  return { type: "done", state, report, checks }
}

function start(cwd: string, options: SyncOptions, upstream: string, log: (line: string) => void): SyncState {
  if (readState(cwd)) throw new SyncError("a sync is already in progress", "run with --continue or --abort")
  const version = options.version
  const target = version ? parseVersion(version) : undefined
  if (!version || !target)
    throw new SyncError(`expected an upstream release tag like v2.0.17, got: ${version ?? "(none)"}`)
  const base = options.base ?? "main"

  // Preflight: clean tree, safe remotes, current base.
  if (git(cwd, "status", "--porcelain", "--untracked-files=no"))
    throw new SyncError("the working tree has uncommitted changes", "commit or stash them first")
  const remotes = git(cwd, "remote").split("\n")
  if (!remotes.includes(upstream))
    throw new SyncError(`no "${upstream}" remote`, "git remote add upstream https://github.com/anomalyco/opencode.git")
  const pushUrl = git(cwd, "remote", "get-url", "--push", upstream)
  if (!/^(no_push|DISABLED|no-push)$/i.test(pushUrl))
    throw new SyncError(
      `pushing to "${upstream}" is enabled (${pushUrl})`,
      `git remote set-url --push ${upstream} no_push`,
    )
  const fetchUrl = git(cwd, "remote", "get-url", upstream)
  if (!/anomalyco\/opencode(\.git)?$/.test(fetchUrl))
    log(`warning: ${upstream} points at ${fetchUrl}, not anomalyco/opencode`)

  log(`fetching ${version} from ${upstream}`)
  git(cwd, "fetch", "--no-tags", upstream, `refs/tags/${version}:refs/tags/${version}`)
  if (!gitOk(cwd, "rev-parse", "--verify", "--quiet", `${version}^{commit}`))
    throw new SyncError(`tag ${version} not found on ${upstream}`)

  if (options.origin) {
    git(cwd, "fetch", options.origin, base)
    const local = git(cwd, "rev-parse", base)
    const remote = git(cwd, "rev-parse", `${options.origin}/${base}`)
    if (local !== remote)
      throw new SyncError(`${base} differs from ${options.origin}/${base}`, `update ${base} first (git pull)`)
  }

  const previous = git(cwd, "show", `${base}:.opencode-version`).trim()
  const pinned = parseVersion(previous)
  if (!pinned) throw new SyncError(`${base}:.opencode-version is not a release tag: ${previous}`)
  if (compareVersions(target, pinned) <= 0)
    throw new SyncError(`${version} is not newer than the pinned ${formatVersion(pinned)}`)
  if (!gitOk(cwd, "merge-base", "--is-ancestor", previous, base))
    throw new SyncError(`${base} does not contain the pinned ${previous}; fix .opencode-version first`)

  const branch = `upstream/${version}`
  if (gitOk(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`))
    throw new SyncError(`branch ${branch} already exists`, `delete it or finish that sync`)
  git(cwd, "switch", "--quiet", "-c", branch, base)
  const state: SyncState = { version, base, baseSha: git(cwd, "rev-parse", base), branch, previous }
  writeState(cwd, state)
  return state
}

function resume(cwd: string): SyncState {
  const state = readState(cwd)
  if (!state) throw new SyncError("no sync in progress")
  if (git(cwd, "branch", "--show-current") !== state.branch) throw new SyncError(`expected to be on ${state.branch}`)
  const unresolved = git(cwd, "diff", "--name-only", "--diff-filter=U")
  if (unresolved)
    throw new SyncError(`unresolved conflicts remain:\n${unresolved}`, "resolve them and git add the files")
  const leftover = leftoverConflictMarkers(cwd)
  if (leftover.length > 0)
    throw new SyncError(
      `conflict markers remain in ${leftover.map(([file, line]) => `${file}:${line}`).join(", ")}`,
      "finish resolving them",
    )
  if (
    !gitOk(cwd, "rev-parse", "--verify", "--quiet", "MERGE_HEAD") &&
    !gitOk(cwd, "merge-base", "--is-ancestor", state.version, "HEAD")
  )
    throw new SyncError(`no merge of ${state.version} in progress or committed`, "run --abort and start again")
  return state
}

export function abort(cwd: string) {
  const state = readState(cwd)
  if (!state) throw new SyncError("no sync in progress")
  if (gitOk(cwd, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")) git(cwd, "merge", "--abort")
  git(cwd, "switch", "--quiet", state.base)
  git(cwd, "branch", "-D", state.branch)
  writeState(cwd, undefined)
}

function leftoverConflictMarkers(cwd: string): [string, number][] {
  const staged = git(cwd, "diff", "--cached", "--name-only")
  if (!staged) return []
  const found: [string, number][] = []
  for (const file of staged.split("\n")) {
    const full = path.join(cwd, file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, "utf8")
    const line = text.split("\n").findIndex((l) => /^(<{7}|>{7}) /.test(l))
    if (line !== -1) found.push([file, line + 1])
  }
  return found
}

export function conflictReport(
  cwd: string,
  previous: string,
  baseSha: string,
  autoResolved: string[] = [],
): ConflictReport {
  const files = git(cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean)
  const kete: string[] = []
  const other: string[] = []
  for (const file of files) {
    // Kete's own change since the last synced release, whether or not the file can carry markers.
    const changedByKete = run(["git", "diff", "--quiet", previous, baseSha, "--", file], { cwd }).code !== 0
    ;(changedByKete ? kete : other).push(file)
  }
  return { kete, other, autoResolved }
}

const versionLine = /^\s*"version":\s*"[^"]*",?\s*$/

/**
 * Resolves conflict hunks in which both sides only change a package.json "version"
 * line, taking upstream's. Other hunks are left untouched. Handles merge and diff3
 * conflict styles. Returns the new text and whether any conflict remains.
 */
export function resolveVersionHunks(text: string): { text: string; remaining: number; resolved: number } {
  const out: string[] = []
  const lines = text.split("\n")
  let remaining = 0
  let resolved = 0
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("<<<<<<< ")) {
      out.push(lines[i]!)
      continue
    }
    const block = [lines[i]!]
    const ours: string[] = []
    const theirs: string[] = []
    let section: "ours" | "base" | "theirs" = "ours"
    let j = i + 1
    for (; j < lines.length && !lines[j]!.startsWith(">>>>>>> "); j++) {
      const line = lines[j]!
      block.push(line)
      if (line.startsWith("||||||| ")) section = "base"
      else if (line === "=======") section = "theirs"
      else if (section === "ours") ours.push(line)
      else if (section === "theirs") theirs.push(line)
    }
    block.push(lines[j] ?? "")
    const onlyVersions = (side: string[]) =>
      side.length > 0 && side.every((line) => line.trim() === "" || versionLine.test(line))
    if (j < lines.length && onlyVersions(ours) && onlyVersions(theirs)) {
      out.push(...theirs)
      resolved++
    } else {
      out.push(...block)
      remaining++
    }
    i = j
  }
  return { text: out.join("\n"), remaining, resolved }
}

function autoResolve(cwd: string): { resolved: string[]; lockfile: boolean } {
  const resolved: string[] = []
  let lockfile = false
  for (const file of git(cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean)) {
    if (file === "bun.lock") {
      // Regenerated with `bun install` once every package.json is resolved.
      git(cwd, "checkout", "--theirs", "--", file)
      git(cwd, "add", "--", file)
      resolved.push(file)
      lockfile = true
      continue
    }
    if (path.basename(file) !== "package.json") continue
    const full = path.join(cwd, file)
    const result = resolveVersionHunks(fs.readFileSync(full, "utf8"))
    if (result.resolved === 0 || result.remaining > 0) continue
    fs.writeFileSync(full, result.text)
    git(cwd, "add", "--", file)
    resolved.push(file)
  }
  return { resolved, lockfile }
}

function renderReport(cwd: string, state: SyncState, checks: CheckResult, workflows: string[], verification?: string) {
  const commits = git(cwd, "rev-list", "--count", `${state.previous}..${state.version}`)
  const lines = [
    `## Upstream sync: OpenCode ${state.previous} → ${state.version}`,
    "",
    `Merges ${commits} upstream commit(s) into \`${state.base}\` on \`${state.branch}\` and pins \`.opencode-version\`.`,
    `Upstream changes: https://github.com/anomalyco/opencode/compare/${state.previous}...${state.version}`,
    "",
    "### Automatically resolved conflicts",
    ...(state.autoResolved?.length
      ? [
          "Upstream tags each release off its main line, so every sync conflicts on version bumps. These took upstream's side:",
          ...state.autoResolved.map((file) =>
            file === "bun.lock"
              ? "- `bun.lock`: upstream's copy, regenerated with `bun install`"
              : `- \`${file}\`: \`"version"\` only`,
          ),
        ]
      : ["- none"]),
    "",
    "### Upstream checks",
    ...checks.notes.map((note) => `- ${note}`),
    ...(checks.failures.length === 0 ? ["- ✅ all passed"] : checks.failures.map((failure) => `- ❌ ${failure}`)),
    "",
    "### New upstream GitHub workflows",
    ...(workflows.length === 0
      ? ["- none"]
      : [
          "Inherited workflows are disabled in the repository settings; these new ones start **enabled**. Disable them before merging:",
          ...workflows.map((file) => `- \`${file}\`: \`gh workflow disable ${path.basename(file)}\``),
        ]),
    "",
    "### Typecheck and tests",
    verification ?? "Not run (pass `--verify`, or run `bun run --cwd packages/kete-tools verify --base main`).",
    "",
    "### Reviewer checklist",
    "- [ ] Every conflict resolution kept upstream's change and re-applied the marked Kete edit",
    "- [ ] `docs/upstream-patches.md` updated for any Kete patch that changed shape",
    "- [ ] New upstream features reviewed for hosted-service defaults (opencode.ai endpoints, telemetry)",
  ]
  return lines.join("\n") + "\n"
}

function openPullRequest(
  cwd: string,
  state: SyncState,
  report: string,
  checks: CheckResult,
  log: (line: string) => void,
) {
  if (checks.failures.length > 0)
    throw new SyncError("upstream checks failed; not opening a pull request", "fix them, then rerun with --pr")
  git(cwd, "push", "-u", "origin", state.branch)
  const body = report + "\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"
  const result = run(
    [
      "gh",
      "pr",
      "create",
      "--base",
      state.base,
      "--head",
      state.branch,
      "--title",
      `chore(upstream): sync OpenCode ${state.version}`,
      "--body",
      body,
    ],
    { cwd },
  )
  if (result.code !== 0) throw new SyncError(`gh pr create failed: ${result.stderr.trim()}`)
  log(result.stdout.trim())
}

function printConflicts(outcome: Extract<SyncOutcome, { type: "conflicts" }>) {
  console.log(`\nmerge of ${outcome.state.version} stopped on conflicts.`)
  if (outcome.conflicts.autoResolved.length)
    console.log(
      `(${outcome.conflicts.autoResolved.length} file(s) with only version-bump conflicts were resolved automatically)`,
    )
  if (outcome.conflicts.kete.length) {
    console.log(
      "\nfiles Kete has changed (keep upstream's change, then re-apply Kete's; see docs/upstream-patches.md):",
    )
    for (const file of outcome.conflicts.kete) console.log(`  ${file}`)
  }
  if (outcome.conflicts.other.length) {
    console.log("\nfiles Kete has not changed (usually take upstream's side):")
    for (const file of outcome.conflicts.other) console.log(`  ${file}`)
  }
  console.log("\nresolve, `git add` the files, then: bun run --cwd packages/kete-tools upstream:sync --continue")
  console.log("to give up: bun run --cwd packages/kete-tools upstream:sync --abort")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const has = (name: string) => args.includes(name)
  const value = (name: string) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel")
  try {
    if (has("--abort")) {
      abort(cwd)
      console.log("sync aborted")
      process.exit(0)
    }
    const outcome = sync({
      cwd,
      version: args.find((arg) => /^v\d/.test(arg)),
      base: value("--base"),
      resume: has("--continue"),
      verify: has("--verify"),
      pr: has("--pr"),
      origin: has("--no-origin-check") ? undefined : "origin",
    })
    if (outcome.type === "conflicts") {
      printConflicts(outcome)
      process.exit(3)
    }
    console.log(`\nreport: ${reportFile(cwd)}`)
    process.exit(outcome.checks.failures.length === 0 ? 0 : 1)
  } catch (error) {
    if (error instanceof SyncError) {
      console.error(`error: ${error.message}`)
      if (error.hint) console.error(`hint: ${error.hint}`)
      process.exit(2)
    }
    throw error
  }
}
