// One language server connection: the `initialize` handshake, opening and changing documents, and
// collecting the diagnostics the server publishes. The protocol flow follows OpenCode v1's client
// (packages/opencode/src/lsp/client.ts at v1.4.9): full-text sync, `workspace/configuration`
// answered with the server's settings, diagnostics settled after a short quiet period because
// servers publish syntax errors first and semantic ones later.

export * as KeteLspClient from "./client.js"

import { pathToFileURL, fileURLToPath } from "url"
import path from "path"
import { KeteLspDiagnostics } from "./diagnostics.js"
import { KeteLspRpc } from "./rpc.js"
import { KeteLspServers } from "./servers.js"

export interface Timeouts {
  /** `initialize` must answer within this. */
  readonly initialize: number
  /** How long to wait for a file's diagnostics after opening or changing it. */
  readonly diagnostics: number
  /** Diagnostics count as settled after this long without a new publish for the file. */
  readonly quiet: number
}

/** Files whose latest diagnostics a client keeps. */
export const MAX_PUBLISHED = 2000

export const defaultTimeouts: Timeouts = { initialize: 20_000, diagnostics: 4_000, quiet: 300 }

export interface Options {
  readonly serverID: string
  readonly root: string
  readonly initialization?: Readonly<Record<string, unknown>>
  readonly timeouts?: Partial<Timeouts>
  /** Writes one frame to the server's stdin. */
  readonly write: (frame: Uint8Array) => void
  /** Called once when the connection ends (the process exited or sent garbage). */
  readonly onClose?: (reason: string) => void
}

/** The key diagnostics are stored under: an absolute, normalized path (case-folded on Windows). */
export function normalize(file: string, platform: NodeJS.Platform = process.platform) {
  const resolved = path.resolve(file)
  return platform === "win32" ? resolved.toLowerCase() : resolved
}

export class Client {
  readonly connection: KeteLspRpc.Connection
  readonly timeouts: Timeouts
  private readonly versions = new Map<string, number>()
  private readonly published = new Map<string, ReadonlyArray<KeteLspDiagnostics.Diagnostic>>()
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(readonly options: Options) {
    this.timeouts = { ...defaultTimeouts, ...options.timeouts }
    this.connection = new KeteLspRpc.Connection({ write: options.write, onClose: options.onClose })
    this.connection.onNotification("textDocument/publishDiagnostics", (params) => this.publish(params))
    this.connection.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: unknown[] } | undefined)?.items
      return (Array.isArray(items) ? items : [undefined]).map(() => options.initialization ?? {})
    })
    this.connection.onRequest("workspace/workspaceFolders", () => [
      { name: path.basename(options.root) || "workspace", uri: pathToFileURL(options.root).href },
    ])
    this.connection.onRequest("window/workDoneProgress/create", () => null)
    this.connection.onRequest("client/registerCapability", () => null)
    this.connection.onRequest("client/unregisterCapability", () => null)
    this.connection.onNotification("window/logMessage", () => {})
  }

  get closed() {
    return this.connection.isClosed
  }

  /** Sends `initialize` and `initialized`. Rejects on timeout or an error answer. */
  async initialize(processID?: number) {
    const uri = pathToFileURL(this.options.root).href
    await this.connection.request(
      "initialize",
      {
        processId: processID ?? process.pid,
        rootUri: uri,
        workspaceFolders: [{ name: path.basename(this.options.root) || "workspace", uri }],
        initializationOptions: this.options.initialization ?? {},
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didSave: false },
            publishDiagnostics: { versionSupport: true },
          },
        },
      },
      this.timeouts.initialize,
    )
    this.connection.notify("initialized", {})
    if (this.options.initialization)
      this.connection.notify("workspace/didChangeConfiguration", { settings: this.options.initialization })
  }

  /** Opens the file, or sends its new text if it is open already. */
  touch(file: string, text: string) {
    const key = normalize(file)
    const uri = pathToFileURL(file).href
    const version = this.versions.get(key)
    if (version === undefined) {
      this.published.delete(key)
      this.connection.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: KeteLspServers.languageID(file), version: 0, text },
      })
      this.versions.set(key, 0)
      return
    }
    this.versions.set(key, version + 1)
    this.connection.notify("textDocument/didChange", {
      textDocument: { uri, version: version + 1 },
      contentChanges: [{ text }],
    })
  }

  /**
   * The file's diagnostics once the server has published for it and gone quiet, or what is known
   * when the wait runs out. Call right after `touch`.
   */
  diagnostics(file: string): Promise<ReadonlyArray<KeteLspDiagnostics.Diagnostic>> {
    const key = normalize(file)
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined
      const listeners = this.listeners.get(key) ?? new Set<() => void>()
      this.listeners.set(key, listeners)
      const finish = () => {
        clearTimeout(deadline)
        if (quiet) clearTimeout(quiet)
        listeners.delete(listener)
        if (listeners.size === 0) this.listeners.delete(key)
        resolve(this.published.get(key) ?? [])
      }
      const listener = () => {
        if (quiet) clearTimeout(quiet)
        quiet = setTimeout(finish, this.timeouts.quiet)
      }
      const deadline = setTimeout(finish, this.timeouts.diagnostics)
      listeners.add(listener)
      if (this.closed) finish()
    })
  }

  /** Asks the server to shut down and exit; the caller then ends the process. */
  async shutdown(timeout = 2_000) {
    if (this.closed) return
    await this.connection.request("shutdown", null, timeout).catch(() => undefined)
    this.connection.notify("exit")
    this.connection.close("shut down")
  }

  private publish(params: unknown) {
    if (typeof params !== "object" || params === null) return
    const record = params as { uri?: unknown; diagnostics?: unknown }
    if (typeof record.uri !== "string" || !record.uri.startsWith("file:") || !Array.isArray(record.diagnostics)) return
    let file: string
    try {
      file = fileURLToPath(record.uri)
    } catch {
      return
    }
    const key = normalize(file)
    const items = record.diagnostics
      .slice(0, 1000)
      .map(KeteLspDiagnostics.parse)
      .filter((item): item is KeteLspDiagnostics.Diagnostic => item !== undefined)
    this.published.delete(key)
    this.published.set(key, items)
    // Servers publish for files nobody asked about; keep only the most recent ones.
    for (const oldest of this.published.keys()) {
      if (this.published.size <= MAX_PUBLISHED) break
      this.published.delete(oldest)
    }
    for (const listener of this.listeners.get(key) ?? []) listener()
  }
}
