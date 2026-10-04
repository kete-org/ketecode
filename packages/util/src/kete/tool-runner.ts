// `Interface` is the contract job mode's tool runner implements: it takes a command as data
// (argv, cwd, env), the same value the shared `ChildProcessSpawner` service already receives.
// `job-server.ts` replaces `CrossSpawnSpawner.node` with `layer(runner)` where `runner` is either
// `KeteToolHelper.runner({socket})` (./tool-helper.ts — the real root-helper client, used when
// `KETE_JOB_TOOL_SOCKET` is set) or `unavailable` below (the fail-closed stub, used when it isn't).
// Either way, nothing that goes through `ChildProcessSpawner` — the shell tool, MCP stdio servers,
// ripgrep, git, formatters, worktree hooks, and more (docs/jobs.md "Job mode") — can spawn outside
// that one seam.

export * as KeteToolRunner from "./tool-runner.js"

import { Effect, Layer, PlatformError } from "effect"
import type { Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { KeteJobMode } from "./job-mode.js"

export interface Interface {
  readonly spawn: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>
}

function firstStandard(command: ChildProcess.Command): ChildProcess.StandardCommand {
  return command._tag === "StandardCommand" ? command : firstStandard(command.left)
}

/** The basename of the (first, for a piped command) command's argv[0], for the refusal message. */
function basename(command: ChildProcess.Command): string {
  const parts = firstStandard(command).command.split(/[\\/]/)
  return parts[parts.length - 1] || firstStandard(command).command
}

/** The fail-closed stub: refuses every spawn, piped commands included. */
export const unavailable: Interface = {
  spawn: (command) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "KeteToolRunner",
        method: "spawn",
        description: KeteJobMode.message(basename(command)),
      }),
    ),
}

/** Wraps a tool runner as the `ChildProcessSpawner` layer job mode installs in place of
 * `CrossSpawnSpawner.node`. */
export function layer(runner: Interface): Layer.Layer<ChildProcessSpawner> {
  return Layer.succeed(ChildProcessSpawner, make(runner.spawn))
}
