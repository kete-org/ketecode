// AC1: every process-spawn site in the runtime is classified once, here, so a future spawn site
// (upstream added one, or a Kete change added one) can't slip past job mode's process seam
// unnoticed (docs/jobs.md "Job mode"). This is a static check: it walks every non-test `.ts` file in
// packages/{core,server,cli,util}/src and matches spawn primitives (node:child_process, cross-spawn
// — which also matches any import of @opencode/util/cross-spawn-spawner — Bun.spawn, spawnSync,
// execFile(Sync), execSync, bun-pty, node-pty, ChildProcess.make(, .spawn(/spawner.spawn,
// ChildProcessSpawner, Bun.$, and LayerNode.compile(). Any matching file that isn't in `allowlist`
// below, or a listed file that no longer matches, fails the test with a message telling the
// implementer to classify it.
//
// Categories:
// - seam: goes through Environment.spawner / AppProcess / ChildProcessSpawner — refused by
//   KeteToolRunner's fail-closed stub once job mode replaces CrossSpawnSpawner.node.
// - replaced-node: the whole service is replaced (or already disabled) in job mode, so this file's
//   own spawn code never runs.
// - kete-guard: a direct spawn outside the shared service; guarded by its own
//   `KeteJobMode.refuseSpawn` call, checked below.
// - self: the runtime's own child (the standalone server self-spawn), not a tool.
// - client-only: a CLI-only spawn (a pager, the updater) that never runs inside a job.
// - implementation: the seam's own implementation, or graph-wiring infrastructure that doesn't
//   itself spawn anything (a generic LayerNode compiler, a type-only re-export).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

type Category = "seam" | "replaced-node" | "kete-guard" | "self" | "client-only" | "implementation"

const repoRoot = path.resolve(import.meta.dir, "../../../../")

const patterns: RegExp[] = [
  /\bnode:child_process\b/,
  /require\(\s*["']child_process["']\s*\)/,
  /cross-spawn/,
  /Bun\.spawn\(/,
  /\bspawnSync\(/,
  /\bexecFile(Sync)?\(/,
  /\bexecSync\(/,
  /from\s+["'][^"']*\bbun-pty["']/,
  /from\s+["'][^"']*\bnode-pty["']/,
  /require\([^)]*node-pty[^)]*\)/,
  /ChildProcess\.make\(/,
  /\.spawn\(/,
  /spawner\.spawn/,
  /ChildProcessSpawner/,
  /Bun\.\$/,
  /LayerNode\.compile\(/,
]

const packages = ["core", "server", "cli", "util"] as const

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return []
    return [full]
  })
}

function matches(file: string): boolean {
  const text = fs.readFileSync(file, "utf8")
  return patterns.some((pattern) => pattern.test(text))
}

/** Every file the walk currently finds, relative to the repo root, posix-separated. */
function found(): Set<string> {
  const files = new Set<string>()
  for (const pkg of packages) {
    const root = path.join(repoRoot, "packages", pkg, "src")
    for (const file of walk(root)) if (matches(file)) files.add(path.relative(repoRoot, file).split(path.sep).join("/"))
  }
  return files
}

const allowlist: Readonly<Record<string, { readonly category: Category; readonly reason: string }>> = {
  // seam: Environment.spawner / AppProcess — refused by the stub once job mode replaces
  // CrossSpawnSpawner.node.
  "packages/core/src/shell.ts": { category: "seam", reason: "shell tool commands" },
  "packages/core/src/mcp/stdio.ts": { category: "seam", reason: "MCP stdio servers" },
  "packages/core/src/kete/lsp.ts": { category: "seam", reason: "language servers (the plugin also does nothing in job mode)" },
  "packages/core/src/ripgrep.ts": { category: "seam", reason: "rg (grep/glob tools)" },
  "packages/core/src/ripgrep/binary.ts": { category: "seam", reason: "rg (grep/glob tools) via ChildProcessSpawner directly" },
  "packages/core/src/environment/exec-defaults.ts": { category: "seam", reason: "sh -c file-op fallback" },
  "packages/core/src/git.ts": { category: "seam", reason: "git (Git service: project, snapshot, vcs, worktree)" },
  "packages/core/src/kete/git.ts": { category: "seam", reason: "git (KeteGit), via AppProcess" },
  "packages/core/src/plugin/vcs/git.ts": { category: "seam", reason: "git (vcs plugin)" },
  "packages/core/src/plugin/vcs/hg.ts": { category: "seam", reason: "hg (vcs plugin)" },
  "packages/core/src/project.ts": { category: "seam", reason: "hg (project vcs detection)" },
  "packages/core/src/formatter.ts": {
    category: "seam",
    reason: "formatters; never started (Formatter.node disabled in job mode), also refused by the stub",
  },
  "packages/core/src/formatter/builtins.ts": { category: "seam", reason: "built-in formatter commands" },
  "packages/core/src/worktree.ts": { category: "seam", reason: "worktree commands.start script" },
  "packages/core/src/integration.ts": { category: "seam", reason: "integration auth command" },
  "packages/core/src/config/plugin/command.ts": { category: "seam", reason: "shell substitution in command templates" },
  "packages/core/src/plugin/provider/azure.ts": { category: "seam", reason: "az CLI token (and only the kete provider is usable, D4)" },
  "packages/core/src/workspace.ts": { category: "seam", reason: "remote workspace provider connection; no workspace providers load in job mode" },

  // implementation: glue around the seam that doesn't itself spawn, or is upstream's own
  // always-refusing spawner for a location with no execution plane.
  "packages/core/src/environment/driver.ts": { category: "implementation", reason: "Driver type, parameterized by the spawner service type" },
  "packages/core/src/environment/environment.ts": { category: "implementation", reason: "defines Environment.spawner from ChildProcessSpawner" },
  "packages/core/src/environment/local.ts": { category: "implementation", reason: "local Driver factory, parameterized by the spawner service type" },
  "packages/core/src/kete/job-files.ts": {
    category: "implementation",
    reason: "job mode's openat2 Environment driver; passes the (tool-runner) ChildProcessSpawner through unchanged",
  },
  "packages/core/src/environment/unavailable.ts": {
    category: "implementation",
    reason: "upstream's own always-refusing spawner for a location with no execution plane; not job-mode specific",
  },
  "packages/core/src/environment/memory.ts": {
    category: "implementation",
    reason: "upstream's own always-refusing spawner for the in-memory driver; not job-mode specific",
  },
  "packages/util/src/cross-spawn-spawner.ts": { category: "implementation", reason: "the spawner implementation behind the seam" },
  "packages/util/src/process.ts": { category: "implementation", reason: "AppProcess, built on the spawner behind the seam" },
  "packages/core/src/effect/app-node-builder.ts": { category: "implementation", reason: "generic LayerNode compiler; no spawner reference" },
  "packages/core/src/instance.ts": { category: "implementation", reason: "generic per-session instance graph compiler; no spawner reference" },
  "packages/util/src/npm.ts": { category: "implementation", reason: "Npm service's own runtime graph; its node has no spawner dependency" },
  "packages/cli/src/commands/handlers/default.ts": { category: "implementation", reason: "compiles only Global.node; no spawner reference" },
  "packages/cli/src/index.ts": {
    category: "implementation",
    reason: "the CLI's own top-level graph; AppProcess.node here backs only the client-only pager; the updater (cli/src/kete/updater.ts) is classified separately",
  },
  "packages/cli/src/server-process.ts": {
    category: "implementation",
    reason: "the kete serve process wrapper; the request-serving path re-resolves AppProcess/CrossSpawnSpawner inside routes.ts's own job-mode-aware graph",
  },
  "packages/server/src/workerd.ts": { category: "implementation", reason: "the workerd profile's own CrossSpawnSpawner replacement; the precedent this plan follows" },
  "packages/server/src/kete/job-server.ts": { category: "implementation", reason: "job mode's own replacement of CrossSpawnSpawner.node; the mechanism itself, not a spawn call" },
  "packages/util/src/kete/job-mode.ts": { category: "implementation", reason: "the flag and the shared refusal wording (mentions ChildProcessSpawner in comments)" },
  "packages/util/src/kete/tool-runner.ts": { category: "implementation", reason: "the fail-closed ChildProcessSpawner stub itself" },
  "packages/util/src/kete/tool-helper.ts": {
    category: "implementation",
    reason: "the job-mode tool runner client; spawns nothing locally (it speaks the root helper's protocol over a unix socket)",
  },

  // replaced-node: the whole service is replaced or disabled in job mode.
  "packages/core/src/pty/pty.bun.ts": { category: "replaced-node", reason: "interactive PTY (#pty, bun); Pty.node replaced with a refusing layer" },
  "packages/core/src/pty/pty.node.ts": { category: "replaced-node", reason: "interactive PTY (#pty, node); Pty.node replaced with a refusing layer" },
  "packages/core/src/persistent-pty/daemon.ts": {
    category: "replaced-node",
    reason: "opencode-pty daemon; PersistentPty.node replaced with a layer that fails every op",
  },
  "packages/cli/src/services/updater.ts": { category: "replaced-node", reason: "self-update; dead in Kete, KeteUpdater.layer (cli/src/kete/updater.ts) replaces the service" },

  // kete-guard: a direct spawn outside the shared service, guarded by its own refuseSpawn call.
  "packages/util/src/kete/secret-store.ts": { category: "kete-guard", reason: "OS keychain CLI" },
  "packages/cli/src/kete/job-git.ts": { category: "kete-guard", reason: "git worktree add for kete job run" },
  "packages/core/src/kete/sandbox/probe.ts": {
    category: "kete-guard",
    reason: "checks sandbox-exec/bwrap once; never called in job mode (the job's own sandbox applies)",
  },

  // self: the runtime's own child, fixed argv, not a tool.
  "packages/cli/src/services/standalone.ts": { category: "self", reason: "the runtime's own kete serve --stdio; inherits OPENCODE_JOB_MODE" },
  "packages/cli/src/kete/job-standalone.ts": { category: "self", reason: "kete job run's own kete serve --stdio --socket in job mode; inherits OPENCODE_JOB_MODE" },

  // client-only: never runs inside a job.
  "packages/cli/src/commands/handlers/session/list.ts": { category: "client-only", reason: "pager for kete session list" },
  "packages/cli/src/kete/updater.ts": {
    category: "client-only",
    reason: "kete upgrade / the TUI's update check: tar to unpack a verified release and the new binary's --version; never called by kete job run",
  },
}

describe("AC1: every process-spawn site is classified", () => {
  test("no unclassified matching file, and no classified file that no longer matches", () => {
    const actual = found()
    const listed = new Set(Object.keys(allowlist))

    const unclassified = [...actual].filter((file) => !listed.has(file))
    expect(unclassified, `classify this spawn site (see docs/jobs.md "Job mode"): ${unclassified.join(", ")}`).toEqual([])

    const stale = [...listed].filter((file) => !actual.has(file))
    expect(stale, `listed but no longer matches a spawn primitive — remove or re-check: ${stale.join(", ")}`).toEqual([])
  })

  test("every allowlisted file actually exists", () => {
    for (const file of Object.keys(allowlist)) expect(fs.existsSync(path.join(repoRoot, file)), file).toBe(true)
  })
})

describe("AC1: each kete-guard file calls KeteJobMode.refuseSpawn before its spawn", () => {
  const spawnCall: Readonly<Record<string, RegExp>> = {
    "packages/util/src/kete/secret-store.ts": /\bspawn\(/,
    "packages/cli/src/kete/job-git.ts": /\bexecFile\(/,
    "packages/core/src/kete/sandbox/probe.ts": /\bspawn\(/,
  }

  for (const [file, category] of Object.entries(allowlist)) {
    if (category.category !== "kete-guard") continue
    test(file, () => {
      const text = fs.readFileSync(path.join(repoRoot, file), "utf8")
      const guardIndex = text.indexOf("KeteJobMode.refuseSpawn(")
      expect(guardIndex, `${file} must call KeteJobMode.refuseSpawn`).toBeGreaterThan(-1)
      const spawnPattern = spawnCall[file]
      expect(spawnPattern, `no known spawn call pattern for ${file}`).toBeDefined()
      const spawnIndex = text.search(spawnPattern!)
      expect(spawnIndex, `${file} has no matching spawn call`).toBeGreaterThan(-1)
      expect(guardIndex, `${file}: refuseSpawn must run before the spawn call`).toBeLessThan(spawnIndex)
    })
  }
})
