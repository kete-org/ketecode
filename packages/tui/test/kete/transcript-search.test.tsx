import { describe, expect, test } from "bun:test"
import { BoxRenderable, InputRenderable, TextareaRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { TuiKeybind } from "../../src/config/keybind"
import { collect, findOffsets, selectionCells } from "../../src/kete/transcript-search"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"

describe("findOffsets", () => {
  test("finds every case-insensitive, non-overlapping occurrence", () => {
    const starts = (text: string, query: string) => findOffsets(text, query).map((hit) => hit.start)
    expect(starts("Needle, needle and NEEDLE", "needle")).toEqual([0, 8, 19])
    expect(starts("aaaa", "aa")).toEqual([0, 2])
    // Offsets are into the text itself, even when lower-casing would change a character's length.
    expect(findOffsets("İx needle", "needle")).toEqual([{ start: 3, end: 9 }])
    // Regex characters in the query are literal.
    expect(starts("a.b (c) a*b", "(c)")).toEqual([4])
  })

  test("an empty query or no occurrence finds nothing", () => {
    expect(findOffsets("text", "")).toEqual([])
    expect(findOffsets("text", "z")).toEqual([])
  })
})

test("selectionCells select exactly the match in wrapped and multi-line text", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 20, height: 10 })
  try {
    const box = new BoxRenderable(renderer, { id: "box", paddingLeft: 2, paddingTop: 1, width: 20 })
    const text = new TextRenderable(renderer, {
      id: "text",
      content: "hello world, find the needle here\nsecond\tline needle",
      wrapMode: "word",
    })
    box.add(text)
    renderer.root.add(box)
    await renderOnce()
    const hits = collect(renderer.root, "needle", renderer.widthMethod)
    expect(hits.map((hit) => hit.start)).toEqual([22, 46])
    // "find the" wraps across two visual lines.
    for (const [start, end] of [[22, 28], [46, 52], [13, 21]] as const) {
      const { anchor, focus } = selectionCells(text, start, end, renderer.widthMethod)
      renderer.clearSelection()
      renderer.startSelection(text, text.x + anchor.col, text.y + anchor.row)
      renderer.updateSelection(text, text.x + focus.col, text.y + focus.row)
      await renderOnce()
      expect(renderer.getSelection()?.getSelectedText()).toBe(text.plainText.slice(start, end))
    }
  } finally {
    renderer.destroy()
  }
})

test("the default key is <leader>/", () => {
  expect(TuiKeybind.defaultValue("session.search")).toBe("<leader>/")
})

async function openSession(root: string) {
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "project",
    title: "Transcript search session",
    agent: "build",
    model: { providerID: "demo", id: "first" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const reply = (id: string, created: number, text: string) => ({
    id,
    type: "assistant",
    agent: session.agent,
    model: session.model,
    time: { created },
    content: [{ type: "text", text }],
  })
  const setup = await createAppFixture({
    state: root,
    height: 40,
    config: { animations: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "first", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          // Newest first, as the server pages them.
          data: [
            reply("msg_c", 4, "Last reply mentions the Needle once."),
            { id: "msg_b", type: "user", text: "where is the needle?", time: { created: 3 } },
            reply("msg_a", 2, "First reply: a needle in a haystack."),
            { id: "msg_0", type: "user", text: "start", time: { created: 1 } },
          ],
          cursor: {},
        })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Demo Model") && frame.includes("Last reply"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  return setup
}

const selected = (setup: Awaited<ReturnType<typeof openSession>>) => setup.renderer.getSelection()?.getSelectedText()

test("<leader>/ finds matches across messages; ↑/↓ and n/N walk them; Esc clears the highlight", async () => {
  await using tmp = await tmpdir()
  await using setup = await openSession(tmp.path)

  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("/")
  await setup.waitForFrame((frame) => frame.includes("find:"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("needle")
  // The newest match is selected first.
  await setup.waitForFrame((frame) => frame.includes("3/3"))
  await setup.waitFor(() => selected(setup) === "Needle")

  setup.mockInput.pressArrow("up")
  await setup.waitForFrame((frame) => frame.includes("2/3"))
  await setup.waitFor(() => selected(setup) === "needle")
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("3/3"))

  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("n older"))
  // Enter keeps the match highlighted.
  await setup.waitFor(() => selected(setup) === "Needle")
  setup.mockInput.pressKey("n")
  await setup.waitForFrame((frame) => frame.includes("2/3"))
  setup.mockInput.pressKey("n")
  await setup.waitForFrame((frame) => frame.includes("1/3"))
  await setup.waitFor(() => selected(setup) === "needle")
  setup.mockInput.pressKey("n", { shift: true })
  await setup.waitForFrame((frame) => frame.includes("2/3"))
  // n and N walked matches; they weren't typed into the query.
  expect((setup.renderer.currentFocusedEditor as InputRenderable).value).toBe("needle")

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("find:"))
  expect(setup.renderer.getSelection()).toBeNull()
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
})

test("/find opens the search; a query with no match says so", async () => {
  await using tmp = await tmpdir()
  await using setup = await openSession(tmp.path)

  await setup.mockInput.typeText("/find")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("find:"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("haystackz")
  await setup.waitForFrame((frame) => frame.includes("no matches"))
  expect(setup.renderer.getSelection()).toBeNull()
})

test("from the command palette, the search bar keeps the focus", async () => {
  await using tmp = await tmpdir()
  await using setup = await openSession(tmp.path)

  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("Search this session")
  await setup.waitForFrame((frame) => frame.includes("Search this session"))
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("find:"))
  // Typing outlasts the dialog's own 1 ms refocus of the prompt; every letter must reach the search bar.
  await setup.mockInput.typeText("needle")
  await setup.waitForFrame((frame) => frame.includes("3/3"))
  expect(setup.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
})
