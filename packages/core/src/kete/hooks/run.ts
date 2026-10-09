// Runs one config hook (kete/hooks.ts): the command in the platform's shell in the project directory,
// with the event as JSON on stdin, through the location's process spawner (the same seam as the
// shell tool, so job mode's tool runner would refuse it — hooks don't run in job mode anyway), and
// wrapped by the OS sandbox when the caller passes a `sandbox`.
//
// - macOS/Linux: `/bin/sh -c`, with stdin redirected by the shell from a private temp file (also
//   named by KETE_HOOK_INPUT) rather than written through a pipe: a hook that exits without reading
//   stdin would otherwise make the spawner's write fail (EPIPE).
// - Windows: the command is one line of a temporary batch file run by `cmd.exe /d /c <file>`, with
//   stdin redirected from the payload file inside the batch. A batch file needs no quoting of the
//   command on cmd's command line (node's argument quoting doesn't match cmd's rules); the cost is
//   batch semantics (`%%` for a literal `%`). NoDefaultCurrentDirectoryInExePath keeps the current
//   directory out of program lookup.
//
// Bounded: stdout is kept up to 64 KiB and stderr up to 16 KiB; past its timeout the command and
// its process group are stopped.
//
// What the result means (docs/hooks.md):
// - exit 0: success. Stdout that is a JSON object may carry `decision` ("allow" | "deny"), `reason`
//   and `context`; any other stdout is context.
// - exit 2: "deny" (PreToolUse: the call is blocked); the reason is stderr, else stdout.
// - any other exit, a timeout, or a command that can't start: an error.

export * as KeteHooksRun from "./run.js"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Duration, Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export const MAX_STDOUT = 64 * 1024
export const MAX_STDERR = 16 * 1024
/** Characters of context or reason one hook may add. */
export const MAX_TEXT = 8 * 1024

export type Outcome =
  | { readonly kind: "ok"; readonly decision?: "allow" | "deny"; readonly reason?: string; readonly context?: string }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string }

/** The variable holding the payload file's path (also documented for hooks that prefer a file). */
export const INPUT_VARIABLE = "KETE_HOOK_INPUT"

/**
 * The shell command line. Stdin is redirected from the payload file by the shell itself rather than
 * written through a pipe: a hook that exits without reading stdin would otherwise make the write
 * fail (EPIPE) in the spawner.
 */
export function shell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  directory = "",
): { file: string; args: string[]; script?: { path: string; content: string } } {
  if (platform === "win32") {
    const script = path.win32.join(directory, "hook.cmd")
    return {
      file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/c", script],
      script: { path: script, content: `@echo off\r\n(\r\n${command}\r\n) < "%${INPUT_VARIABLE}%"\r\nexit /b %ERRORLEVEL%\r\n` },
    }
  }
  return { file: "/bin/sh", args: ["-c", `exec <"$${INPUT_VARIABLE}"\n${command}`] }
}

/** Wraps a hook's process in the OS sandbox (kete/hooks.ts builds it); `tmp` is the hook's private temp directory. */
export type Sandbox = (input: {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly tmp: string
}) => Promise<{ file: string; args: string[]; env: Record<string, string>; release: () => Promise<void> }>

export function clip(text: string, max = MAX_TEXT) {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed
}

/** Reads a finished command's exit code and output. */
export function interpret(exit: number, stdout: string, stderr: string): Outcome {
  if (exit === 2) return { kind: "deny", reason: clip(stderr) || clip(stdout) || "Blocked by a hook." }
  if (exit !== 0) return { kind: "error", message: `exited with ${exit}${stderr.trim() ? `: ${clip(stderr, 500)}` : ""}` }
  const text = stdout.trim()
  if (text.startsWith("{")) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { kind: "ok", context: clip(text) }
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "ok", context: clip(text) }
    const record = value as Record<string, unknown>
    const decision = record.decision === "deny" || record.decision === "block" ? "deny" : record.decision === "allow" ? "allow" : undefined
    const reason = typeof record.reason === "string" ? clip(record.reason) : undefined
    const context = typeof record.context === "string" ? clip(record.context) : undefined
    return {
      kind: "ok",
      ...(decision ? { decision } : {}),
      ...(reason ? { reason } : {}),
      ...(context ? { context } : {}),
    }
  }
  return text ? { kind: "ok", context: clip(text) } : { kind: "ok" }
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>, max: number) =>
  Stream.runFold(stream, () => ({ text: "", bytes: 0 }), (state, chunk) => {
    if (state.bytes >= max) return state
    const piece = chunk.subarray(0, max - state.bytes)
    return { text: state.text + new TextDecoder().decode(piece, { stream: true }), bytes: state.bytes + piece.byteLength }
  }).pipe(
    Effect.map((state) => state.text),
    Effect.catch(() => Effect.succeed("")),
  )

export interface Input {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly payload: unknown
  /** Seconds. */
  readonly timeout: number
  /** Runs it in the OS sandbox; unsandboxed when undefined. */
  readonly sandbox?: Sandbox
}

export const run = (input: Input): Effect.Effect<Outcome> =>
  Effect.scoped(
    Effect.gen(function* () {
      // The payload in a private temp file (0600), removed when the hook is done.
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "kete-hook-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
      )
      const inputFile = path.join(directory, "event.json")
      yield* Effect.promise(() => fs.writeFile(inputFile, JSON.stringify(input.payload), { mode: 0o600 }))
      const base: Record<string, string> = { ...input.env, [INPUT_VARIABLE]: inputFile }
      if (process.platform === "win32") base.NoDefaultCurrentDirectoryInExePath = "1"
      const built = shell(input.command, process.platform, base, directory)
      if (built.script) yield* Effect.promise(() => fs.writeFile(built.script!.path, built.script!.content, { mode: 0o600 }))
      const sandbox = input.sandbox
      const launch = sandbox
        ? yield* Effect.acquireRelease(
            Effect.tryPromise(() => sandbox({ file: built.file, args: built.args, env: base, tmp: directory })),
            (wrapped) => Effect.promise(() => wrapped.release().catch(() => undefined)),
          )
        : { file: built.file, args: built.args, env: base }
      const handle = yield* input.spawner.spawn(
        ChildProcess.make(launch.file, launch.args, {
          cwd: input.cwd,
          env: launch.env,
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        }),
      )
      const stdout = yield* Effect.forkScoped(collect(handle.stdout, MAX_STDOUT))
      const stderr = yield* Effect.forkScoped(collect(handle.stderr, MAX_STDERR))
      const exit = yield* handle.exitCode.pipe(Effect.timeoutOption(Duration.seconds(input.timeout)))
      if (exit._tag === "None") {
        yield* handle.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore)
        return { kind: "error", message: `timed out after ${input.timeout} s` } satisfies Outcome
      }
      return interpret(Number(exit.value), yield* Fiber.join(stdout), yield* Fiber.join(stderr))
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ kind: "error", message: `could not run: ${String(cause).split("\n")[0]?.slice(0, 300)}` } satisfies Outcome),
    ),
  )

