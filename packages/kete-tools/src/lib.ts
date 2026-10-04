// Shared helpers for the upstream (OpenCode) sync tooling. Kete-owned.
// See docs/upstream-sync.md for the process these scripts implement.

import path from "node:path"

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command without a shell. Never throws on a non-zero exit; callers decide. */
export function run(cmd: readonly string[], options: { cwd: string; env?: Record<string, string | undefined> }) {
  const result = Bun.spawnSync([...cmd], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  } satisfies RunResult
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = "SyncError"
  }
}

/** Runs git and returns trimmed stdout, failing with git's own message. */
export function git(cwd: string, ...args: string[]): string {
  const result = run(["git", ...args], { cwd })
  if (result.code !== 0)
    throw new SyncError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

export function gitOk(cwd: string, ...args: string[]): boolean {
  return run(["git", ...args], { cwd }).code === 0
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** Parses an upstream release tag. Only plain releases (vX.Y.Z) are syncable. */
export function parseVersion(input: string): Version | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(input.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export const formatVersion = (v: Version) => `v${v.major}.${v.minor}.${v.patch}`

// ---------------------------------------------------------------------------
// Ownership: which paths are Kete's and which are upstream's
// ---------------------------------------------------------------------------

/** Kete-owned files: no markers required (CLAUDE.md §4: paths with `kete` in the name). */
export function isKeteOwned(file: string): boolean {
  const normalized = file.split(path.sep).join("/")
  if (normalized.split("/").some((segment) => segment.toLowerCase().includes("kete"))) return true
  return (
    normalized === "CLAUDE.md" ||
    normalized === "NOTICE" ||
    normalized === ".opencode-version" ||
    normalized === "docs/architecture.md" ||
    normalized === "docs/upstream-patches.md" ||
    normalized === "docs/upstream-sync.md" ||
    normalized === "docs/release.md" ||
    normalized === "docs/jobs.md" ||
    normalized === "docs/job-hosts.md" ||
    // Kete Code's public-facing files; GitHub prefers .github/ over upstream's root files (ADR 0010).
    normalized === ".github/README.md" ||
    normalized === ".github/SECURITY.md" ||
    normalized === ".github/CONTRIBUTING.md" ||
    normalized === ".github/CODE_OF_CONDUCT.md" ||
    // Kete's gitleaks configuration (allowlists for test fixtures).
    normalized === ".gitleaks.toml" ||
    normalized.startsWith("docs/adr/") ||
    // Brand assets (logos, fonts); upstream has no top-level assets/.
    normalized.startsWith("assets/brand/") ||
    // Contracts with kete-code-platform and requests to it.
    normalized.startsWith("docs/platform/") ||
    // The development knowledge base and agent swarm (docs/context/INDEX.md).
    normalized.startsWith("docs/context/") ||
    normalized.startsWith("docs/tasks/") ||
    normalized.startsWith("scripts/agent/") ||
    normalized.startsWith(".claude/agents/") ||
    normalized.startsWith(".claude/skills/") ||
    normalized === ".claude/settings.json"
  )
}

/**
 * Files that cannot carry inline comments, or whose comments regeneration would drop
 * (anything under a `generated/` directory); their edits must be listed in
 * docs/upstream-patches.md.
 */
export function isUnmarkable(file: string): boolean {
  return /\.(json|txt|md|lock|svg|png|jpg|snap)$/i.test(file) || /(^|\/)generated\//.test(file)
}

// ---------------------------------------------------------------------------
// Marker audit
// ---------------------------------------------------------------------------

export interface MarkerProblem {
  readonly file: string
  readonly line: string
}

/**
 * Checks one file's `git diff -U0` output: every added line must be covered by a
 * `kete_change` marker, as documented in CLAUDE.md §4:
 *   - an inline `// kete_change` (or `/* kete_change *\/`, `{/* kete_change *\/}`) on the line,
 *   - a `kete_change start` … `kete_change end` block,
 *   - a marker-only comment line directly above (e.g. `// kete_change: why`).
 * Blank added lines are ignored. Template-literal content (HTML/JS strings) cannot
 * carry comments, so wrap such edits in a start/end block placed outside the template.
 */
export function unmarkedAdditions(file: string, diff: string): MarkerProblem[] {
  const problems: MarkerProblem[] = []
  let block = false
  let previousWasMarker = false
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue
    if (raw.startsWith("@@")) {
      previousWasMarker = false
      continue
    }
    if (!raw.startsWith("+")) continue
    const body = raw.slice(1)
    const trimmed = body.trim()
    if (trimmed.includes("kete_change start")) {
      block = true
      continue
    }
    if (trimmed.includes("kete_change end")) {
      block = false
      continue
    }
    if (block) continue
    const markerOnly = /^(\/\/|\/\*|\{\/\*|#|<!--)\s*kete_change\b/.test(trimmed)
    if (markerOnly) {
      previousWasMarker = true
      continue
    }
    if (trimmed.includes("kete_change")) {
      previousWasMarker = false
      continue
    }
    if (previousWasMarker) {
      previousWasMarker = false
      continue
    }
    if (trimmed === "") continue
    problems.push({ file, line: trimmed.slice(0, 160) })
  }
  return problems
}

// ---------------------------------------------------------------------------
// Brand leaks
// ---------------------------------------------------------------------------

/** Engine source trees where OpenCode names must not appear in new code. */
export const engineSources = [
  "packages/cli/src",
  "packages/core/src",
  "packages/server/src",
  "packages/tui/src",
  "packages/util/src",
]

export interface LeakPattern {
  readonly id: string
  readonly description: string
  readonly pattern: RegExp
}

/**
 * Literals that bypass packages/util/src/kete/brand.ts. New occurrences after a sync
 * usually mean upstream added a config path or a user-facing string that Kete must
 * route through Brand.
 */
export const leakPatterns: readonly LeakPattern[] = [
  {
    id: "project-dir",
    description: '".opencode" project directory literal',
    pattern: /["'`]\.opencode\b|[/\\]\.opencode[/\\"'`]/,
  },
  { id: "config-file", description: '"opencode.json[c]" config filename literal', pattern: /opencode\.jsonc?\b/ },
  // `OpenCode.make(...)` is the SDK client constructor, not user-facing text.
  { id: "display-name", description: '"OpenCode" user-facing name', pattern: /\bOpenCode\b(?!\.make\b)/ },
]

export type LeakCounts = Record<string, Record<string, number>>

/** Counts leak-pattern matches per file and pattern, skipping comments and tests. */
export function countLeaks(files: ReadonlyMap<string, string>): LeakCounts {
  const counts: LeakCounts = {}
  for (const [file, text] of files) {
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || isKeteOwned(file)) continue
    for (const line of text.split("\n")) {
      const code = line.trim()
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("import ")) continue
      if (code.includes("kete_change")) continue
      for (const leak of leakPatterns) {
        if (!leak.pattern.test(line)) continue
        counts[file] ??= {}
        counts[file][leak.id] = (counts[file][leak.id] ?? 0) + 1
      }
    }
  }
  return counts
}

export interface LeakIncrease {
  readonly file: string
  readonly id: string
  readonly before: number
  readonly after: number
}

/** Files where a leak pattern occurs more often than before: new upstream literals to route through Brand. */
export function leakIncreases(before: LeakCounts, after: LeakCounts): LeakIncrease[] {
  const increases: LeakIncrease[] = []
  for (const [file, ids] of Object.entries(after)) {
    for (const [id, count] of Object.entries(ids)) {
      const previous = before[file]?.[id] ?? 0
      if (count > previous) increases.push({ file, id, before: previous, after: count })
    }
  }
  return increases.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
}

/** Reads every tracked text file under the engine sources at a git ref. */
export function readTree(cwd: string, ref: string, roots: readonly string[] = engineSources): Map<string, string> {
  const listed = run(["git", "ls-tree", "-r", "--name-only", ref, "--", ...roots], { cwd })
  if (listed.code !== 0) throw new SyncError(`cannot list ${ref}: ${listed.stderr.trim()}`)
  const files = listed.stdout.split("\n").filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
  const result = new Map<string, string>()
  if (files.length === 0) return result
  // One batch read instead of a git process per file.
  const batch = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd,
    stdin: new TextEncoder().encode(files.map((file) => `${ref}:${file}`).join("\n") + "\n"),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (batch.exitCode !== 0) throw new SyncError(`cannot read ${ref}: ${batch.stderr.toString().trim()}`)
  const buffer = batch.stdout
  let offset = 0
  for (const file of files) {
    const headerEnd = buffer.indexOf(10, offset)
    const header = buffer.subarray(offset, headerEnd).toString()
    const size = Number(header.split(" ")[2])
    if (!Number.isFinite(size)) throw new SyncError(`unexpected git cat-file output for ${file}: ${header}`)
    const start = headerEnd + 1
    result.set(file, buffer.subarray(start, start + size).toString())
    offset = start + size + 1
  }
  return result
}

// ---------------------------------------------------------------------------
// Upstream workflow changes
// ---------------------------------------------------------------------------

/**
 * GitHub workflows added by upstream between two refs. Kete disables every inherited
 * workflow in the repository settings; a newly added file starts out enabled.
 */
export function addedWorkflows(cwd: string, from: string, to: string): string[] {
  const out = git(cwd, "diff", "--name-only", "--diff-filter=A", from, to, "--", ".github/workflows")
  return out ? out.split("\n") : []
}
