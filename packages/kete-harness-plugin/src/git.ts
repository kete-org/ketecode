// Kete-owned. The git the step itself runs (never the agent): committing the run's worktree and
// pushing it to a NEW branch. Repository hooks never run (`core.hooksPath=/dev/null`, `--no-verify`),
// the push is refused unless the branch doesn't exist on the remote yet (`--force-with-lease=<ref>:`
// with an empty expectation is git's atomic "must not exist"), and the target and default branches
// are refused before the run even starts. Git's output is redacted before it's printed.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { KeteRedact } from "@opencode/util/kete/redact"

export * as Git from "./git.js"

export type Env = Readonly<Record<string, string | undefined>>

export const timeoutMs = 120_000

const noHooks = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"]

export type Result = { readonly ok: boolean; readonly stdout: string; readonly stderr: string }

export function git(cwd: string, args: readonly string[], env: Env): Result {
  const out = spawnSync("git", [...noHooks, ...args], {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  return {
    ok: out.status === 0,
    stdout: out.stdout ?? "",
    stderr: KeteRedact.text(out.error ? `${out.error.message}\n${out.stderr ?? ""}` : (out.stderr ?? "")),
  }
}

/**
 * Branches a push must never go to: the pipeline's target, default and current branches, the
 * remote's default branch, and main/master.
 */
export function protectedBranches(workspace: string, env: Env): Set<string> {
  const names = new Set(["main", "master"])
  for (const name of ["DRONE_TARGET_BRANCH", "DRONE_REPO_BRANCH", "DRONE_COMMIT_BRANCH", "DRONE_BRANCH"]) {
    const v = env[name]?.trim()
    if (v) names.add(v.replace(/^refs\/heads\//, ""))
  }
  const head = git(workspace, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], env)
  if (head.ok && head.stdout.trim()) names.add(head.stdout.trim().replace(/^origin\//, ""))
  const current = git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"], env)
  if (current.ok && current.stdout.trim()) names.add(current.stdout.trim())
  return names
}

export type Commit =
  | { readonly kind: "committed"; readonly sha: string }
  | { readonly kind: "no_changes" }
  | { readonly kind: "failed"; readonly message: string }

export function commitAll(
  worktree: string,
  message: string,
  author: { name: string; email: string },
  env: Env,
): Commit {
  const add = git(worktree, ["add", "-A"], env)
  if (!add.ok) return { kind: "failed", message: `git add failed: ${add.stderr.trim()}` }
  const status = git(worktree, ["status", "--porcelain"], env)
  if (!status.ok) return { kind: "failed", message: `git status failed: ${status.stderr.trim()}` }
  if (status.stdout.trim() === "") return { kind: "no_changes" }
  const commit = git(
    worktree,
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "--no-verify",
      "-q",
      "-m",
      message,
    ],
    env,
  )
  if (!commit.ok) return { kind: "failed", message: `git commit failed: ${commit.stderr.trim()}` }
  const sha = git(worktree, ["rev-parse", "HEAD"], env)
  return { kind: "committed", sha: sha.stdout.trim() }
}

export type Push =
  | { readonly kind: "pushed" }
  | { readonly kind: "exists" }
  | { readonly kind: "failed"; readonly message: string }

/**
 * Pushes HEAD of `worktree` to `refs/heads/<branch>` on `origin`, only if that branch doesn't exist
 * there. Drone/Harness clone credentials (`DRONE_NETRC_*` in `credentials`) go to a private `.netrc` in a temporary
 * HOME that only this git process sees, deleted afterwards.
 */
export function pushNew(worktree: string, branch: string, env: Env, credentials: Env): Push {
  const ref = `refs/heads/${branch}`
  const home = netrcHome(credentials)
  try {
    const pushEnv = home ? { ...env, HOME: home } : env
    const out = git(
      worktree,
      ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:`, "origin", `HEAD:${ref}`],
      pushEnv,
    )
    if (out.ok) return { kind: "pushed" }
    const text = `${out.stdout}\n${out.stderr}`
    if (/stale info|already exists|\[rejected\]|fetch first|non-fast-forward/i.test(text)) return { kind: "exists" }
    return { kind: "failed", message: `git push failed: ${KeteRedact.text(text).trim().slice(0, 2000)}` }
  } finally {
    if (home) rmSync(home, { recursive: true, force: true })
  }
}

function netrcHome(env: Env): string | undefined {
  const machine = env.DRONE_NETRC_MACHINE?.trim()
  const login = env.DRONE_NETRC_USERNAME?.trim()
  const password = env.DRONE_NETRC_PASSWORD?.trim()
  if (!machine || !login || !password) return undefined
  if ([machine, login, password].some((v) => /\s/.test(v))) return undefined
  const home = mkdtempSync(path.join(tmpdir(), "kete-harness-git-"))
  writeFileSync(path.join(home, ".netrc"), `machine ${machine}\nlogin ${login}\npassword ${password}\n`, {
    mode: 0o600,
  })
  return home
}
