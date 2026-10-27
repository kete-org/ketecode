import { expect, beforeEach, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { Config } from "../../src/config"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

const location = { directory, project: { id: "project", directory, canonical: directory } }
// A new session ID per test: the prompt keeps an unsent draft per session ID across mounts (draft-stash).
const newSession = () => ({
  id: `ses_${crypto.randomUUID()}`,
  title: "History search session",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
})

const history = [
  { text: "fix tests", files: [], agents: [], pasted: [] },
  { text: "build", files: [], agents: [], pasted: [] },
  { text: "fix lint", files: [], agents: [], pasted: [], mode: "shell" },
]

async function render(root: string, config: Config.Info = { animations: false }) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "prompt-history.jsonl"), history.map((line) => JSON.stringify(line)).join("\n") + "\n")
  const sent: string[] = []
  const session = newSession()
  const setup = await createAppFixture({
    state,
    args: { sessionID: session.id },
    config,
    fetch: (url, request) => {
      if (request.method !== "GET" && url.pathname.startsWith("/api/session")) sent.push(url.pathname)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
    },
  })
  return Object.assign(setup, { sent })
}

type Setup = Awaited<ReturnType<typeof render>>

const textarea = (setup: Setup) => {
  const focused = setup.renderer.currentFocusedRenderable
  return focused instanceof TextareaRenderable && !(focused instanceof InputRenderable) ? focused : undefined
}

async function typeDraft(setup: Setup) {
  await setup.waitForFrame((frame) => frame.includes("History search session"))
  await setup.waitFor(() => textarea(setup) !== undefined)
  await setup.mockInput.typeText("draft")
  await setup.waitForFrame((frame) => frame.includes("draft"))
}

async function searchFix(setup: Setup) {
  setup.mockInput.pressKey("r", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("history search:"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof InputRenderable)
  await setup.mockInput.typeText("fix")
  await setup.waitForFrame((frame) => frame.includes("fix lint"))
}

test("search: Ctrl+R finds the newest match, Ctrl+R again is older, Enter fills the prompt without sending", async () => {
  await using tmp = await tmpdir()
  await using setup = await render(tmp.path)
  await typeDraft(setup)
  await searchFix(setup)

  setup.mockInput.pressKey("r", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("fix tests"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => textarea(setup)?.plainText === "fix tests")
  const frame = await setup.waitForFrame((frame) => !frame.includes("history search:"))

  expect(frame).toContain("fix tests")
  expect(textarea(setup)?.plainText).toBe("fix tests")
  expect(setup.sent).toEqual([])
})

test("search: Enter on a shell entry restores shell mode", async () => {
  await using tmp = await tmpdir()
  await using setup = await render(tmp.path)
  await typeDraft(setup)
  await searchFix(setup)

  setup.mockInput.pressEnter()
  await setup.waitFor(() => textarea(setup)?.plainText === "fix lint")
  expect(textarea(setup)?.traits).toMatchObject({ status: "SHELL" })
  expect(setup.sent).toEqual([])
})

test("search: Esc closes the bar and leaves the typed draft unchanged", async () => {
  await using tmp = await tmpdir()
  await using setup = await render(tmp.path)
  await typeDraft(setup)
  await searchFix(setup)

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("history search:"))
  await setup.waitFor(() => textarea(setup) !== undefined)

  expect(textarea(setup)?.plainText).toBe("draft")
  expect(setup.sent).toEqual([])
})

test("rename: the leader sequence opens rename, and it is in the palette", async () => {
  await using tmp = await tmpdir()
  await using setup = await render(tmp.path)
  await typeDraft(setup)

  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("r", { shift: true })
  await setup.waitForFrame((frame) => frame.includes("Rename Session") || frame.includes("Rename session"))
  setup.mockInput.pressEscape()
  await setup.waitFor(() => textarea(setup) !== undefined)

  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof InputRenderable)
  await setup.mockInput.typeText("Rename")
  const frame = await setup.waitForFrame((frame) => frame.includes("Rename session"))
  expect(frame).toContain("Rename session")
})

test("rename: with a ctrl+r override, Ctrl+R in the focused prompt renames and doesn't search", async () => {
  await using tmp = await tmpdir()
  await using setup = await render(tmp.path, { animations: false, keybinds: { "session.rename": "ctrl+r" } })
  await typeDraft(setup)

  setup.mockInput.pressKey("r", { ctrl: true })
  const frame = await setup.waitForFrame((frame) => frame.includes("Rename Session") || frame.includes("Rename session"))
  expect(frame).not.toContain("history search:")
})
