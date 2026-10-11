import { expect, mock, test } from "bun:test"
import path from "node:path"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"

// Every side effect of /feedback is faked: no browser, no account or log read, no file written.
const calls = { opened: [] as string[], saved: [] as string[] }
const PLANTED = "sk-ant-api03-PLANTEDkey0123456789abcdef"
mock.module("../../src/kete/feedback-deps", () => ({
  openURL: async (url: string) => {
    calls.opened.push(url)
  },
  signedIn: async () => false,
  logTail: async () =>
    `timestamp=2026-10-11T09:00:00.000Z level=ERROR message="request failed" error="key ${PLANTED} for alice@example.com" args="[\\"PLANTED prompt\\"]"\n`,
  save: async (text: string) => {
    calls.saved.push(text)
    return "/tmp/kete-bug-fake.md"
  },
}))

function reset() {
  calls.opened.length = 0
  calls.saved.length = 0
}

async function openFeedback(command = "/feedback") {
  const tmp = await tmpdir()
  const setup = await createAppFixture({ state: path.join(tmp.path, "state"), height: 40 })
  await setup.waitForFrame((frame) => frame.includes("╰"))
  await setup.mockInput.typeText(command)
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("## Environment"))
  return { setup, frame, tmp }
}

test("/feedback shows the report; Cancel closes it and sends nothing", async () => {
  reset()
  const { setup, frame, tmp } = await openFeedback()
  await using _tmp = tmp
  await using _setup = setup
  expect(frame).toContain("Report a problem")
  expect(frame).toContain("Open issue")
  expect(frame).toContain("Security problem? Don't open a public issue")
  expect(frame).toContain("- Signed in: no")
  expect(frame).not.toContain("PLANTED")
  expect(frame).not.toContain("alice@example.com")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("## Environment"))
  await Bun.sleep(100)
  expect(calls.opened).toEqual([])
  expect(calls.saved).toEqual([])
})

test("/bug is the same dialog; Open issue calls the opener with the pre-filled issue URL", async () => {
  reset()
  const { setup, tmp } = await openFeedback("/bug")
  await using _tmp = tmp
  await using _setup = setup
  setup.mockInput.pressKey("o")
  await setup.waitFor(async () => calls.opened.length === 1)
  const url = calls.opened[0]!
  expect(url.startsWith("https://github.com/kete-org/ketecode/issues/new?")).toBe(true)
  const params = new URL(url).searchParams
  expect(params.get("template")).toBe("bug-report.yml")
  expect(params.get("description")).toContain("## Environment")
  expect(params.get("description")).toContain("[REDACTED]")
  expect(decodeURIComponent(url)).not.toContain("PLANTED")
  expect(decodeURIComponent(url)).not.toContain("alice@example.com")
  await setup.waitForFrame((frame) => frame.includes("Opened the issue form") && frame.includes("Opening the form sends this report"))
})
