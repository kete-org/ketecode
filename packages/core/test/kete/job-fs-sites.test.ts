// Piece A3 (AC1): every in-process file-access primitive in the runtime's core and server is
// classified here, so a future site (upstream added one, or a Kete change added one) can't reach
// the working tree in a job without passing through the confined layer unnoticed. Static check:
// walks every non-test `.ts` file in packages/{core,server,util}/src for `node:fs`/`fs/promises`
// imports, `require("fs")`, `Bun.file(`/`Bun.write(`, effect's `FileSystem.FileSystem` service,
// `NodeFileSystem` and the `glob` package. The working tree is otherwise reached through Environment.files (replaced in job
// mode by core/src/kete/job-files.ts) and FSUtil (wrapped by util/src/kete/job-fs-util.ts), which
// is why neither appears here. An unclassified match fails with "classify this file-access site".
//
// Categories:
// - replaced: the module's service is replaced in job mode by the openat2 driver.
// - data-dir: reads/writes kete's own data, lock or state files, never the working tree (in job
//   mode the audit writer uses the pipe instead of its file storage).
// - metadata-only: watches or stats paths without reading content.
// - off-in-job: the feature is replaced or refused in job mode (persistent PTY, disk plugins).
// - not-worktree: touches a fixed non-worktree path (a shell binary, the server's socket, a legacy
//   credentials or database migration).
// - wrapped: FSUtil's own implementation and the platform FileSystem under it; job mode wraps FSUtil
//   (util/src/kete/job-fs-util.ts), which routes, refuses or filters every worktree call.
// - confinement: the confined layer itself, or descriptor-only I/O on an inherited/opened fd.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

type Category = "replaced" | "data-dir" | "metadata-only" | "off-in-job" | "not-worktree" | "wrapped" | "confinement"

const repoRoot = path.resolve(import.meta.dir, "../../../../")

const patterns: RegExp[] = [
  /from\s+["'](node:)?fs(\/promises)?["']/,
  /require\(\s*["'](node:)?fs(\/promises)?["']\s*\)/,
  /Bun\.file\(/,
  /Bun\.write\(/,
  /FileSystem\.FileSystem\b/,
  /NodeFileSystem/,
  /from\s+["']glob["']/,
]

const packages = ["core", "server", "util"] as const

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return []
    return [full]
  })
}

function found(): Set<string> {
  const files = new Set<string>()
  for (const pkg of packages)
    for (const file of walk(path.join(repoRoot, "packages", pkg, "src"))) {
      const text = fs.readFileSync(file, "utf8")
      if (patterns.some((pattern) => pattern.test(text))) files.add(path.relative(repoRoot, file).split(path.sep).join("/"))
    }
  return files
}

const allowlist: Readonly<Record<string, { readonly category: Category; readonly reason: string }>> = {
  "packages/core/src/environment/local.ts": { category: "replaced", reason: "the local Environment driver; job mode replaces Environment.node (kete/job-files.ts)" },
  "packages/core/src/kete/mcp-secrets.ts": { category: "data-dir", reason: "creates <data>/mcp-servers/<server>, the working directory of an MCP server that gets a stored secret" },
  "packages/core/src/kete/audit.ts": { category: "data-dir", reason: "the audit file under <data>/audit; job mode writes to the pipe instead" },
  "packages/core/src/kete/orchestration/turn-state.ts": {
    category: "data-dir",
    reason: "an orchestration turn's record under <state>/kete (kete's home), never the working tree",
  },
  "packages/core/src/util/process-lock.ts": { category: "data-dir", reason: "process lock files in kete's state dirs" },
  "packages/core/src/util/process-lock-ffi.bun.ts": { category: "data-dir", reason: "flock on a lock file's descriptor" },
  "packages/core/src/filesystem/watcher.ts": { category: "metadata-only", reason: "change notifications; no content reads" },
  "packages/core/src/persistent-pty/daemon.ts": { category: "off-in-job", reason: "PersistentPty is replaced with a refusing layer in job mode" },
  "packages/core/src/persistent-pty/binary.bun.ts": { category: "off-in-job", reason: "the persistent-PTY daemon binary; off in job mode" },
  "packages/core/src/plugin/module.ts": { category: "off-in-job", reason: "disk plugins; ConfigPluginSource is empty in job mode" },
  "packages/core/src/kete/lsp.ts": { category: "off-in-job", reason: "language server diagnostics; the plugin does nothing in job mode" },
  "packages/core/src/kete/hooks.ts": { category: "off-in-job", reason: "config hooks (realpath of the repository); the plugin does nothing in job mode" },
  "packages/core/src/kete/hooks/run.ts": { category: "off-in-job", reason: "a hook's payload temp file; the hooks plugin does nothing in job mode" },
  "packages/core/src/kete/hooks/settings.ts": { category: "off-in-job", reason: "hashes repository files a project hook names; the hooks plugin does nothing in job mode" },
  "packages/core/src/kete/hooks/trust.ts": { category: "data-dir", reason: "the hooks trust store in kete's state directory" },
  "packages/core/src/kete/lsp/executable.ts": { category: "off-in-job", reason: "finds language server programs (stat/realpath); the LSP plugin does nothing in job mode" },
  "packages/core/src/shell/select.ts": { category: "not-worktree", reason: "checks the shell binary's path" },
  "packages/core/src/kete/sandbox/probe.ts": { category: "off-in-job", reason: "checks for sandbox-exec/bwrap; the local sandbox never runs in job mode" },
  "packages/core/src/kete/sandbox.ts": { category: "off-in-job", reason: "creates a session's private temp directory for the local sandbox; never runs in job mode" },
  "packages/core/src/kete/sandbox/resolve.ts": { category: "off-in-job", reason: "the local sandbox's policy (git layout, placeholders); never runs in job mode" },
  "packages/core/src/database/v1-migration.bun.ts": { category: "not-worktree", reason: "legacy database migration in the data dir" },
  "packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts": {
    category: "not-worktree",
    reason: "legacy credential import from the data dir",
  },
  "packages/server/src/kete/socket-listen.ts": { category: "not-worktree", reason: "the server's own unix socket directory" },
  "packages/util/src/fs-util.ts": { category: "wrapped", reason: "FSUtil (readdir in readDirectoryEntries, Glob.scan); wrapped in job mode" },
  "packages/util/src/glob.ts": { category: "wrapped", reason: "the glob package behind FSUtil.scan/globUp; its only caller is fs-util.ts" },
  "packages/util/src/effect/app-node-platform.ts": { category: "wrapped", reason: "NodeFileSystem, the platform FileSystem under FSUtil" },
  "packages/util/src/cross-spawn-spawner.ts": { category: "replaced", reason: "access(cwd) before a spawn; job mode replaces CrossSpawnSpawner.node with the tool runner" },
  "packages/util/src/flock.ts": { category: "data-dir", reason: "lock files in kete's state dirs" },
  "packages/util/src/global.ts": { category: "data-dir", reason: "creates kete's global data/config/cache/state dirs" },
  "packages/util/src/kete/account.ts": { category: "data-dir", reason: "the account file in kete's config dir" },
  "packages/util/src/kete/runtime-registration.ts": { category: "data-dir", reason: "the installation id in kete's state; registration is off in job mode" },
  "packages/util/src/kete/secret-store.ts": { category: "data-dir", reason: "the file fallback secret store in kete's data dir" },
  "packages/util/src/kete/sync/approvals.ts": { category: "data-dir", reason: "the managed-config approvals file in kete's config dir" },
  "packages/util/src/kete/sync/cache.ts": { category: "data-dir", reason: "the managed sync cache in kete's config dir" },
  "packages/util/src/kete/sync/skills.ts": { category: "data-dir", reason: "downloaded managed skills in kete's config dir" },
  "packages/util/src/npm.ts": { category: "off-in-job", reason: "npm plugin installs into kete's cache; disk plugins are off in job mode" },
  "packages/util/src/observability.ts": { category: "data-dir", reason: "log files in kete's log dir" },
  "packages/util/src/observability/logging.ts": { category: "data-dir", reason: "log files in kete's log dir" },
  "packages/util/src/runtime/import.node.ts": { category: "off-in-job", reason: "stats a module URL before importing plugin code; disk plugins are off in job mode" },
  "packages/util/src/kete/confined-fs.ts": { category: "confinement", reason: "realpath of the root at startup; everything else is openat2" },
  "packages/util/src/kete/linux-ffi.ts": { category: "confinement", reason: "fstat/read/write/close on descriptors openat2 returned" },
  "packages/util/src/kete/job-audit-sink.ts": { category: "confinement", reason: "fstat/write on the inherited audit pipe" },
  "packages/util/src/kete/review.ts": {
    category: "data-dir",
    reason: "a review job's record (review.json) under <state> (kete's home), never the working tree",
  },
  "packages/util/src/kete/job-secrets.ts": { category: "confinement", reason: "reads the inherited secrets descriptor" },
}

describe("AC1: every in-process file-access site is classified", () => {
  test("the walk finds exactly the allowlisted files", () => {
    const actual = found()
    const listed = new Set(Object.keys(allowlist))
    const unclassified = [...actual].filter((file) => !listed.has(file))
    expect(unclassified, `classify this file-access site (docs/jobs.md "Job mode"): ${unclassified.join(", ")}`).toEqual([])
    const stale = [...listed].filter((file) => !actual.has(file))
    expect(stale, `listed but no longer matches a file-access primitive — remove or re-check: ${stale.join(", ")}`).toEqual([])
  })
})
