#!/usr/bin/env bun
// Upstream-hygiene checks for Kete Code. Kete-owned; see docs/upstream-sync.md.
//
//   bun run --cwd packages/kete-tools upstream:check [--base <ref>] [--upstream <tag>]
//
// 1. pin      .opencode-version names an upstream release that HEAD contains
// 2. markers  every edit to an upstream file carries a kete_change marker; edits to
//             files that cannot hold comments are listed in docs/upstream-patches.md.
//             Compares the working tree (tracked files), so uncommitted edits count too.
// 3. leaks    no new ".opencode" / "opencode.json" / "OpenCode" literals in engine
//             sources compared with --base (default: the merge base with origin/main)
// 4. license  LICENSE is byte-identical to upstream and NOTICE exists

import fs from "node:fs"
import path from "node:path"
import {
  countLeaks,
  git,
  gitOk,
  isKeteOwned,
  isUnmarkable,
  leakIncreases,
  leakPatterns,
  parseVersion,
  readTree,
  run,
  SyncError,
  unmarkedAdditions,
} from "./lib"

export interface CheckOptions {
  readonly cwd: string
  /** Upstream release tag; defaults to the contents of .opencode-version at HEAD. */
  readonly upstream?: string
  /** Ref to compare brand leaks against. Leak check is skipped when it resolves to HEAD. */
  readonly base?: string
}

export interface CheckResult {
  readonly failures: string[]
  readonly notes: string[]
}

export const allowlistFile = "packages/kete-tools/leak-allowlist.txt"

export function runChecks(options: CheckOptions): CheckResult {
  const { cwd } = options
  const failures: string[] = []
  const notes: string[] = []

  // 1. pin -------------------------------------------------------------------
  const pinFile = path.join(cwd, ".opencode-version")
  const pinned = options.upstream ?? (fs.existsSync(pinFile) ? fs.readFileSync(pinFile, "utf8").trim() : undefined)
  if (!pinned) {
    failures.push("pin: .opencode-version is missing")
    return { failures, notes }
  }
  if (!parseVersion(pinned)) failures.push(`pin: .opencode-version is not a release tag (vX.Y.Z): ${pinned}`)
  if (!gitOk(cwd, "rev-parse", "--verify", "--quiet", `${pinned}^{commit}`)) {
    failures.push(`pin: tag ${pinned} is not available locally (git fetch upstream tag ${pinned})`)
    return { failures, notes }
  }
  if (!gitOk(cwd, "merge-base", "--is-ancestor", pinned, "HEAD"))
    failures.push(`pin: HEAD does not contain upstream ${pinned}; .opencode-version and the merged release disagree`)

  // 2. markers ---------------------------------------------------------------
  const patchesPath = path.join(cwd, "docs/upstream-patches.md")
  const patches = fs.existsSync(patchesPath) ? fs.readFileSync(patchesPath, "utf8") : ""
  // No "HEAD": the working tree, so an edit is checked before it is committed.
  const changed = git(cwd, "diff", "--name-status", "--no-renames", pinned)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t")
      return { status: status ?? "", file: rest.join("\t") }
    })
    .filter((entry) => !isKeteOwned(entry.file))
  let markedFiles = 0
  for (const { status, file } of changed) {
    const documented = patches.includes(file) || patches.includes(file.replace(/^packages\//, ""))
    if (status === "D") {
      if (!documented) failures.push(`markers: upstream file deleted without a docs/upstream-patches.md entry: ${file}`)
      continue
    }
    if (status === "A") {
      failures.push(`markers: new file outside a kete path (name it *kete* or put it under a kete/ directory): ${file}`)
      continue
    }
    if (isUnmarkable(file)) {
      if (!documented)
        failures.push(`markers: ${file} cannot hold markers and is not listed in docs/upstream-patches.md`)
      continue
    }
    markedFiles++
    const diff = git(cwd, "diff", "-U0", pinned, "--", file)
    for (const problem of unmarkedAdditions(file, diff))
      failures.push(`markers: unmarked edit in ${problem.file}: ${problem.line}`)
  }
  notes.push(`markers: ${changed.length} upstream file(s) differ from ${pinned}; ${markedFiles} checked line by line`)

  // 3. leaks -----------------------------------------------------------------
  const head = git(cwd, "rev-parse", "HEAD")
  const base = options.base ?? mergeBase(cwd)
  if (!base) {
    notes.push("leaks: skipped (no base ref; pass --base)")
  } else if (git(cwd, "rev-parse", base) === head) {
    notes.push(`leaks: skipped (base ${base} is HEAD)`)
  } else {
    const allowed = readAllowlist(cwd)
    const increases = leakIncreases(countLeaks(readTree(cwd, base)), countLeaks(readTree(cwd, head))).filter(
      (increase) => !allowed.has(`${increase.file}:${increase.id}`),
    )
    for (const increase of increases) {
      const description = leakPatterns.find((leak) => leak.id === increase.id)?.description ?? increase.id
      failures.push(
        `leaks: ${increase.file}: ${description} ${increase.before} → ${increase.after}. Route it through Brand, or if it must stay, add "${increase.file}:${increase.id}" to ${allowlistFile}`,
      )
    }
    notes.push(`leaks: compared with ${base}`)
  }

  // 4. license ---------------------------------------------------------------
  if (run(["git", "diff", "--quiet", pinned, "--", "LICENSE"], { cwd }).code !== 0)
    failures.push("license: LICENSE differs from upstream; OpenCode's license and copyright must stay intact")
  if (!fs.existsSync(path.join(cwd, "NOTICE"))) failures.push("license: NOTICE (OpenCode attribution) is missing")

  return { failures, notes }
}

function mergeBase(cwd: string): string | undefined {
  const result = run(["git", "merge-base", "HEAD", "origin/main"], { cwd })
  return result.code === 0 ? result.stdout.trim() : undefined
}

function readAllowlist(cwd: string): Set<string> {
  const file = path.join(cwd, allowlistFile)
  if (!fs.existsSync(file)) return new Set()
  return new Set(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean),
  )
}

export function printResult(result: CheckResult) {
  for (const note of result.notes) console.log(`  · ${note}`)
  if (result.failures.length === 0) {
    console.log("upstream checks passed")
    return
  }
  console.log(`upstream checks failed (${result.failures.length}):`)
  for (const failure of result.failures) console.log(`  ✗ ${failure}`)
}

function flag(args: string[], name: string) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel")
  try {
    const result = runChecks({ cwd, base: flag(args, "--base"), upstream: flag(args, "--upstream") })
    printResult(result)
    process.exit(result.failures.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(error instanceof SyncError ? `error: ${error.message}` : error)
    process.exit(2)
  }
}
