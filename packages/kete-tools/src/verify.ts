#!/usr/bin/env bun
// Local verification for Kete Code: typecheck and tests for the engine packages.
// Runs on the developer's machine instead of paid CI. Kete-owned.
//
//   bun run --cwd packages/kete-tools verify [--base <ref>] [--packages util,core] [--skip-tests] [--markdown]
//
// With --base, the same checks run on <ref> in a temporary git worktree and only
// failures that are new relative to <ref> fail the run. That separates
// regressions from tests that fail on this machine regardless (e.g. a missing
// ripgrep binary).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { git, run } from "./lib"

export const enginePackages = ["util", "server", "core", "tui", "cli"] as const

export interface PackageResult {
  readonly name: string
  readonly typecheck: boolean
  readonly pass?: number
  readonly fail?: number
  readonly failures: string[]
}

/** Extracts `(fail) name` lines and the pass/fail totals from `bun test` output. */
export function parseTestOutput(output: string): { pass?: number; fail?: number; failures: string[] } {
  const failures = [
    ...new Set(
      output
        .split("\n")
        .filter((line) => line.startsWith("(fail) "))
        .map((line) =>
          line
            .slice("(fail) ".length)
            .replace(/ \[[\d.]+m?s\]$/, "")
            .trim(),
        ),
    ),
  ].sort()
  const total = (label: string) => {
    const match = new RegExp(`^\\s*(\\d+) ${label}$`, "m").exec(output)
    return match ? Number(match[1]) : undefined
  }
  return { pass: total("pass"), fail: total("fail"), failures }
}

export function verifyPackages(root: string, packages: readonly string[], skipTests: boolean, log = console.error) {
  return packages.map((name): PackageResult => {
    const cwd = path.join(root, "packages", name)
    log(`  ${name}: typecheck`)
    const typecheck = run(["bun", "run", "typecheck"], { cwd }).code === 0
    if (skipTests) return { name, typecheck, failures: [] }
    log(`  ${name}: tests`)
    const test = run(["bun", "run", "test"], { cwd })
    return { name, typecheck, ...parseTestOutput(test.stdout + "\n" + test.stderr) }
  })
}

function withWorktree<A>(root: string, ref: string, body: (dir: string) => A): A {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kete-verify-"))
  git(root, "worktree", "add", "--detach", dir, ref)
  try {
    const install = run(["bun", "install", "--frozen-lockfile"], { cwd: dir })
    if (install.code !== 0) throw new Error(`bun install failed in the ${ref} worktree: ${install.stderr.trim()}`)
    return body(dir)
  } finally {
    run(["git", "worktree", "remove", "--force", dir], { cwd: root })
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface Comparison {
  readonly name: string
  readonly head: PackageResult
  readonly base?: PackageResult
  /** Failing on HEAD but not on the base (all failures when there is no base). */
  readonly regressions: string[]
  readonly typecheckRegression: boolean
}

export function compare(head: readonly PackageResult[], base?: readonly PackageResult[]): Comparison[] {
  return head.map((result) => {
    const previous = base?.find((item) => item.name === result.name)
    const known = new Set(previous?.failures ?? [])
    return {
      name: result.name,
      head: result,
      base: previous,
      regressions: result.failures.filter((failure) => !known.has(failure)),
      typecheckRegression: !result.typecheck && (previous ? previous.typecheck : true),
    }
  })
}

export function render(comparisons: readonly Comparison[], base: string | undefined, markdown: boolean) {
  const lines: string[] = []
  const counts = (r?: PackageResult) => (r?.pass === undefined ? "–" : `${r.pass} pass / ${r.fail ?? 0} fail`)
  if (markdown) {
    lines.push(`| Package | Typecheck | Tests | ${base ? `Base (${base.slice(0, 10)}) | ` : ""}New failures |`)
    lines.push(`|---|---|---|${base ? "---|" : ""}---|`)
  }
  for (const c of comparisons) {
    const typecheck = c.head.typecheck ? "ok" : "FAILED"
    if (markdown)
      lines.push(
        `| ${c.name} | ${typecheck} | ${counts(c.head)} | ${base ? `${counts(c.base)} | ` : ""}${c.regressions.length} |`,
      )
    else
      lines.push(
        `${c.name.padEnd(8)} typecheck ${typecheck.padEnd(7)} tests ${counts(c.head).padEnd(22)}${base ? ` base ${counts(c.base).padEnd(22)}` : ""} new failures ${c.regressions.length}`,
      )
  }
  const regressions = comparisons.flatMap((c) => c.regressions.map((failure) => `${c.name}: ${failure}`))
  if (regressions.length) {
    lines.push("", markdown ? "New failures:" : "new failures:")
    for (const failure of regressions) lines.push(markdown ? `- ${failure}` : `  ✗ ${failure}`)
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (name: string) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel")
  const packages = value("--packages")?.split(",") ?? [...enginePackages]
  const skipTests = args.includes("--skip-tests")
  const base = value("--base")

  console.error(`verifying HEAD (${packages.join(", ")})`)
  const head = verifyPackages(root, packages, skipTests)
  let baseResults: PackageResult[] | undefined
  if (base) {
    console.error(`verifying ${base} in a temporary worktree`)
    baseResults = withWorktree(root, base, (dir) => verifyPackages(dir, packages, skipTests))
  }
  const comparisons = compare(head, baseResults)
  console.log(render(comparisons, base, args.includes("--markdown")))
  const failed = comparisons.some((c) => c.typecheckRegression || c.regressions.length > 0)
  process.exit(failed ? 1 : 0)
}
