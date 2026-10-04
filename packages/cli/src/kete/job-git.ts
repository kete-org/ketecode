// The git commands `kete job run` needs (D1): a timeout-bounded, no-shell `git` invocation, plus
// the two-step `worktree add -b` that creates a job's worktree and branch together, and the
// best-effort cleanup used when something fails before the prompt is submitted. Never throws on a
// non-zero exit — the caller decides what a failed git command means; only a missing `git` binary
// is a thrown, typed error.

export * as JobGit from "./job-git.js"

import { execFile, type ExecFileException } from "node:child_process"
import { KeteJobMode } from "@opencode/util/kete/job-mode"

export interface Result {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Set when the command was killed by its timeout or an external `AbortSignal` rather than exiting on its own. */
  readonly timedOut: boolean
}

export class GitError extends Error {
  override readonly name = "JobGit.GitError"
}

export interface RunOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Job mode is read from here (default `process.env`); tests inject a value without mutating it. */
  readonly env?: Record<string, string | undefined>
}

const DEFAULT_TIMEOUT_MS = 30_000
const WORKTREE_ADD_TIMEOUT_MS = 5 * 60_000

/** Runs `git <args>` in `cwd`, no shell involved. Resolves with the exit code, stdout and stderr
 * whatever the command's outcome, except when `git` itself can't be spawned — or, in job mode, is
 * refused before it starts (`kete job run` isn't yet run through a job's tool runner). */
export function run(cwd: string, args: ReadonlyArray<string>, options: RunOptions = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    KeteJobMode.refuseSpawn("git", options.env)
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ exitCode: 0, stdout, stderr, timedOut: false })
        const errno = error as ExecFileException
        if (errno.code === "ENOENT")
          return reject(new GitError(`git was not found on PATH (running: git ${args.join(" ")})`))
        if (errno.killed || errno.signal)
          return resolve({ exitCode: -1, stdout, stderr, timedOut: true })
        const exitCode = typeof errno.code === "number" ? errno.code : 1
        resolve({ exitCode, stdout, stderr, timedOut: false })
      },
    )
  })
}

/** `git worktree add -b <branch> <path> <base>` — the base is read first by the caller (`rev-parse
 * HEAD`), so the worktree starts from exactly the user's committed HEAD. A longer timeout than
 * other calls: creating a worktree can copy or hard-link a large checkout. */
export function worktreeAdd(
  root: string,
  input: { readonly branch: string; readonly path: string; readonly base: string },
  options: Pick<RunOptions, "signal"> = {},
): Promise<Result> {
  return run(root, ["worktree", "add", "-b", input.branch, input.path, input.base], {
    timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
    signal: options.signal,
  })
}

export interface DiscardResult {
  readonly remove: Result
  readonly branch: Result
}

/** Cleanup for a worktree created but never used (Design "Cleanup before start only"): removes the
 * worktree, then deletes the branch — the branch still equals its base, nothing is lost. Both
 * results are returned rather than swallowed; the caller reports a failure instead of hiding it. */
export async function worktreeDiscard(
  root: string,
  input: { readonly path: string; readonly branch: string },
  options: Pick<RunOptions, "signal"> = {},
): Promise<DiscardResult> {
  const remove = await run(root, ["worktree", "remove", "--force", input.path], options)
  const branch = await run(root, ["branch", "-D", input.branch], options)
  return { remove, branch }
}
