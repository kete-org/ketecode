import { afterEach, describe, expect, test } from "bun:test"
import {
  currentHost,
  detectHost,
  JETBRAINS_MESSAGE_EVENT,
  JETBRAINS_READY_EVENT,
  JETBRAINS_STORAGE_KEY,
  onHostMessage,
  postToHost,
} from "./ide-host"
import { tipVisible } from "./panel-state"
import { mode, themeMessage, tokens } from "./vscode-theme"
import { contextMessage, panelMessage } from "./vscode-messages"

const plain = { name: "", framed: false, search: "", stored: null, bridge: false }

describe("detectHost", () => {
  test("VS Code: framed in the extension's named iframe", () => {
    expect(detectHost({ ...plain, framed: true, name: "kete-vscode" })).toBe("vscode")
  })
  test("another frame, or a framed page claiming JetBrains, is no host", () => {
    expect(detectHost({ ...plain, framed: true, name: "other" })).toBeUndefined()
    expect(detectHost({ ...plain, framed: true, search: "?kete-host=jetbrains", bridge: true })).toBeUndefined()
  })
  test("JetBrains: the query flag, the remembered flag, or the injected bridge", () => {
    expect(detectHost({ ...plain, search: "?kete-host=jetbrains" })).toBe("jetbrains")
    expect(detectHost({ ...plain, stored: "jetbrains" })).toBe("jetbrains")
    expect(detectHost({ ...plain, bridge: true })).toBe("jetbrains")
  })
  test("a plain browser tab, or an unknown flag value, is no host", () => {
    expect(detectHost(plain)).toBeUndefined()
    expect(detectHost({ ...plain, search: "?kete-host=emacs", stored: "emacs" })).toBeUndefined()
  })
  test("the window name alone doesn't make a top-level page VS Code", () => {
    expect(detectHost({ ...plain, name: "kete-vscode" })).toBeUndefined()
  })
})

describe("JetBrains transport", () => {
  afterEach(() => {
    delete window.__keteJetBrains
    sessionStorage.removeItem(JETBRAINS_STORAGE_KEY)
  })

  test("no host: nothing is sent and nothing is received", () => {
    expect(currentHost()).toBeUndefined()
    const received: unknown[] = []
    const stop = onHostMessage((data) => received.push(data))
    window.dispatchEvent(new CustomEvent(JETBRAINS_MESSAGE_EVENT, { detail: { type: "kete.workspace" } }))
    stop()
    expect(received).toEqual([])
  })

  test("messages wait for the bridge, then go through it in order", () => {
    sessionStorage.setItem(JETBRAINS_STORAGE_KEY, "jetbrains")
    expect(currentHost()).toBe("jetbrains")
    postToHost({ type: "kete.hello" })
    postToHost({ type: "kete.session", sessionID: null })
    const sent: unknown[] = []
    window.__keteJetBrains = { postMessage: (message: unknown) => sent.push(message) }
    window.dispatchEvent(new Event(JETBRAINS_READY_EVENT))
    expect(sent).toEqual([{ type: "kete.hello" }, { type: "kete.session", sessionID: null }])
    postToHost({ type: "kete.contextAdded", path: "a.ts" })
    expect(sent.at(-1)).toEqual({ type: "kete.contextAdded", path: "a.ts" })
  })

  test("the bridge marker alone identifies the host and is remembered", () => {
    window.__keteJetBrains = { postMessage: () => undefined }
    expect(currentHost()).toBe("jetbrains")
    expect(sessionStorage.getItem(JETBRAINS_STORAGE_KEY)).toBe("jetbrains")
  })

  test("incoming messages arrive as plugin events, and unsubscribe stops them", () => {
    sessionStorage.setItem(JETBRAINS_STORAGE_KEY, "jetbrains")
    const received: unknown[] = []
    const stop = onHostMessage((data) => received.push(data))
    window.dispatchEvent(new CustomEvent(JETBRAINS_MESSAGE_EVENT, { detail: { type: "kete.addContext", path: "a.ts" } }))
    // Ordinary postMessage traffic is not the JetBrains channel.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "kete.addContext", path: "b.ts" } }))
    stop()
    window.dispatchEvent(new CustomEvent(JETBRAINS_MESSAGE_EVENT, { detail: { type: "kete.addContext", path: "c.ts" } }))
    expect(received).toEqual([{ type: "kete.addContext", path: "a.ts" }])
  })
})

describe("JetBrains messages use the same validators", () => {
  // What the plugin's Theme.kt sends: the IDE's colours under the VS Code variable names.
  const jetbrainsDark = {
    type: "kete.theme",
    kind: "dark",
    variables: {
      "--vscode-editor-background": "#1e1f22",
      "--vscode-sideBar-background": "#2b2d30",
      "--vscode-foreground": "#dfe1e5",
      "--vscode-button-background": "#3574f0",
      "--vscode-focusBorder": "#3574f0",
      "--vscode-font-family": "Inter, sans-serif",
      "--vscode-editor-font-family": "JetBrains Mono, monospace",
      "--vscode-font-size": "13px",
      "--jetbrains-unknown": "#ffffff",
    },
  }

  test("the IDE theme maps onto the web UI's tokens, accent included", () => {
    const theme = themeMessage(jetbrainsDark)
    expect(theme).toBeDefined()
    expect(mode(theme!)).toBe("dark")
    const mapped = tokens(theme!)
    expect(mapped["--v2-background-bg-base"]).toBe("#2b2d30")
    expect(mapped["--v2-background-bg-accent"]).toBe("#3574f0")
    expect(mapped["--font-family-mono"]).toBe("JetBrains Mono, monospace")
    expect(Object.values(mapped)).not.toContain("#ffffff")
  })

  test("a light IDE theme is light; unsafe values are dropped", () => {
    const theme = themeMessage({
      ...jetbrainsDark,
      kind: "light",
      variables: { "--vscode-foreground": "red; background: url(x)", "--vscode-editor-background": "#ffffff" },
    })
    expect(mode(theme!)).toBe("light")
    expect(tokens(theme!)).toEqual({
      "--v2-background-bg-base": "#ffffff",
      "--v2-background-bg-deep": "#ffffff",
      "--v2-background-bg-layer-01": "#ffffff",
    })
  })

  test("context and panel messages validate the same way", () => {
    expect(contextMessage({ type: "kete.addContext", path: "src/a.kt", startLine: 4, endLine: 2 })).toEqual({
      path: "src/a.kt",
      startLine: 4,
      endLine: 4,
    })
    expect(panelMessage({ type: "kete.panel", platform: "other", defaultMode: "ask", cliHint: true, notices: [] })).toEqual({
      platform: "other",
      defaultMode: "ask",
      cliHint: true,
      notices: [],
    })
  })

  test("the Alt+K tip shows in either editor host, not in a browser", () => {
    const state = { platform: "other" as const, notices: [], cliHint: false, defaultMode: "default" as const }
    expect(tipVisible({ ...state, host: "jetbrains" })).toBe(true)
    expect(tipVisible({ ...state, host: "vscode" })).toBe(true)
    expect(tipVisible({ ...state, host: "browser" })).toBe(false)
  })
})
