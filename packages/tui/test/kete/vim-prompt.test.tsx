import { beforeEach, describe, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { Config } from "../../src/config"
import { columnOf } from "../../src/kete/text-columns"
import { keyOf, read, write } from "../../src/kete/vim-prompt"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// App tests share a process-wide home draft (see test/kete/history-search-prompt.test.tsx).
beforeEach(() => void takeDraft(undefined))

describe("keys", () => {
  test("keys: the typed character, shifted letters, Ctrl keys", () => {
    expect(keyOf({ name: "a", sequence: "a", ctrl: false, meta: false, shift: false })).toEqual({ name: "a", char: "a" })
    expect(keyOf({ name: "g", sequence: "G", ctrl: false, meta: false, shift: true })).toEqual({ name: "g", char: "G" })
    expect(keyOf({ name: "g", sequence: "\x1b[103;2u", ctrl: false, meta: false, shift: true })).toEqual({ name: "g", char: "G" })
    expect(keyOf({ name: "r", sequence: "\x12", ctrl: true, meta: false, shift: false })).toEqual({ name: "r", ctrl: true })
    expect(keyOf({ name: "escape", sequence: "\x1b", ctrl: false, meta: false, shift: false })).toEqual({ name: "escape" })
  })
})

test("write applies a change to a real textarea, with wide characters before it", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 40, height: 6 })
  try {
    const textarea = new TextareaRenderable(renderer, { id: "t", width: 30, height: 4, initialValue: "中😀 foo bar\nnext" })
    renderer.root.add(textarea)
    textarea.focus()
    await renderOnce()
    const before = { text: textarea.plainText, cursor: 4 }
    textarea.cursorOffset = columnOf(before.text, before.cursor)
    expect(read(textarea)).toEqual(before)
    write(textarea, before, { text: "中😀 bar\nnext", cursor: 4 })
    expect(textarea.plainText).toBe("中😀 bar\nnext")
    expect(read(textarea).cursor).toBe(4)
    write(textarea, read(textarea), { text: "中😀 bar\nnew\nnext", cursor: 9 })
    expect(textarea.plainText).toBe("中😀 bar\nnew\nnext")
    expect(read(textarea).cursor).toBe(9)
  } finally {
    renderer.destroy()
  }
})

test("write keeps tabs and edits whole graphemes (emoji sharing a surrogate, flags sharing a letter)", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 40, height: 6 })
  try {
    const textarea = new TextareaRenderable(renderer, { id: "t", width: 30, height: 4, initialValue: "\tab" })
    renderer.root.add(textarea)
    textarea.focus()
    await renderOnce()
    // x on the a after a tab.
    write(textarea, { text: "\tab", cursor: 1 }, { text: "\tb", cursor: 1 })
    expect(textarea.plainText).toBe("\tb")
    expect(read(textarea).cursor).toBe(1)
    for (const [from, to] of [["x😃y", "x😀y"], ["🇬🇧", "🇬🇭"], ["a🇬🇭b", "ab"]]) {
      write(textarea, read(textarea), { text: from, cursor: 0 })
      expect(textarea.plainText).toBe(from)
      write(textarea, { text: from, cursor: 0 }, { text: to, cursor: 0 })
      expect(textarea.plainText).toBe(to)
    }
  } finally {
    renderer.destroy()
  }
})

async function openPrompt(root: string, config: Config.Info) {
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const setup = await createAppFixture({
    state: root,
    config,
    fetch: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "first", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    },
  })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await setup.waitForFrame((frame) => frame.includes("Demo Model"))
  return setup
}

const textarea = (setup: Awaited<ReturnType<typeof openPrompt>>) => setup.renderer.currentFocusedEditor as TextareaRenderable

test("vim on: type, Esc to normal mode (shown in the status line), edit with motions and operators, undo", async () => {
  await using tmp = await tmpdir()
  await using setup = await openPrompt(tmp.path, { animations: false, vim: true })
  await setup.waitForFrame((frame) => frame.includes("INSERT"))

  await setup.mockInput.typeText("hello big world")
  await setup.waitFor(() => textarea(setup).plainText === "hello big world")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("NORMAL"))

  await setup.mockInput.typeText("0wdw")
  await setup.waitFor(() => textarea(setup).plainText === "hello world")
  await setup.mockInput.typeText("u")
  await setup.waitFor(() => textarea(setup).plainText === "hello big world")
  setup.mockInput.pressKey("r", { ctrl: true })
  await setup.waitFor(() => textarea(setup).plainText === "hello world")

  await setup.mockInput.typeText("$a!")
  await setup.waitForFrame((frame) => frame.includes("INSERT"))
  await setup.waitFor(() => textarea(setup).plainText === "hello world!")
  setup.mockInput.pressEscape()
  await setup.mockInput.typeText("0wciwthere")
  await setup.waitFor(() => textarea(setup).plainText === "hello there!")
})

test("vim off (the default): the same keys type as usual", async () => {
  await using tmp = await tmpdir()
  await using setup = await openPrompt(tmp.path, { animations: false })
  await setup.mockInput.typeText("hello")
  setup.mockInput.pressEscape()
  await setup.mockInput.typeText("0wdw")
  await setup.waitFor(() => textarea(setup).plainText === "hello0wdw")
  expect(setup.captureCharFrame()).not.toContain("NORMAL")
})

test("/vim turns vim keys on and saves the setting", async () => {
  await using tmp = await tmpdir()
  await using setup = await openPrompt(tmp.path, { animations: false })
  await setup.mockInput.typeText("/vim")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Vim keys on"))
  await setup.waitForFrame((frame) => frame.includes("INSERT"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("NORMAL"))
  // The setting was saved: the next /vim reads it as on and turns it off.
  await setup.mockInput.typeText("i/vim")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Vim keys off"))
  await setup.waitForFrame((frame) => !frame.includes("INSERT") && !frame.includes("NORMAL"))
})
