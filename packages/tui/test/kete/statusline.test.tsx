/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { contextUsage } from "../../src/util/session"
import {
  contextEntry,
  DIRECTORY_MIN,
  fit,
  modeEntry,
  sandboxText,
  StatusLineView,
  unknownMessage,
  type Entry,
  type Palette,
} from "../../src/kete/statusline"
import { DEFAULT_ITEMS, ITEMS, move, parse, reset, save, toggle } from "../../src/kete/statusline-config"

const color = RGBA.fromInts(200, 200, 200)
const palette: Palette = { base: color, muted: color, accent: color, warning: color, error: color }

const sandbox: Entry = { id: "sandbox", text: "Unsandboxed", tone: "warning", glyph: "⚠" }
const fixture: Entry[] = [
  { id: "directory", text: "~/Development/kete-code", tone: "muted" },
  { id: "branch", text: "feature/status-line", tone: "accent" },
  modeEntry(undefined),
  contextEntry(85)!,
]

async function frame(entries: Entry[], width: number) {
  const app = await testRender(
    () => (
      <box width={width}>
        <StatusLineView entries={entries} colors palette={palette} />
      </box>
    ),
    { width, height: 4 },
  )
  await app.renderOnce()
  try {
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "")

describe("default", () => {
  test("no config gives the default items", () => {
    expect(parse(undefined)).toEqual({ items: DEFAULT_ITEMS, unknown: [], colors: true })
    expect(parse({ items: [] }).items).toEqual([])
  })

  test("the context item is the share left from contextUsage", () => {
    const messages = [
      { type: "assistant", tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, model: { providerID: "p", id: "m" } },
    ]
    const models = [{ providerID: "p", id: "m", limit: { context: 1000 } }]
    const usage = contextUsage(messages as never, models as never)
    expect(usage?.percent).toBe(15)
    expect(contextEntry(100 - usage!.percent!)?.text).toBe("85% left")
    expect(contextEntry(undefined)).toBeUndefined()
  })

  test("a 100-column row shows directory, branch, mode and context in order", async () => {
    const text = lines(await frame(fixture, 100))
    expect(text).toHaveLength(1)
    const row = text[0]!
    const positions = ["~/Development/kete-code", "feature/status-line", "Default", "85% left"].map((part) =>
      row.indexOf(part),
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test("context and mode colours follow thresholds", () => {
    expect(contextEntry(20)?.tone).toBe("warning")
    expect(contextEntry(5)?.tone).toBe("error")
    expect(contextEntry(60)?.tone).toBe("muted")
    expect(modeEntry("plan").tone).toBe("warning")
    expect(modeEntry("auto").tone).toBe("accent")
  })
})

describe("order and unknown", () => {
  test("the configured order is kept, duplicates drop, unknown IDs are reported", () => {
    expect(parse({ items: ["context", "mode", "nope", "mode", "nope"] })).toEqual({
      items: ["context", "mode"],
      unknown: ["nope"],
      colors: true,
    })
    expect(unknownMessage(["nope"])).toContain("nope")
    expect(unknownMessage(["nope"])).toContain(ITEMS[0])
  })
})

describe("narrow", () => {
  test("items drop from the end and keep a prefix", () => {
    for (const width of [60, 40]) {
      const kept = fit(fixture, width)
      expect(kept.map((entry) => entry.id)).toEqual(fixture.slice(0, kept.length).map((entry) => entry.id))
    }
    expect(fit(fixture, 100)).toHaveLength(4)
    expect(fit(fixture, 40).length).toBeLessThan(4)
  })

  test("the sandbox warning outlasts every other item", () => {
    const kept = fit([...fixture, sandbox], 40)
    expect(kept.at(-1)?.id).toBe("sandbox")
    expect(fit([...fixture, sandbox], 5).map((entry) => entry.id)).toEqual(["sandbox"])
  })

  test("a rendered row stays on one line at 60 and 40 columns", async () => {
    for (const width of [60, 40]) {
      const text = lines(await frame(fit([...fixture, sandbox], width), width))
      expect(text).toHaveLength(1)
      expect(text[0]).toContain("Unsandboxed")
    }
  })
})

describe("picker", () => {
  test("toggle, move and reset change the list", () => {
    expect(toggle(["mode"], "context")).toEqual(["mode", "context"])
    expect(toggle(["mode", "context"], "mode")).toEqual(["context"])
    expect(move(["directory", "branch", "mode"], "mode", -1)).toEqual(["directory", "mode", "branch"])
    expect(move(["directory", "branch"], "directory", -1)).toEqual(["directory", "branch"])
    expect(reset()).toEqual([...DEFAULT_ITEMS])
  })

  test("save writes only the statusline key and keeps unknown IDs", () => {
    const next: { animations: boolean; statusline?: { items?: string[]; colors?: boolean } } = {
      animations: false,
      statusline: { items: ["mode", "nope"] },
    }
    save(["context"], false)(next)
    expect(next).toEqual({ animations: false, statusline: { items: ["context", "nope"], colors: false } })
  })
})

describe("the directory shortens before other items drop", () => {
  const long: Entry[] = [
    { id: "directory", text: "~/Development/kete-code", tone: "muted" },
    { id: "branch", text: "feature/status-line", tone: "accent" },
    { id: "mode", text: "Default", tone: "muted" },
  ]

  test("at 44 columns the branch and mode stay and the directory is shortened", () => {
    const kept = fit(long, 44)
    expect(kept.map((entry) => entry.id)).toEqual(["directory", "branch", "mode"])
    expect(kept[1]!.text).toBe("feature/status-line")
    expect(kept[0]!.text.length).toBeLessThan("~/Development/kete-code".length)
    expect(kept[0]!.text).toEndWith("kete-code")
    expect(kept[0]!.text.length).toBeLessThanOrEqual(DIRECTORY_MIN)
  })

  test("with room to spare the directory is not shortened", () => {
    expect(fit(long, 100)[0]!.text).toBe("~/Development/kete-code")
  })

  test("once the directory is at its minimum, items drop from the end", () => {
    const kept = fit(long, 34)
    expect(kept.map((entry) => entry.id)).toEqual(["directory", "branch"])
  })
})

describe("the sandbox warning is never silently hidden", () => {
  test("a failed status call shows that the status is unknown", () => {
    expect(sandboxText({ kind: "unknown" })).toBe("Sandbox status unknown")
  })

  test("a sandboxed runtime shows nothing; an unsandboxed one warns", () => {
    const status = (state: KeteSandboxRpc.State): KeteSandboxRpc.Status => ({
      state,
      platform: "darwin",
      mode: "auto",
      network: "approved",
      ignored: [],
    })
    expect(sandboxText({ kind: "status", status: status("on") })).toBeUndefined()
    expect(sandboxText({ kind: "status", status: status("off") })).toBe("Unsandboxed (sandbox off)")
  })

  test("before the first answer there is nothing to show", () => {
    expect(sandboxText(undefined)).toBeUndefined()
  })
})

