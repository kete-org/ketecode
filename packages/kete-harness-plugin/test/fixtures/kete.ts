// Kete-owned test fixture: the `kete` the run-mode tests drive, and a throwaway pipeline workspace.
// `KETE_TEST_BIN` names a built kete (CI builds the Linux binary); otherwise a wrapper runs the CLI
// from this repository's source with Bun (its server child inherits BUN_OPTIONS, so it finds the
// CLI's bunfig preload too).

import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../..")

export function keteBinary(dir: string): string {
  const built = process.env.KETE_TEST_BIN
  if (built) return built
  const cli = path.join(repoRoot, "packages/cli")
  const wrapper = path.join(dir, "kete")
  writeFileSync(
    wrapper,
    `#!/bin/sh\nBUN_OPTIONS="--config=${path.join(cli, "bunfig.toml")}" exec "${process.execPath}" "${path.join(cli, "src/index.ts")}" "$@"\n`,
  )
  chmodSync(wrapper, 0o755)
  return wrapper
}

export function sh(cwd: string, args: string[]) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`)
  return out.stdout.trim()
}

/** A workspace cloned from a bare "remote", on main, plus an isolated HOME for kete. */
export function pipeline() {
  const dir = mkdtempSync(path.join(tmpdir(), "kete-harness-run-"))
  const remote = path.join(dir, "remote.git")
  const seed = path.join(dir, "seed")
  const workspace = path.join(dir, "harness")
  const home = path.join(dir, "home")
  mkdirSync(home)
  mkdirSync(seed)
  sh(dir, ["init", "-q", "--bare", "-b", "main", remote])
  sh(seed, ["init", "-q", "-b", "main"])
  writeFileSync(path.join(seed, "README.md"), "# shop\n")
  writeFileSync(path.join(seed, ".gitignore"), "kete-output/\n")
  sh(seed, ["add", "."])
  sh(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"])
  sh(seed, ["push", "-q", remote, "main"])
  sh(dir, ["clone", "-q", remote, workspace])
  writeFileSync(
    path.join(workspace, "build.log"),
    "src/app.ts(3,1): error TS2304: Cannot find name 'FIXED'.\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n",
  )
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    KETE_DISABLE_MODELS_FETCH: "1",
    DRONE_WORKSPACE: workspace,
    DRONE_OUTPUT: path.join(dir, "drone-output.env"),
    HARNESS_OUTPUT: path.join(dir, "harness-output.env"),
    DRONE_REPO_BRANCH: "main",
    DRONE_TARGET_BRANCH: "main",
  }
  return { dir, remote, workspace, home, env }
}
