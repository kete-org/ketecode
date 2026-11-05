import { describe as group, expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { describe, keyName, outcomeOf, rawText } from "../../src/kete/keymap-debug"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"

group("helpers", () => {
  test("keyName writes keys the way bindings are written, with Meta as alt", () => {
    expect(keyName({ name: "t", ctrl: true, meta: false, shift: false })).toBe("ctrl+t")
    expect(keyName({ name: ".", ctrl: false, meta: true, shift: false })).toBe("alt+.")
    expect(keyName({ name: "k", ctrl: true, meta: true, shift: true, super: false })).toBe("ctrl+alt+shift+k")
  })

  test("rawText escapes control bytes", () => {
    expect(rawText("\x1b.")).toBe("\\x1b.")
    expect(rawText("\x14")).toBe("\\x14")
    expect(rawText("a")).toBe("a")
  })

  test("outcomes: a command with its title, a pending sequence, no binding", () => {
    expect(describe(outcomeOf("binding-handled", { id: "variant.cycle", title: "Variant cycle" }))).toBe(
      "runs variant.cycle (Variant cycle)",
    )
    expect(describe(outcomeOf("sequence-pending", undefined))).toContain("waiting for the next key")
    expect(describe(outcomeOf("no-match", undefined))).toContain("no binding")
    expect(describe(outcomeOf("binding-rejected", undefined))).toContain("disabled")
  })
})

test("/keymap debug shows the binding a pressed key resolves to, and turns off again", async () => {
  await using tmp = await tmpdir()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "project",
    title: "Keymap debug session",
    agent: "build",
    model: { providerID: "demo", id: "first" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    state: tmp.path,
    config: { animations: false },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "first",
              providerID: "demo",
              name: "first model",
              variants: [{ id: "low" }, { id: "high" }],
              cost: [],
              time: { released: 0 },
            },
          ],
        })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Keymap debug session"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)

  await setup.mockInput.typeText("/keymap debug")
  setup.mockInput.pressEscape()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Key debugging on"))

  setup.mockInput.pressKey("t", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Key: ctrl+t") && frame.includes("runs variant.cycle"))
  // The key still does its job.
  await setup.waitForFrame((frame) => frame.includes("· low"))

  await setup.mockInput.typeText("q")
  await setup.waitForFrame((frame) => frame.includes("Key: q") && frame.includes("no binding"))

  setup.mockInput.pressBackspace()
  await setup.waitFor(() => (setup.renderer.currentFocusedRenderable as TextareaRenderable).plainText === "")
  await setup.mockInput.typeText("/keymap debug")
  setup.mockInput.pressEscape()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Key debugging off"))
  setup.mockInput.pressKey("t", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("· high"))
  expect(setup.captureCharFrame()).not.toContain("Key: ctrl+t")
})

test("from the command palette, on and off show their own notices", async () => {
  await using tmp = await tmpdir()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  await using setup = await createAppFixture({
    state: tmp.path,
    config: { animations: false },
    fetch: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    },
  })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const palette = async () => {
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("Debug key presses")
    await setup.waitForFrame((frame) => frame.includes("Debug key presses"))
    await setup.renderOnce()
    setup.mockInput.pressEnter()
  }
  await palette()
  await setup.waitForFrame((frame) => frame.includes("Key debugging on"))
  await palette()
  await setup.waitForFrame((frame) => frame.includes("Key debugging off"))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain("Key: return")
})
