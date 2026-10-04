// Runs git for Kete-owned features that need commands the upstream Git service doesn't expose
// (branch creation, commit counts). Every command has a timeout, and git's exit code is returned
// rather than turned into success.

export * as KeteGit from "./git.js"

import { AppProcess } from "@opencode/util/process"
import { Duration, Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { gitExecutable } from "../util/git-executable.js"

export const timeout = Duration.seconds(60)

export interface Result {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: Result,
  ) {
    super(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`)
    this.name = "KeteGitError"
  }
}

export const make = Effect.gen(function* () {
  const proc = yield* AppProcess.Service

  /** Runs `git args` in `cwd`. Fails only when git can't be started or times out; check `exitCode`. */
  const run = (cwd: string, args: readonly string[]) =>
    proc.run(ChildProcess.make(gitExecutable, [...args], { cwd, extendEnv: true, stdin: "ignore" }), { timeout }).pipe(
      Effect.map(
        (result): Result => ({
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }),
      ),
    )

  /** Runs `git args` in `cwd` and returns trimmed stdout, failing with GitError on a non-zero exit. */
  const text = (cwd: string, args: readonly string[]) =>
    run(cwd, args).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 ? Effect.succeed(result.stdout.trim()) : Effect.fail(new GitError(args, result)),
      ),
    )

  return { run, text }
})
