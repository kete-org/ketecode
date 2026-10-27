import { expect, beforeEach, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { InputRenderable } from "@opentui/core"
import { KeteNotices } from "@opencode/util/kete/notices"
import type { Config } from "../../src/config"
import { fetchNoticeConditions, fitCount, fitSegments, visibleNotices, type Conditions } from "../../src/kete/home-notices"
import { pickTip, TIPS } from "../../src/kete/home-tips"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

const notices = KeteNotices.list({ agentCommand: "/agents" })
const PORTAL = "Agents from your portal"
const AGENTS_MD = "Kete reads your AGENTS.md"
const location = { directory, project: { id: "proj_test", directory, canonical: directory } }

const status = (overrides: Partial<NonNullable<Conditions["sync"]>> = {}) => ({
  signedIn: true,
  managedAgents: 2,
  offline: false,
  ...overrides,
})

test("notice conditions: portal-agents needs signed in, synced agents and online; agents-md needs AGENTS.md", () => {
  const ids = (conditions: Conditions, dismissed: string[] = []) =>
    visibleNotices({ notices, conditions, dismissed }).map((notice) => notice.id)
  expect(ids({ sync: status(), agentsMd: true })).toEqual(["portal-agents", "agents-md"])
  expect(ids({ sync: status({ managedAgents: 0 }), agentsMd: true })).toEqual(["agents-md"])
  expect(ids({ sync: status({ offline: true }), agentsMd: false })).toEqual([])
  expect(ids({ sync: status({ signedIn: false }), agentsMd: false })).toEqual([])
  expect(ids({ sync: undefined, agentsMd: false })).toEqual([])
  expect(ids({ sync: status(), agentsMd: false })).toEqual(["portal-agents"])
  expect(ids({ sync: status(), agentsMd: true }, ["portal-agents"])).toEqual(["agents-md"])
  expect(ids({ sync: status(), agentsMd: true }, ["portal-agents", "agents-md"])).toEqual([])
})

test("notice conditions: a failed request hides its notice, is reported, and never throws", async () => {
  const errors: string[] = []
  const failing = {
    rpc: { call: () => Promise.reject(new Error("rpc down")) },
    file: { list: () => Promise.reject(new Error("fs down")) },
  } as unknown as Parameters<typeof fetchNoticeConditions>[0]
  const result = await fetchNoticeConditions(failing, undefined, (what) => void errors.push(what))
  expect(result).toEqual({ sync: undefined, agentsMd: false })
  expect(errors.sort()).toEqual(["AGENTS.md", "sync status"])

  // A malformed status is a failure too, not a guess.
  const malformed = {
    rpc: { call: () => Promise.resolve({ output: { managedAgents: -1 } }) },
    file: { list: () => Promise.resolve({ location, data: [{ type: "file", path: "AGENTS.md" }] }) },
  } as unknown as Parameters<typeof fetchNoticeConditions>[0]
  const partial = await fetchNoticeConditions(malformed, undefined, (what) => void errors.push(what))
  expect(partial).toEqual({ sync: undefined, agentsMd: true })
})

test("notice text: code spans fit the width and truncate with an ellipsis", () => {
  const segments = KeteNotices.segments("Pick one with `/agents`.")
  expect(fitSegments(segments, 100)).toEqual(segments)
  expect(fitSegments(segments, 17)).toEqual([
    { type: "text", value: "Pick one with " },
    { type: "code", value: "/a…" },
  ])
  expect(fitSegments(segments, 0)).toEqual([])
})

test("notice rows: only whole notices render (2 rows, then 3 with the blank line between)", () => {
  expect([0, 1, 2, 4, 5, 7, 8].map(fitCount)).toEqual([0, 0, 1, 1, 2, 2, 3])
})

test("tip: pickTip is stable for an index and wraps", () => {
  expect(pickTip(0)).toBe(TIPS[0])
  expect(pickTip(1)).toBe(pickTip(1))
  expect(pickTip(TIPS.length)).toBe(TIPS[0])
  expect(pickTip(-1)).toBe(TIPS.at(-1))
  expect(pickTip(Number.NaN)).toBe(TIPS[0])
  expect(pickTip(3, [])).toBeUndefined()
  for (const tip of TIPS) expect(tip.length).toBeLessThan(80)
})

type Answers = { managedAgents?: number; agentsMd?: boolean; fail?: boolean }

async function home(
  state: string,
  answers: Answers,
  options: { config?: Config.Info; width?: number; height?: number } = {},
) {
  await mkdir(state, { recursive: true })
  const asked = { status: 0, list: 0 }
  const setup = await createAppFixture({
    state,
    width: options.width ?? 100,
    height: options.height ?? 30,
    config: options.config ?? { animations: false },
    fetch: (url) => {
      if (url.pathname === "/api/rpc/kete.sync/status") {
        asked.status++
        if (answers.fail) return json({ message: "boom" }, { status: 500 })
        return json({ output: { signedIn: true, managedAgents: answers.managedAgents ?? 0, offline: false } })
      }
      if (url.pathname === "/api/fs/list") {
        asked.list++
        if (answers.fail) return json({ message: "boom" }, { status: 500 })
        return json({ location, data: answers.agentsMd ? [{ type: "file", path: "AGENTS.md" }] : [] })
      }
    },
  })
  return Object.assign(setup, { asked })
}

type Home = Awaited<ReturnType<typeof home>>

/** Both conditions were answered, and the screen had time to show the result. */
async function settled(setup: Home) {
  await setup.waitFor(() => setup.asked.status > 0 && setup.asked.list > 0)
  await Bun.sleep(150)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

const tipLines = (frame: string) => frame.split("\n").filter((line) => line.trim().startsWith("Tip:"))
const dismissedFile = (state: string) => path.join(state, "test", "tui", "kete-notices.json")

test("notice: both notices show under the logo with synced agents and an AGENTS.md", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), { managedAgents: 2, agentsMd: true })
  const frame = await setup.waitForFrame((frame) => frame.includes(PORTAL) && frame.includes(AGENTS_MD))
  expect(frame).toContain("Pick one with /agents.")
  expect(frame).toContain("Project conventions in AGENTS.md load at the start of every session.")
  expect(tipLines(frame)).toEqual([])
})

test("notice: neither shows with no synced agents and no AGENTS.md", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), { managedAgents: 0, agentsMd: false })
  const frame = await settled(setup)
  expect(frame).not.toContain(PORTAL)
  expect(frame).not.toContain(AGENTS_MD)
})

test("notice: an RPC error hides the notices and the home screen still works", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), { fail: true })
  const frame = await settled(setup)
  expect(frame).not.toContain(PORTAL)
  expect(frame).not.toContain(AGENTS_MD)
  expect(tipLines(frame)).toHaveLength(1)
})

test("notice: ✕ dismisses it, the dismissal is stored, and it stays dismissed after a restart", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  {
    await using setup = await home(state, { agentsMd: true })
    const frame = await setup.waitForFrame((frame) => frame.includes(AGENTS_MD))
    const lines = frame.split("\n")
    const row = lines.findIndex((line) => line.includes(AGENTS_MD))
    const column = lines[row]!.indexOf("✕")
    expect(column).toBeGreaterThan(0)
    await setup.mockMouse.click(column, row)
    const after = await setup.waitForFrame((frame) => !frame.includes(AGENTS_MD))
    expect(tipLines(after)).toHaveLength(1)
    await setup.waitFor(async () => (await readFile(dismissedFile(state), "utf8").catch(() => "")).includes("agents-md"))
  }
  expect(JSON.parse(await readFile(dismissedFile(state), "utf8"))).toEqual({ dismissed: ["agents-md"] })

  // A restart: a fresh app and storage on the same state directory.
  await using again = await home(state, { agentsMd: true })
  const frame = await settled(again)
  expect(frame).not.toContain(AGENTS_MD)
})

test("notice: \"Dismiss home notices\" in the command palette dismisses every visible notice", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await using setup = await home(state, { managedAgents: 1, agentsMd: true })
  await setup.waitForFrame((frame) => frame.includes(PORTAL) && frame.includes(AGENTS_MD))
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof InputRenderable)
  await setup.mockInput.typeText("Dismiss home")
  await setup.waitForFrame((frame) => frame.includes("Dismiss home notices"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(PORTAL) && !frame.includes(AGENTS_MD))
  await setup.waitFor(async () => (await readFile(dismissedFile(state), "utf8").catch(() => "")).includes("agents-md"))
  expect(JSON.parse(await readFile(dismissedFile(state), "utf8"))).toEqual({ dismissed: ["portal-agents", "agents-md"] })
})

test("tip: exactly one tip line shows when no notice is visible", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), {})
  const frame = await setup.waitForFrame((frame) => frame.includes("Tip:"))
  expect(tipLines(frame)).toHaveLength(1)
  expect(TIPS.some((tip) => frame.includes(tip))).toBe(true)
})

test("tip: none while a notice is visible", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), { agentsMd: true })
  const frame = await setup.waitForFrame((frame) => frame.includes(AGENTS_MD))
  expect(tipLines(frame)).toEqual([])
})

test("tip: none with \"tips\": false", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), {}, { config: { animations: false, tips: false } })
  const frame = await settled(setup)
  expect(tipLines(frame)).toEqual([])
})

test("tip: no tip and no notices under 12 rows", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), { agentsMd: true }, { height: 11 })
  const frame = await settled(setup)
  expect(tipLines(frame)).toEqual([])
  expect(frame).not.toContain(AGENTS_MD)
})

test("notice: on a short terminal only whole notices show and the prompt keeps its space", async () => {
  await using tmp = await tmpdir()
  await using setup = await home(path.join(tmp.path, "state"), { managedAgents: 1, agentsMd: true }, { height: 20 })
  const frame = await setup.waitForFrame((frame) => frame.includes(PORTAL))
  expect(frame).toContain("Pick one with /agents.")
  expect(frame).not.toContain(AGENTS_MD)
  expect(frame).toContain("╰")
})
