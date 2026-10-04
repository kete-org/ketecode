// The server's event stream (`GET /api/event`, server-sent events), and what the extension needs from
// it: which permission prompts are waiting, and when a session finishes. It reads the server directly,
// so it works while the chat is hidden. Kept free of the `vscode` module so it can be unit-tested.

export type Event = { readonly type: string; readonly data?: unknown }

/** Waiting permission requests (request id → session id) and sessions currently working. */
export type Attention = { readonly pending: ReadonlyMap<string, string>; readonly busy: ReadonlySet<string> }

export type Change =
  | { readonly kind: "asked"; readonly sessionID: string; readonly action: string }
  | { readonly kind: "finished"; readonly sessionID: string }

export const empty: Attention = { pending: new Map(), busy: new Set() }

/** The next attention state for one event, and what changed that a user should hear about. */
export function reduce(state: Attention, event: Event): { state: Attention; change?: Change } {
  const data = isRecord(event.data) ? event.data : {}
  if (event.type === "permission.asked" && typeof data.id === "string" && typeof data.sessionID === "string") {
    const pending = new Map(state.pending).set(data.id, data.sessionID)
    return {
      state: { ...state, pending },
      change: { kind: "asked", sessionID: data.sessionID, action: typeof data.action === "string" ? data.action : "" },
    }
  }
  if (event.type === "permission.replied" && typeof data.requestID === "string") {
    if (!state.pending.has(data.requestID)) return { state }
    const pending = new Map(state.pending)
    pending.delete(data.requestID)
    return { state: { ...state, pending } }
  }
  if (event.type === "session.status" && typeof data.sessionID === "string" && isRecord(data.status)) {
    const type = data.status.type
    const busy = new Set(state.busy)
    if (type === "busy" || type === "retry") {
      busy.add(data.sessionID)
      return { state: { ...state, busy } }
    }
    if (type === "idle") {
      const wasBusy = busy.delete(data.sessionID)
      // A finished session has no prompts left waiting.
      const pending = new Map([...state.pending].filter(([, session]) => session !== data.sessionID))
      return {
        state: { pending, busy },
        ...(wasBusy ? { change: { kind: "finished" as const, sessionID: data.sessionID } } : {}),
      }
    }
  }
  return { state }
}

/** Splits server-sent-event text into complete events; returns the incomplete remainder. */
export function parseFrames(buffer: string): { events: Event[]; rest: string } {
  const frames = buffer.replaceAll("\r\n", "\n").split("\n\n")
  const rest = frames.pop() ?? ""
  const events = frames.flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return []
    try {
      const value: unknown = JSON.parse(data)
      return isRecord(value) && typeof value.type === "string" ? [{ type: value.type, data: value.data }] : []
    } catch {
      return []
    }
  })
  return { events, rest }
}

export type Connection = { readonly url: string; readonly password: string }

/**
 * Follows the event stream, reconnecting with growing delays (1 s doubling to 30 s) until stopped.
 * `onConnect` runs after every (re)connection, so the caller can re-read state that events missed
 * while disconnected.
 */
export class EventStream {
  private stopped = false
  private abort: AbortController | undefined
  private delay = 1_000

  constructor(
    private readonly options: {
      readonly connection: () => Promise<Connection | undefined>
      readonly onEvent: (event: Event) => void
      readonly onConnect?: (connection: Connection) => Promise<void> | void
      readonly log?: (line: string) => void
      readonly fetch?: typeof fetch
    },
  ) {}

  start() {
    this.stopped = false
    void this.loop()
  }

  stop() {
    this.stopped = true
    this.abort?.abort()
  }

  private async loop() {
    while (!this.stopped) {
      const connection = await this.options.connection().catch(() => undefined)
      if (connection && !this.stopped) {
        await this.follow(connection).catch((error: unknown) => {
          if (!this.stopped) this.options.log?.(`event stream: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      if (this.stopped) return
      await new Promise((resolve) => setTimeout(resolve, this.delay))
      this.delay = Math.min(this.delay * 2, 30_000)
    }
  }

  private async follow(connection: Connection) {
    this.abort = new AbortController()
    const response = await (this.options.fetch ?? fetch)(`${connection.url}/api/event`, {
      headers: { accept: "text/event-stream", authorization: basic(connection.password) },
      signal: this.abort.signal,
    })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    this.delay = 1_000
    await this.options.onConnect?.(connection)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    const buffer = { text: "" }
    while (!this.stopped) {
      const chunk = await reader.read()
      if (chunk.done) return
      const parsed = parseFrames(buffer.text + chunk.value)
      buffer.text = parsed.rest
      for (const event of parsed.events) this.options.onEvent(event)
    }
  }
}

export function basic(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
