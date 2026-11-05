import { describe, expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { step } from "../../src/kete/variant-step"
import { TuiKeybind } from "../../src/config/keybind"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"

describe("step", () => {
  const variants = ["low", "medium", "high"]

  test("raises from the default to the first variant, then one at a time, and stops at the top", () => {
    expect(step(undefined, variants, 1)).toBe("low")
    expect(step("low", variants, 1)).toBe("medium")
    expect(step("high", variants, 1)).toBe("high")
  })

  test("lowers one at a time down to the default, and stops there", () => {
    expect(step("high", variants, -1)).toBe("medium")
    expect(step("low", variants, -1)).toBeUndefined()
    expect(step(undefined, variants, -1)).toBeUndefined()
    expect(step("default", variants, -1)).toBeUndefined()
  })

  test("a 'default' entry in the list isn't a step; an unknown current counts as the default", () => {
    expect(step(undefined, ["default", "low"], 1)).toBe("low")
    expect(step("gone", variants, 1)).toBe("low")
  })
})

test("defaults: Alt+. raises and Alt+, lowers", () => {
  expect(TuiKeybind.defaultValue("variant.next")).toBe("alt+.")
  expect(TuiKeybind.defaultValue("variant.previous")).toEqual({ name: ",", meta: true })
})

test("Alt+. and Alt+, move the variant in the prompt and stop at the ends; in the palette too", async () => {
  await using tmp = await tmpdir()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "project",
    title: "Variant step session",
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
  const metadata = (frame: string) => frame.split("\n").find((line) => line.includes("first model")) ?? ""
  await setup.waitForFrame((frame) => frame.includes("Build · first model"))
  expect(metadata(setup.captureCharFrame())).not.toMatch(/· (low|high)/)

  setup.mockInput.pressKey(".", { meta: true })
  await setup.waitForFrame((frame) => metadata(frame).includes("· low"))
  setup.mockInput.pressKey(".", { meta: true })
  await setup.waitForFrame((frame) => metadata(frame).includes("· high"))
  setup.mockInput.pressKey(".", { meta: true })
  await setup.renderOnce()
  expect(metadata(setup.captureCharFrame())).toContain("· high")

  setup.mockInput.pressKey(",", { meta: true })
  await setup.waitForFrame((frame) => metadata(frame).includes("· low"))
  setup.mockInput.pressKey(",", { meta: true })
  await setup.waitForFrame((frame) => !/· (low|high)/.test(metadata(frame)))
  setup.mockInput.pressKey(",", { meta: true })
  await setup.renderOnce()
  expect(metadata(setup.captureCharFrame())).not.toMatch(/· (low|high)/)

  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof InputRenderable)
  await setup.mockInput.typeText("Raise model")
  await setup.waitForFrame((frame) => frame.includes("Raise model variant"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => metadata(frame).includes("· low"))
})
