// Sign-in from the TUI setup screen: runs `kete login` as a child process. The login flow lives in
// packages/cli (which the TUI can't import) and prints only the approval URL and the organization,
// never the key. This parses the URL line and shows nothing else from the child: on failure, only its
// last stderr line. The caller reloads the runtime afterwards so it reads the new account.

export * as SetupLogin from "./setup-login"

import { spawn } from "node:child_process"
import path from "node:path"
import type { EventEmitter } from "node:events"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteSetup } from "@opencode/util/kete/setup"

export type Result = { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "cancelled" }

type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): unknown }
export type Spawn = (command: string[], env: NodeJS.ProcessEnv) => Child

/** Longer than `kete login`'s own approval wait, so the child normally reports its own timeout first. */
export const TIMEOUT = 6 * 60_000

// Mirrors selfCommand() in packages/cli/src/util/process.ts (the TUI can't import the CLI).
function selfCommand(): string[] {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  if (runtime !== "bun" && runtime !== "node" && runtime !== "nodejs") return [process.execPath]
  const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  return [process.execPath, entrypoint]
}

const realSpawn: Spawn = ([command, ...args], env) =>
  spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true })

export function start(input: {
  onURL: (url: string) => void
  spawn?: Spawn
  command?: string[]
  timeout?: number
}): { result: Promise<Result>; cancel: () => void } {
  let cancelled = false
  let settled = false
  let timedOut = false
  let child: Child | undefined
  const result = new Promise<Result>((done) => {
    const resolve = (value: Result) => {
      settled = true
      done(value)
    }
    try {
      KeteJobMode.refuseSpawn("sign-in")
      const ssh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)
      child = (input.spawn ?? realSpawn)([...(input.command ?? selfCommand()), "login", ...(ssh ? ["--no-browser"] : [])], process.env)
    } catch (error) {
      resolve({ kind: "failed", reason: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child?.kill()
    }, input.timeout ?? TIMEOUT)

    let pending = ""
    let urlSeen = false
    child.stdout.on("data", (chunk: unknown) => {
      pending += String(chunk)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      if (urlSeen) return
      for (const line of lines) {
        const url = KeteSetup.parseLoginURL(line)
        if (!url) continue
        urlSeen = true
        input.onURL(url)
        return
      }
    })
    let lastError = ""
    child.stderr.on("data", (chunk: unknown) => {
      const line = String(chunk).split(/\r?\n/).filter((item) => item.trim() !== "").at(-1)
      // The line can carry a platform's error text: no control characters (terminal escapes), bounded.
      if (line) lastError = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().replace(/^Warning:\s*/, "").slice(0, 300)
    })
    child.on("error", (error: Error) => {
      clearTimeout(timer)
      resolve({ kind: "failed", reason: error.message })
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      if (cancelled) return resolve({ kind: "cancelled" })
      if (timedOut) return resolve({ kind: "failed", reason: "Sign-in timed out." })
      if (code === 0) return resolve({ kind: "ok" })
      resolve({ kind: "failed", reason: lastError || `Sign-in failed (exit ${code ?? "signal"}).` })
    })
  })
  return {
    result,
    cancel: () => {
      if (settled) return
      cancelled = true
      child?.kill()
    },
  }
}
