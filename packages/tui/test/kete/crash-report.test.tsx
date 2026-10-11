/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode/util/global"

// The crash screen opens the issue form through the `open` package: faked, no browser.
const opened: string[] = []
mock.module("open", () => ({
  default: async (url: string) => {
    opened.push(url)
  },
}))

const { ErrorComponent } = await import("../../src/component/error-component")
const { ClipboardProvider } = await import("../../src/context/clipboard")
const { ExitProvider } = await import("../../src/context/exit")
const { TuiAppProvider } = await import("../../src/context/runtime")

function renderCrash(error: Error, copied: string[] = []) {
  return testRender(
    () => (
      <ExitProvider exit={() => {}}>
        <ClipboardProvider value={{ read: async () => undefined, write: async (text) => void copied.push(text) }}>
          <TuiAppProvider value={{ name: "test", version: "0.2.7", channel: "latest" }}>
            <ErrorComponent error={error} reset={() => {}} />
          </TuiAppProvider>
        </ClipboardProvider>
      </ExitProvider>
    ),
    { width: 100, height: 30 },
  )
}

test("the crash screen still copies the report and opens a scrubbed issue on Kete's tracker", async () => {
  opened.length = 0
  const copied: string[] = []
  const error = new Error("boom with sk-ant-api03-PLANTEDkey0123456789abcdef")
  error.stack = `Error: boom\n    at run (${Global.Path.home}/work/app/src/index.ts:1:1)`
  const app = await renderCrash(error, copied)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Opening the form sends this report to GitHub")
    expect(frame).toContain("Copy report")
    expect(frame).toContain("Open issue")

    app.mockInput.pressKey("c")
    await Bun.sleep(20)
    expect(copied).toHaveLength(1)
    expect(copied[0]).toContain("**Stack trace:**")

    app.mockInput.pressKey("o")
    await Bun.sleep(20)
    expect(opened).toHaveLength(1)
    const url = opened[0]!
    expect(url.startsWith("https://github.com/kete-org/ketecode/issues/new?template=bug-report.yml")).toBe(true)
    const decoded = decodeURIComponent(url)
    for (const text of [decoded, copied[0]!]) {
      expect(text).not.toContain("PLANTED")
      expect(text).not.toContain(Global.Path.home)
      expect(text).toContain("~/work/app/src/index.ts")
    }
  } finally {
    app.renderer.destroy()
  }
})

test("a huge, multi-line crash message is one capped line: the link stays under the cap", async () => {
  opened.length = 0
  const copied: string[] = []
  const body = JSON.stringify({ prompt: "PLANTED-PROMPT refactor billing" })
  const error = new Error(`fetch failed for /srv/PLANTED-project/a.ts ${"x".repeat(50_000)}\nsecond line PLANTED-second ${body}`)
  error.stack = "Error: fetch failed\n    at run (index.ts:1:1)"
  const app = await renderCrash(error, copied)
  try {
    await app.renderOnce()
    app.mockInput.pressKey("o")
    await Bun.sleep(20)
    app.mockInput.pressKey("c")
    await Bun.sleep(20)
    expect(opened).toHaveLength(1)
    const url = new URL(opened[0]!)
    expect(opened[0]!.length).toBeLessThanOrEqual(6000)
    const title = url.searchParams.get("title") ?? ""
    expect(title.startsWith("TUI crash: fetch failed for <path> xxx")).toBe(true)
    expect(Buffer.byteLength(title)).toBeLessThanOrEqual("TUI crash: ".length + 200 + 3)
    const description = url.searchParams.get("description") ?? ""
    // The stack trace is still in the body, the message capped in front of it.
    expect(description).toContain("at run (index.ts:1:1)")
    for (const text of [decodeURIComponent(opened[0]!), copied[0]!]) expect(text).not.toContain("PLANTED")
  } finally {
    app.renderer.destroy()
  }
})
