import { describe, expect, spyOn, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { codeBlocks, options } from "../../src/kete/copy-picker"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"

const REPLY = [
  "Two steps.",
  "",
  "```ts",
  "const first = 1",
  "```",
  "",
  "Then:",
  "",
  "~~~bash",
  "bun test",
  "echo done",
  "~~~",
].join("\n")

describe("codeBlocks", () => {
  test("finds backtick and tilde fences in order, with their languages", () => {
    expect(codeBlocks(REPLY)).toEqual([
      { language: "ts", code: "const first = 1" },
      { language: "bash", code: "bun test\necho done" },
    ])
  })

  test("a longer fence holds a shorter one; a fence of the other kind doesn't close it", () => {
    expect(codeBlocks("````md\n```js\nx\n```\n~~~\n````")).toEqual([{ language: "md", code: "```js\nx\n```\n~~~" }])
  })

  test("an unclosed fence runs to the end; no fence, no blocks; indentation up to the fence's is removed", () => {
    expect(codeBlocks("```\nlast")).toEqual([{ code: "last" }])
    expect(codeBlocks("plain `code` text")).toEqual([])
    expect(codeBlocks("  ```py\n  print(1)\n    nested\n  ```")).toEqual([{ language: "py", code: "print(1)\n  nested" }])
  })

  test("a backtick fence with a backtick in its info string isn't a fence (so the last ``` opens one)", () => {
    expect(codeBlocks("``` a`b\nx\n```")).toEqual([{ code: "" }])
  })
})

test("options: the response, one row per code block, and the transcript only when asked", () => {
  const rows = options(REPLY, true)
  expect(rows.map((row) => row.title)).toEqual(["Response", "Code block 1 · ts", "Code block 2 · bash", "Transcript"])
  expect(rows[2]!.description).toBe("bun test")
  expect(rows[2]!.value).toEqual({ kind: "text", text: "bun test\necho done", what: "Code block 2 · bash" })
  expect(options(REPLY, false).map((row) => row.title)).not.toContain("Transcript")
})

test("/copy opens the picker and copies exactly the chosen code block", async () => {
  await using tmp = await tmpdir()
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "project",
    title: "Copy picker session",
    agent: "build",
    model: { providerID: "demo", id: "first" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  await using setup = await createAppFixture({
    state: tmp.path,
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
          data: [
            {
              id: "msg_reply",
              type: "assistant",
              agent: session.agent,
              model: session.model,
              time: { created: 2 },
              content: [{ type: "text", text: REPLY }],
            },
            { id: "msg_ask", type: "user", text: "How do I run it?", time: { created: 1 } },
          ],
          cursor: {},
        })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  Object.defineProperty(setup.renderer, "capabilities", { get: () => null })
  const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true)
  try {
    await setup.waitForFrame((frame) => frame.includes("Then:"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await setup.waitForFrame((frame) => frame.includes("Demo Model"))
    await setup.mockInput.typeText("/copy")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Code block 2 · bash") && frame.includes("Transcript"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("bash")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Code block 2 · bash copied to clipboard"))
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy.mock.calls[0]?.[0]).toBe("bun test\necho done")
  } finally {
    copy.mockRestore()
  }
})
