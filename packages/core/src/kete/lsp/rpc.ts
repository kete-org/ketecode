// JSON-RPC 2.0 over a language server's stdin/stdout, as the Language Server Protocol frames it:
// `Content-Length: <bytes>\r\n\r\n<json>`. Kept small and dependency-free (no vscode-jsonrpc) and
// independent of how the process was started, so tests drive it with plain buffers.
//
// Bounds: a frame larger than 16 MiB, or a header block larger than 8 KiB, closes the connection;
// every request has a timeout; requests the server makes of us that we don't handle get a
// "method not found" error so the server never waits on us.

export * as KeteLspRpc from "./rpc.js"

export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_HEADER_BYTES = 8 * 1024
const SEPARATOR = new Uint8Array([13, 10, 13, 10])

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

type Handler = (params: unknown) => unknown

export interface Options {
  /** Writes one encoded frame to the server's stdin. */
  readonly write: (frame: Uint8Array) => void
  /** Called once when the connection fails (bad frame) or is closed. */
  readonly onClose?: (reason: string) => void
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

export function encode(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.byteLength + body.byteLength)
  frame.set(header, 0)
  frame.set(body, header.byteLength)
  return frame
}

export class Connection {
  private buffer: Uint8Array = new Uint8Array(0)
  private nextID = 1
  private closed: string | undefined
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly notifications = new Map<string, Handler>()
  private readonly requests = new Map<string, Handler>()

  constructor(private readonly options: Options) {}

  get isClosed() {
    return this.closed !== undefined
  }

  onNotification(method: string, handler: Handler) {
    this.notifications.set(method, handler)
  }

  onRequest(method: string, handler: Handler) {
    this.requests.set(method, handler)
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(new RpcError(`connection closed: ${this.closed}`))
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new RpcError(String(error)))
      }
    })
  }

  /** Feeds bytes read from the server's stdout. */
  feed(chunk: Uint8Array) {
    if (this.closed !== undefined) return
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
    next.set(this.buffer, 0)
    next.set(chunk, this.buffer.byteLength)
    this.buffer = next
    while (this.closed === undefined) {
      const end = indexOf(this.buffer, SEPARATOR, 0)
      if (end === -1) {
        if (this.buffer.byteLength > MAX_HEADER_BYTES) this.close("header too large")
        return
      }
      if (end > MAX_HEADER_BYTES) return this.close("header too large")
      const header = new TextDecoder().decode(this.buffer.subarray(0, end))
      const match = /^content-length:\s*(\d+)\s*$/im.exec(header)
      if (!match) return this.close("frame without Content-Length")
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) return this.close("frame too large")
      const start = end + SEPARATOR.byteLength
      if (this.buffer.byteLength < start + length) return
      const body = this.buffer.subarray(start, start + length)
      this.buffer = this.buffer.slice(start + length)
      let message: unknown
      try {
        message = JSON.parse(new TextDecoder().decode(body))
      } catch {
        continue // a malformed message is skipped; the framing is still intact
      }
      this.dispatch(message)
    }
  }

  close(reason = "closed") {
    if (this.closed !== undefined) return
    this.closed = reason
    this.buffer = new Uint8Array(0)
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer)
      item.reject(new RpcError(`connection closed: ${reason}`))
      this.pending.delete(id)
    }
    this.options.onClose?.(reason)
  }

  private send(message: unknown) {
    if (this.closed !== undefined) return
    this.options.write(encode(message))
  }

  private dispatch(message: unknown) {
    if (typeof message !== "object" || message === null) return
    const record = message as Record<string, unknown>
    const method = typeof record.method === "string" ? record.method : undefined
    const id = typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined
    if (method === undefined) {
      // A response to one of our requests.
      if (typeof id !== "number") return
      const item = this.pending.get(id)
      if (!item) return
      this.pending.delete(id)
      clearTimeout(item.timer)
      if (typeof record.error === "object" && record.error !== null) {
        const error = record.error as Record<string, unknown>
        item.reject(
          new RpcError(
            typeof error.message === "string" ? error.message : "request failed",
            typeof error.code === "number" ? error.code : undefined,
          ),
        )
        return
      }
      item.resolve(record.result)
      return
    }
    if (id === undefined) {
      const handler = this.notifications.get(method)
      if (!handler) return
      try {
        handler(record.params)
      } catch {
        // A handler bug must not break the read loop.
      }
      return
    }
    const handler = this.requests.get(method)
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    let result: unknown
    try {
      result = handler(record.params)
    } catch (error) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "error" } })
      return
    }
    this.send({ jsonrpc: "2.0", id, result: result ?? null })
  }
}
