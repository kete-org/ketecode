// Which editor the web UI is embedded in, and how it talks to it. One adapter for both IDE clients
// (docs: the vscode-extension and jetbrains-plugin cards); the messages themselves are the same in
// both (./vscode-messages.ts validates what arrives, the editors validate what they receive).
//
// - VS Code: the extension frames the web UI in an iframe named "kete-vscode" inside its webview
//   (packages/kete-vscode/src/chat.ts). Out: `window.parent.postMessage`; in: `message` events whose
//   source is the parent window.
// - JetBrains: the plugin loads the web UI as the top-level page of a JCEF browser, at
//   `/connect?kete-host=jetbrains#<pairing>`, and injects `window.__keteJetBrains.postMessage`
//   (a JBCefJSQuery) once the page loads. Out: that function (queued until it exists); in:
//   `kete-jetbrains-message` CustomEvents the plugin dispatches with `executeJavaScript`. The flag is
//   kept in sessionStorage, since the connect page navigates away from its query.

export type IdeHost = "vscode" | "jetbrains"

export const VSCODE_FRAME = "kete-vscode"
export const JETBRAINS_QUERY = "kete-host"
export const JETBRAINS_STORAGE_KEY = "kete.host"
export const JETBRAINS_READY_EVENT = "kete-jetbrains-ready"
export const JETBRAINS_MESSAGE_EVENT = "kete-jetbrains-message"

type JetBrainsBridge = { readonly postMessage: (message: unknown) => void }

declare global {
  interface Window {
    /** Injected by the JetBrains plugin (packages/kete-jetbrains core/Bridge.kt); untrusted shape until checked. */
    __keteJetBrains?: unknown
  }
}

/** What detection looks at, so it can be tested without a browser. */
export type HostEnvironment = {
  /** `window.name`. */
  readonly name: string
  /** Whether the page has a parent window (it is framed). */
  readonly framed: boolean
  /** `location.search`. */
  readonly search: string
  /** The remembered sessionStorage flag, if any. */
  readonly stored: string | null | undefined
  /** Whether the plugin's bridge object is present. */
  readonly bridge: boolean
}

/** The embedding editor, or undefined in a plain browser tab. */
export function detectHost(env: HostEnvironment): IdeHost | undefined {
  if (env.framed && env.name === VSCODE_FRAME) return "vscode"
  if (env.framed) return undefined
  if (env.bridge) return "jetbrains"
  if (new URLSearchParams(env.search).get(JETBRAINS_QUERY) === "jetbrains") return "jetbrains"
  if (env.stored === "jetbrains") return "jetbrains"
  return undefined
}

function storage() {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage
  } catch {
    // Storage can be disabled; detection then relies on the query or the bridge.
    return undefined
  }
}

function bridge(): JetBrainsBridge | undefined {
  if (typeof window === "undefined") return undefined
  const value = window.__keteJetBrains
  if (typeof value !== "object" || value === null || !("postMessage" in value)) return undefined
  const post = value.postMessage
  return typeof post === "function" ? { postMessage: (message) => post.call(value, message) } : undefined
}

/** The current page's host. Remembers a JetBrains host for later navigations in this tab. */
export function currentHost(): IdeHost | undefined {
  if (typeof window === "undefined") return undefined
  const store = storage()
  const host = detectHost({
    name: window.name,
    framed: window.parent !== window,
    search: window.location.search,
    stored: store?.getItem(JETBRAINS_STORAGE_KEY),
    bridge: bridge() !== undefined,
  })
  if (host === "jetbrains") {
    try {
      store?.setItem(JETBRAINS_STORAGE_KEY, "jetbrains")
    } catch {
      // Not remembered; the bridge marker still identifies the host once injected.
    }
  }
  return host
}

const outbox: unknown[] = []
const flush = { listening: false }

function flushOutbox() {
  const target = bridge()
  if (!target) return
  outbox.splice(0).forEach((message) => target.postMessage(message))
}

/** Sends a message to the editor; does nothing in a plain browser tab. */
export function postToHost(message: Record<string, unknown>) {
  const host = currentHost()
  if (host === "vscode") {
    // "*": the parent is the extension's webview, whose origin VS Code generates. Messages hold
    // nothing secret, and the extension validates every one.
    window.parent.postMessage(message, "*")
    return
  }
  if (host !== "jetbrains") return
  const target = bridge()
  if (target) return target.postMessage(message)
  // Before the plugin has injected its bridge: keep the message until it says it is ready.
  outbox.push(message)
  if (outbox.length > 100) outbox.shift()
  if (!flush.listening) {
    flush.listening = true
    window.addEventListener(JETBRAINS_READY_EVENT, flushOutbox)
  }
}

/** Calls `listener` with every message the editor sends; returns the unsubscribe function. */
export function onHostMessage(listener: (data: unknown) => void): () => void {
  const host = currentHost()
  if (host === "vscode") {
    const handler = (event: MessageEvent) => {
      // Only the extension's webview, never another frame or window.
      if (event.source !== window.parent) return
      listener(event.data)
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }
  if (host === "jetbrains") {
    const handler = (event: Event) => {
      if (event instanceof CustomEvent) listener(event.detail)
    }
    window.addEventListener(JETBRAINS_MESSAGE_EVENT, handler)
    return () => window.removeEventListener(JETBRAINS_MESSAGE_EVENT, handler)
  }
  return () => undefined
}
