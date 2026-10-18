import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { previewLines } from "../../src/kete/share"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { tmpdir } from "../fixture/fixture"

const preview = {
  counts: { messages: 4, tools: 3, diffs: 2 },
  bytes: 2048,
  redactions: 2,
  truncated: false,
  visibility: "org",
  linkAllowed: false,
  maxDays: 30,
  digest: "d1",
}

test("previewLines say what is sent, what is not, and the expiry", () => {
  const lines = previewLines({ ...preview, truncated: true } as never, "org").join("\n")
  expect(lines).toContain("4 messages, 3 tool calls, 2 changed files (2 KB)")
  expect(lines).toContain("Secrets removed: 2")
  expect(lines).toContain("Not sent: reasoning")
  expect(lines).toContain("expires in 30 days")
  expect(lines).toContain("left out to fit")
  expect(previewLines(preview as never, "link").join("\n")).toContain("Anyone with the link")
})

test("/share previews then shares and shows the link; /unshare is enabled and asks first", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 110, height: 34, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  Object.defineProperty(setup.renderer, "capabilities", { get: () => null })
  const sessionID = "ses_share"
  const events = createEventStream()
  const rpc: Array<{ method: string; input: unknown }> = []
  const calls = createFetch(async (url, request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: "Share fixture",
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    const method = /^\/api\/rpc\/kete\.share\/(\w+)$/.exec(url.pathname)?.[1]
    if (method) {
      rpc.push({ method, input: (await request.json()).input })
      if (method === "preview") return json({ output: preview })
      if (method === "share")
        return json({
          output: {
            record: { id: "s1", url: "https://portal.example/shares/s1", visibility: "org", expires_at: "2026-11-17T00:00:00Z", session: sessionID },
          },
        })
      return json({ output: { removed: true } })
    }
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  const palette = async (query: string) => {
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText(query)
  }
  try {
    await palette("Share session")
    await setup.waitForFrame((frame) => /Share session\s+Session/.test(frame))
    setup.mockInput.pressEnter()
    const dialog = await setup.waitForFrame((frame) => frame.includes("Secrets removed: 2"))
    expect(dialog).toContain("4 messages, 3 tool calls, 2 changed files")
    expect(dialog).toContain("Members of your organization")
    // Nothing is uploaded until Enter.
    expect(rpc.map((item) => item.method)).toEqual(["preview"])
    setup.mockInput.pressEnter()
    const shared = await setup.waitForFrame((frame) => frame.includes("Session shared"))
    expect(shared).toContain("https://portal.example/shares/s1")
    expect(rpc.map((item) => item.method)).toEqual(["preview", "share"])
    expect(rpc[1]!.input).toEqual({ sessionID, visibility: "org", digest: "d1" }) // only what was previewed

    await palette("Unshare session")
    await setup.waitForFrame((frame) => /Unshare session\s+Session/.test(frame))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("The link stops working"))
    expect(rpc.map((item) => item.method)).toEqual(["preview", "share"]) // asked first, nothing deleted yet
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Share deleted."))
    expect(rpc.map((item) => item.method)).toEqual(["preview", "share", "unshare"])
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
