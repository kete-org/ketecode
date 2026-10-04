import { describe, expect, test } from "bun:test"
import { chatHtml, pairingUrl } from "../src/chat"

describe("pairingUrl", () => {
  test("encodes the web UI's pairing payload in the /connect fragment", () => {
    const url = new URL(pairingUrl("http://127.0.0.1:49374", "s3cr/et+=?"))
    expect(url.origin).toBe("http://127.0.0.1:49374")
    expect(url.pathname).toBe("/connect")
    // base64url only, as packages/app's decodePairingUrl requires.
    expect(url.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(url.hash.slice(1), "base64url").toString())).toEqual({
      username: "opencode",
      password: "s3cr/et+=?",
    })
  })

  test("keeps a forwarded server's host and port", () => {
    expect(pairingUrl("https://example-49374.app.github.dev/", "pw")).toStartWith(
      "https://example-49374.app.github.dev/connect#",
    )
  })
})

describe("chatHtml", () => {
  test("frames only the local web UI and relays only known messages", () => {
    const html = chatHtml({ url: pairingUrl("http://127.0.0.1:49374", "pw"), nonce: "abc123" })
    expect(html).toContain(
      `content="default-src 'none'; frame-src http://127.0.0.1:49374; style-src 'unsafe-inline'; script-src 'nonce-abc123'"`,
    )
    expect(html).toContain('<iframe id="kete" name="kete-vscode" src="http://127.0.0.1:49374/connect#')
    expect(html).toContain('<script nonce="abc123">')
    // The relay checks the frame's origin and only forwards listed message types.
    expect(html).toContain('const origin = "http://127.0.0.1:49374"')
    expect(html).toContain("if (event.origin !== origin) return;")
    expect(html).toContain("if (fromFrame.includes(data.type)) vscode.postMessage(data);")
    expect(html).toContain("frame.contentWindow.postMessage(data, origin)")
    expect(html).not.toContain("pw\"")
  })

  test("relays the panel bridge's message types, and only those", () => {
    const html = chatHtml({ url: pairingUrl("http://127.0.0.1:49374", "pw"), nonce: "abc123" })
    const fromFrame = JSON.parse(/const fromFrame = (\[.*?\]);/.exec(html)?.[1] ?? "[]")
    const toFrame = JSON.parse(/const toFrame = (\[.*?\]);/.exec(html)?.[1] ?? "[]")
    expect(fromFrame).toContain("kete.dismissNotice")
    expect(fromFrame).toContain("kete.dismissCliHint")
    expect(fromFrame).not.toContain("kete.panel")
    expect(toFrame).toContain("kete.panel")
    expect(toFrame).not.toContain("kete.dismissNotice")
  })

  test("shows an escaped error with a hint, with no script", () => {
    const html = chatHtml({ error: "Service <down>", hint: 'Run "kete service status"' })
    expect(html).toContain("Service &lt;down&gt;")
    expect(html).toContain("Run &quot;kete service status&quot;")
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain("<script")
  })

  test("shows progress while starting", () => {
    expect(chatHtml({ loading: "Starting Kete Code…" })).toContain("<p>Starting Kete Code…</p>")
  })
})

describe("theme relay", () => {
  test("the webview sends exactly the variables the web UI maps", async () => {
    const source = await Bun.file(new URL("../../app/src/kete/vscode-theme.ts", import.meta.url)).text()
    const block = source.slice(source.indexOf("export const VSCODE_VARIABLES"), source.indexOf("] as const"))
    const app = [...block.matchAll(/"(--vscode-[^"]+)"/g)].map((match) => match[1] ?? "")
    const { themeVariables } = await import("../src/chat")
    expect([...themeVariables] as string[]).toEqual(app)
  })

  test("the relay reads the theme, and sends it only to the web UI's origin", () => {
    const html = chatHtml({ url: pairingUrl("http://127.0.0.1:49374", "pw"), nonce: "n" })
    expect(html).toContain('"--vscode-editor-background"')
    expect(html).toContain("frame.contentWindow.postMessage(theme(), origin)")
    expect(html).toContain('if (data.type === "kete.hello") sendTheme();')
  })
})
