// The extension's own `kete serve`: started on first use, bound to 127.0.0.1 on a random port with a
// random password for this session, restarted with backoff if it crashes, stopped on deactivate.
//
// `serve --stdio` is the CLI's mode for embedders: it prints `{"url": …}` once listening, keeps the
// password out of the environment its tools inherit, and exits when its stdin closes, so it also
// dies with the extension host. Kept free of the `vscode` module so it can be unit-tested with Bun.

import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"

export type Status =
  | { readonly state: "stopped" }
  | { readonly state: "starting" }
  | { readonly state: "running"; readonly url: string }
  | { readonly state: "restarting"; readonly attempt: number; readonly delay: number; readonly reason: string }
  | { readonly state: "failed"; readonly reason: string }

export type Connection = { readonly url: string; readonly password: string }

export type Options = {
  /** Resolves the binary to run on every start, so a changed setting applies on restart. */
  readonly binary: () => Promise<string>
  readonly cwd: string
  /** Extra environment, e.g. KETE_SERVER_ALLOWED_HOSTS; a function is read at every (re)start. */
  readonly env?: Record<string, string> | (() => Record<string, string>)
  readonly onStatus?: (status: Status) => void
  readonly log?: (line: string) => void
  /** How long a start may take before it counts as failed (first start runs database migrations). */
  readonly startTimeout?: number
  /** Restart delays: 1 s doubling to 30 s; give up after `maxFailures` crashes within `failureWindow`. */
  readonly backoff?: { readonly initial: number; readonly max: number; readonly maxFailures: number; readonly failureWindow: number }
}

const defaults = { initial: 1_000, max: 30_000, maxFailures: 5, failureWindow: 120_000 }

export class Server {
  private status: Status = { state: "stopped" }
  private child: ChildProcess | undefined
  private pending: Promise<Connection> | undefined
  private current: Connection | undefined
  private failures: number[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopping = false
  private readonly backoff: typeof defaults

  constructor(private readonly options: Options) {
    this.backoff = { ...defaults, ...options.backoff }
  }

  get state() {
    return this.status
  }

  /** The running server, starting it if needed. Concurrent callers share one start. */
  connection(): Promise<Connection> {
    if (this.current) return Promise.resolve(this.current)
    if (this.pending) return this.pending
    // A manual start replaces a scheduled restart.
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.stopping = false
    this.failures = []
    this.pending = this.launch()
    return this.pending
  }

  /** Stops the server (and any scheduled restart), then starts a fresh one. */
  async restart() {
    await this.stop()
    return this.connection()
  }

  /** Closes stdin (the server exits on its own), and kills it if it hasn't after `grace` ms. */
  async stop(grace = 5_000) {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const child = this.child
    this.child = undefined
    this.current = undefined
    this.pending = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.stdin?.end()
      const killer = setTimeout(() => child.kill(), grace)
      await exited
      clearTimeout(killer)
    }
    this.set({ state: "stopped" })
  }

  private set(status: Status) {
    this.status = status
    this.options.onStatus?.(status)
  }

  private async launch(): Promise<Connection> {
    this.set({ state: "starting" })
    const binary = await this.options.binary().catch((error: unknown) => {
      this.pending = undefined
      this.set({ state: "failed", reason: message(error) })
      throw error
    })
    const password = randomBytes(32).toString("base64url")
    const child = spawn(binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(typeof this.options.env === "function" ? this.options.env() : this.options.env),
        KETE_PASSWORD: password,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .forEach((line) => this.options.log?.(line)),
    )
    const started = await listening(child, this.options.startTimeout ?? 60_000).then(
      (url) => ({ url }),
      (error: unknown) => ({ error: message(error) }),
    )
    if (this.child !== child) throw new Error("The server was stopped while starting")
    if ("error" in started) {
      child.kill()
      this.child = undefined
      this.pending = undefined
      this.crashed(started.error)
      throw new Error(started.error)
    }
    // Keep draining stdout: a full pipe would block the server.
    child.stdout?.on("data", (chunk: Buffer) => this.options.log?.(chunk.toString("utf8").trimEnd()))
    const connection = { url: started.url, password }
    this.current = connection
    this.pending = undefined
    this.set({ state: "running", url: started.url })
    child.once("exit", (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.current = undefined
      if (!this.stopping) this.crashed(`kete serve exited (${signal ?? `code ${code}`})`)
    })
    return connection
  }

  private crashed(reason: string) {
    this.options.log?.(reason)
    const now = Date.now()
    this.failures = [...this.failures.filter((time) => now - time < this.backoff.failureWindow), now]
    if (this.failures.length >= this.backoff.maxFailures) {
      this.set({ state: "failed", reason: `${reason}. Stopped restarting after ${this.failures.length} failures.` })
      return
    }
    const attempt = this.failures.length
    const delay = Math.min(this.backoff.initial * 2 ** (attempt - 1), this.backoff.max)
    this.set({ state: "restarting", attempt, delay, reason })
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopping) return
      this.pending = this.launch()
      // A failed restart schedules the next one itself (crashed); nobody awaits this one.
      this.pending.catch(() => undefined)
    }, delay)
  }
}

/** Waits for the `{"url": …}` line `serve --stdio` prints once it is listening. */
function listening(child: ChildProcess, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    const buffer = { text: "" }
    const timer = setTimeout(() => finish(new Error(`kete serve did not start within ${timeout / 1000} seconds`)), timeout)
    const finish = (result: string | Error) => {
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
      child.off("error", onError)
      if (typeof result === "string") resolve(result)
      else reject(result)
    }
    const onData = (chunk: Buffer) => {
      buffer.text += chunk.toString("utf8")
      const line = buffer.text.split(/\r?\n/).find((item) => item.trim().startsWith("{"))
      if (!line) return
      const url = parseURL(line)
      finish(url ?? new Error("kete serve printed an unexpected start line"))
    }
    const onExit = (code: number | null, signal: string | null) =>
      finish(new Error(`kete serve exited before it was ready (${signal ?? `code ${code}`})`))
    const onError = (error: NodeJS.ErrnoException) =>
      finish(new Error(error.code === "ENOENT" ? "The kete binary was not found" : `Could not run kete: ${error.message}`))
    child.stdout?.on("data", onData)
    child.once("exit", onExit)
    child.once("error", onError)
  })
}

/** The URL from the start line, only if it is a loopback http URL. */
export function parseURL(line: string) {
  const value: unknown = (() => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })()
  if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string") return
  if (!URL.canParse(value.url)) return
  const url = new URL(value.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return
  return url.origin
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
