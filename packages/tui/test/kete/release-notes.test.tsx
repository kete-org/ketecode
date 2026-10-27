import { expect, afterEach, beforeEach, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { autoShow, EMPTY, plainLines, title } from "../../src/kete/release-notes"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

// The build defines KETE_RELEASE_NOTES (packages/cli/script/build.ts); in a test it is a global.
const globals = globalThis as { KETE_RELEASE_NOTES?: string }
afterEach(() => {
  delete globals.KETE_RELEASE_NOTES
})

const NOTES = "- **Status line:** shows the `branch` and mode.\n- Ctrl+R searches your prompt history."
const LINE = "Ctrl+R searches your prompt history."
const seenFile = (state: string, channel: string) => path.join(state, channel, "tui", "kete-release-notes.json")
const seen = async (state: string, channel: string) =>
  JSON.parse(await readFile(seenFile(state, channel), "utf8").catch(() => "{}")) as { version?: string }

async function start(state: string, app: { version: string; channel: string }, lastSeen?: string) {
  await mkdir(path.join(state, app.channel, "tui"), { recursive: true })
  if (lastSeen) await writeFile(seenFile(state, app.channel), JSON.stringify({ version: lastSeen }))
  return createAppFixture({ state, app: { name: "test", ...app } })
}

/** The home screen is up and had time to open a startup dialog. */
async function settled(setup: Awaited<ReturnType<typeof createAppFixture>>) {
  await setup.waitForFrame((frame) => frame.includes("╰"))
  await Bun.sleep(150)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

test("autoShow: only a release build newer than the last seen version with notes shows them", () => {
  const base = { notes: NOTES, version: "0.2.7", channel: "latest" }
  expect(autoShow({ ...base, lastSeen: "0.2.6" })).toEqual({ show: true, record: true })
  expect(autoShow({ ...base, notes: "", lastSeen: "0.2.6" })).toEqual({ show: false, record: true })
  expect(autoShow({ ...base, lastSeen: "0.2.7" })).toEqual({ show: false, record: false })
  expect(autoShow({ ...base, lastSeen: "0.3.0" })).toEqual({ show: false, record: false })
  expect(autoShow({ ...base, version: "0.3.0-rc.1", lastSeen: "0.2.7" })).toEqual({ show: true, record: true })
  // First run ever: nothing was upgraded; remember the version for the next upgrade.
  expect(autoShow({ ...base, lastSeen: undefined })).toEqual({ show: false, record: true })
  // A hand-edited stored value is replaced, not trusted.
  expect(autoShow({ ...base, lastSeen: "garbage" })).toEqual({ show: false, record: true })
  // Preview, dev and source builds never auto-show or record.
  for (const channel of ["feature-release-notes", "dev", "local", "test"])
    expect(autoShow({ ...base, channel, lastSeen: "0.2.6" })).toEqual({ show: false, record: false })
  expect(autoShow({ ...base, version: "local", lastSeen: "0.2.6" })).toEqual({ show: false, record: false })
})

test("plainLines: bullets, bold and code spans become plain terminal text", () => {
  expect(plainLines(NOTES)).toEqual(["• Status line: shows the branch and mode.", `• ${LINE}`])
  expect(plainLines("  - nested\n\nplain")).toEqual(["  • nested", "", "plain"])
  // Hard-wrapped bullets become one paragraph each; blank lines stay.
  expect(plainLines("- one\n  two\n- three\n\npara\nmore")).toEqual(["• one two", "• three", "", "para more"])
  expect(title("0.2.7")).toBe("What's new in 0.2.7")
  expect(title("local")).toBe("What's new")
})

test("after an upgrade the notes show once, are recorded, and don't show again after a restart", async () => {
  globals.KETE_RELEASE_NOTES = NOTES
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  const app = { version: "0.2.7", channel: "latest" }
  {
    await using setup = await start(state, app, "0.2.6")
    const frame = await setup.waitForFrame((frame) => frame.includes(LINE))
    expect(frame).toContain("What's new in 0.2.7")
    expect(frame).toContain("• Status line: shows the branch and mode.")
    await setup.waitFor(async () => (await seen(state, "latest")).version === "0.2.7")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => !frame.includes(LINE))
  }
  expect(await seen(state, "latest")).toEqual({ version: "0.2.7" })

  await using again = await start(state, app)
  expect(await settled(again)).not.toContain(LINE)
})

test("first run: no stored version, nothing shows, the version is recorded", async () => {
  globals.KETE_RELEASE_NOTES = NOTES
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await using setup = await start(state, { version: "0.2.7", channel: "latest" })
  expect(await settled(setup)).not.toContain(LINE)
  await setup.waitFor(async () => (await seen(state, "latest")).version === "0.2.7")
})

test("a preview build never auto-shows and records nothing", async () => {
  globals.KETE_RELEASE_NOTES = NOTES
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await using setup = await start(state, { version: "0.0.0-feature-x-202610110900", channel: "feature-x" }, "0.0.0")
  expect(await settled(setup)).not.toContain(LINE)
  expect(await seen(state, "feature-x")).toEqual({ version: "0.0.0" })
})

test("/release-notes shows the embedded notes any time", async () => {
  globals.KETE_RELEASE_NOTES = NOTES
  await using tmp = await tmpdir()
  await using setup = await start(path.join(tmp.path, "state"), { version: "0.0.0-main-1", channel: "main" })
  expect(await settled(setup)).not.toContain(LINE)
  await setup.mockInput.typeText("/release-notes")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes(LINE))
  expect(frame).toContain("What's new in 0.0.0-main-1")
})

test("/release-notes without embedded notes says so", async () => {
  await using tmp = await tmpdir()
  await using setup = await start(path.join(tmp.path, "state"), { version: "0.0.0-dev-1", channel: "dev" })
  await settled(setup)
  await setup.mockInput.typeText("/release-notes")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes(EMPTY))
  expect(frame).toContain("What's new")
})
