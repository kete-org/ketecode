// `kete models pull <name>`: downloads a model into the Ollama server Kete Code uses, then has the
// runtime look at Ollama's models again so the new one is listed straight away.
//
// The Ollama URL comes from the runtime's `kete.local-models` status RPC (config
// `providers.ollama.settings.baseURL`, then KETE_OLLAMA_HOST / OLLAMA_HOST, then localhost), so the
// CLI never resolves hosts itself. Status reports the OpenAI-compatible base URL (`…/v1`); Ollama's
// own API is at its root. Status never returns an API key, so an Ollama behind a bearer token can't
// be pulled from here yet (docs/local-models.md).
//
// Refused in offline mode: Ollama would download the weights from the internet. Exit codes: 0 pulled
// (and the model list refreshed), 1 failed, 2 refused or bad input, 130 cancelled with Ctrl-C (no
// rediscovery after a cancelled pull).
export * as KeteModelsPull from "./models-pull"

import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { Brand } from "@opencode/util/kete/brand"
import { KeteOffline } from "@opencode/util/kete/offline"
import { log } from "@clack/prompts"
import { Effect, Option, Schema } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { ServerConnection } from "../services/server-connection"
import { KeteCliOffline } from "./offline"
import { progress as startProgress, type Progress } from "./progress"

export const EXIT = { ok: 0, failed: 1, refused: 2, cancelled: 130 } as const

/** Wait for Ollama's first response, and at most this long between two lines of progress. */
export const TIMEOUTS = { first: 10_000, idle: 60_000 } as const

const MAX_MESSAGE = 300
/** A progress line is a small JSON object; anything this long without a newline isn't Ollama. */
const MAX_LINE = 64 * 1024

export type Fetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>

export interface Deps {
  readonly offline: boolean
  readonly status: () => Promise<KeteLocalModelsRpc.Status>
  readonly rediscover: () => Promise<void>
  readonly fetch: Fetch
  readonly progress: Progress
  /** Whether progress animates (a TTY): then every percent is shown; otherwise only each new phase. */
  readonly interactive: boolean
  readonly info: (message: string) => void
  readonly error: (message: string) => void
  /** Aborted when the user presses Ctrl-C. */
  readonly signal: AbortSignal
  readonly timeouts?: { readonly first?: number; readonly idle?: number }
}

/** A short, single-line, printable version of text from Ollama or an error. */
export function clean(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}…` : line
}

/** Ollama model names: `name`, `name:tag`, `namespace/name:tag`, `host/namespace/name:tag`. */
export function validName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(name)
}

/** Why `name` can't be pulled before anything is contacted (offline mode, a malformed name), if so. */
export function refusal(name: string, offline: boolean): string | undefined {
  if (offline) return KeteOffline.refuse(`${Brand.cliName} models pull`)
  if (!validName(name))
    return `Not an Ollama model name: ${JSON.stringify(clean(name))}. Use a name like llama3.2 or qwen2.5-coder:7b.`
  return undefined
}

/** Ollama's root URL from the base URL status reports (`http://host:11434/v1` → `http://host:11434`). */
export function ollamaRoot(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  const path = parsed.pathname.replace(/\/+$/, "")
  return `${parsed.origin}${path.endsWith("/v1") ? path.slice(0, -3) : path}`
}

const units = ["B", "KB", "MB", "GB", "TB"]
export function bytes(value: number): string {
  let amount = value
  let unit = 0
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000
    unit++
  }
  return `${unit === 0 ? amount : amount.toFixed(1)} ${units[unit]}`
}

type Line =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "status"; readonly status: string; readonly total?: number; readonly completed?: number }

/** One NDJSON line from `/api/pull`, validated. Anything that isn't an object with `status` or `error` is undefined. */
export function parseLine(text: string): Line | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  if ("error" in value) return { kind: "error", message: clean(String(value.error)) }
  if (!("status" in value) || typeof value.status !== "string") return undefined
  const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined)
  return {
    kind: "status",
    status: clean(value.status),
    total: "total" in value ? number(value.total) : undefined,
    completed: "completed" in value ? number(value.completed) : undefined,
  }
}

/** The text shown for a status line: `pulling 2af3b81862c6: 45% (1.2 GB of 2.6 GB)`. */
export function describe(line: Extract<Line, { kind: "status" }>): string {
  if (line.total === undefined || line.total === 0) return line.status
  const completed = Math.min(line.completed ?? 0, line.total)
  return `${line.status}: ${Math.floor((completed / line.total) * 100)}% (${bytes(completed)} of ${bytes(line.total)})`
}

/** The reason in an Ollama error response body (`{"error": "..."}`), or the body itself. */
function responseReason(body: string): string {
  const parsed = parseLine(body.trim())
  return parsed?.kind === "error" ? parsed.message : clean(body) || "no details"
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ""
    return clean(`${error.message}${cause}`)
  }
  // RPC failures arrive as plain `{ _tag, type, message }` objects.
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return clean(error.message)
  return clean(String(error))
}

/** Pulls `name` and returns the exit code. No I/O except through `deps`. */
export async function pull(name: string, deps: Deps): Promise<number> {
  const refused = refusal(name, deps.offline)
  if (refused !== undefined) {
    deps.error(refused)
    return EXIT.refused
  }
  if (deps.signal.aborted) {
    deps.error("Pull cancelled.")
    return EXIT.cancelled
  }

  let status: KeteLocalModelsRpc.Status
  try {
    status = await deps.status()
  } catch (error) {
    deps.error(`Could not read the local model servers' status from ${Brand.displayName}: ${reason(error)}`)
    return EXIT.failed
  }
  // The runtime may itself be in offline mode (e.g. `kete.offline` in a project config).
  if (status.offline) {
    deps.error(KeteOffline.refuse(`${Brand.cliName} models pull`))
    return EXIT.refused
  }
  const ollama = status.providers.find((provider) => provider.id === "ollama")
  if (!ollama) {
    deps.error(`${Brand.displayName} reported no Ollama server.`)
    return EXIT.failed
  }
  const root = ollamaRoot(ollama.url)
  if (root === undefined) {
    deps.error(`Ollama's URL isn't usable: ${clean(ollama.url)}. ${ollama.hint}`)
    return EXIT.failed
  }
  if (ollama.state !== "reachable") {
    const why = ollama.error ? `: ${ollama.error}` : ""
    deps.error(`Ollama isn't reachable at ${root}${why}. ${ollama.hint}`)
    return EXIT.failed
  }

  const first = deps.timeouts?.first ?? TIMEOUTS.first
  const idle = deps.timeouts?.idle ?? TIMEOUTS.idle
  const controller = new AbortController()
  // Why the stream was stopped from outside (Ctrl-C, a timeout, or the end); kept in an object because
  // callbacks set it while the read loop awaits.
  const state: { stopped?: "cancelled" | "first" | "idle" | "done"; reader?: ReadableStreamDefaultReader<Uint8Array> } = {}
  const stop = (why: NonNullable<typeof state.stopped>) => {
    state.stopped ??= why
    controller.abort()
    state.reader?.cancel().catch(() => undefined)
  }
  const onCancel = () => stop("cancelled")
  deps.signal.addEventListener("abort", onCancel, { once: true })
  let timer = setTimeout(() => stop("first"), first)
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => stop("idle"), idle)
  }

  const url = `${root}/api/pull`
  deps.progress.start(`Pulling ${name} from ${root}`)
  // Only a failure message is decided inside the try; the spinner is stopped once, below.
  const outcome = await (async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    try {
      const response = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name, stream: true }),
        signal: controller.signal,
      })
      arm()
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        return { ok: false, message: `Ollama at ${root} refused the pull (HTTP ${response.status}): ${responseReason(body)}` }
      }
      if (!response.body) return { ok: false, message: `Ollama at ${root} sent no progress.` }
      const reader = response.body.getReader()
      state.reader = reader
      const decoder = new TextDecoder()
      let buffer = ""
      let success = false
      let phase = ""
      const handle = (text: string): string | undefined => {
        const line = parseLine(text)
        if (line === undefined) return `Ollama at ${root} sent something that isn't pull progress: ${clean(text).slice(0, 80)}`
        if (line.kind === "error") return `Ollama couldn't pull ${name}: ${line.message}`
        if (line.status === "success") success = true
        if (deps.interactive) deps.progress.update(describe(line))
        else if (line.status !== phase && line.status !== "success") deps.progress.update(line.status)
        phase = line.status
        return undefined
      }
      while (true) {
        const chunk = await reader.read()
        if (state.stopped !== undefined) break
        arm()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let index = buffer.indexOf("\n")
        while (index >= 0) {
          const text = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (text !== "") {
            const failure = handle(text)
            if (failure !== undefined) return { ok: false, message: failure }
          }
          index = buffer.indexOf("\n")
        }
        if (buffer.length > MAX_LINE) return { ok: false, message: `Ollama at ${root} sent a progress line that is too long.` }
      }
      if (state.stopped === undefined) {
        const rest = (buffer + decoder.decode()).trim()
        if (rest !== "") {
          const failure = handle(rest)
          if (failure !== undefined) return { ok: false, message: failure }
        }
        if (!success) return { ok: false, message: `Ollama at ${root} stopped before the pull of ${name} finished.` }
        return { ok: true }
      }
      return { ok: false, message: "" }
    } catch (error) {
      if (state.stopped !== undefined) return { ok: false, message: "" }
      return { ok: false, message: `Could not reach Ollama at ${root}: ${reason(error)}` }
    }
  })()
  clearTimeout(timer)
  deps.signal.removeEventListener("abort", onCancel)
  const why = state.stopped
  stop("done")

  if (why === "cancelled") {
    deps.progress.stop("Pull cancelled", 1)
    deps.error(`Pull of ${name} cancelled.`)
    return EXIT.cancelled
  }
  if (why === "first") {
    deps.progress.stop("Pull failed", 1)
    deps.error(`Ollama at ${root} didn't respond within ${Math.round(first / 1000)} s.`)
    return EXIT.failed
  }
  if (why === "idle") {
    deps.progress.stop("Pull failed", 1)
    deps.error(`No progress from Ollama at ${root} for ${Math.round(idle / 1000)} s; the pull was stopped.`)
    return EXIT.failed
  }
  if (!outcome.ok) {
    deps.progress.stop("Pull failed", 1)
    deps.error(outcome.message)
    return EXIT.failed
  }

  deps.progress.stop(`Pulled ${name}`)
  try {
    await deps.rediscover()
  } catch (error) {
    deps.error(
      `Pulled ${name}, but ${Brand.displayName} couldn't refresh its model list: ${reason(error)}. Restart ${Brand.cliName} to see the model.`,
    )
    return EXIT.failed
  }
  deps.info(`${name} is ready: pick it with /models, or run \`${Brand.cliName} models\`.`)
  return EXIT.ok
}

/** Ctrl-C aborts the pull (exit 130); a second Ctrl-C exits at once. */
function interrupts() {
  const controller = new AbortController()
  let count = 0
  const listener = () => {
    count++
    controller.abort()
    if (count >= 2) process.exit(EXIT.cancelled)
  }
  process.on("SIGINT", listener)
  return { signal: controller.signal, dispose: () => process.off("SIGINT", listener) }
}

export default Runtime.handler(
  Commands.commands.models.commands.pull,
  Effect.fn("cli.kete.models.pull")(function* (input: Runtime.Input<typeof Commands.commands.models.commands.pull>) {
    // Before connecting: no server is started just to refuse.
    if (KeteCliOffline.refused(`${Brand.cliName} models pull`)) return
    const refused = refusal(input.name, false)
    if (refused !== undefined) {
      log.error(refused)
      process.exitCode = EXIT.refused
      return
    }
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    const location = { directory: process.cwd() }
    // The raw RPC call plus a decode against the shared schema: the promise client's typed `rpc()` takes
    // only Standard Schema definitions, and the server's answer is external input either way.
    const call = (method: "status" | "rediscover", input: { provider?: "ollama" }) =>
      client.rpc.call(
        { rpcID: KeteLocalModelsRpc.ID, method, input, location },
        { signal: AbortSignal.timeout(15_000) },
      )
    const decodeStatus = Schema.decodeUnknownPromise(KeteLocalModelsRpc.Status)
    const interactive = process.stdout.isTTY === true
    // Uninterruptible: Ctrl-C goes to `interrupts` (which aborts the pull, so it ends promptly with its
    // own message and exit code) instead of cutting the promise off mid-stream.
    const code = yield* Effect.uninterruptible(
      Effect.acquireUseRelease(
        Effect.sync(interrupts),
        (signals) =>
          Effect.promise(() =>
            pull(input.name, {
              offline: KeteOffline.enabled(),
              status: () => call("status", {}).then((response) => decodeStatus(response.output)),
              rediscover: () => call("rediscover", { provider: "ollama" }).then(() => undefined),
              fetch: (url, init) => fetch(url, { ...init, timeout: false } as BunFetchRequestInit),
              progress: startProgress(interactive),
              interactive,
              info: (message) => log.info(message),
              error: (message) => log.error(message),
              signal: signals.signal,
            }),
          ),
        (signals) => Effect.sync(signals.dispose),
      ),
    )
    process.exitCode = code
  }),
)
