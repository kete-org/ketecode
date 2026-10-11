import { describe, expect, test } from "bun:test"
import { KeteNotices } from "../../src/kete/notices.js"

// The text the maintainer approved for the VS Code panel (D5). The panel passes `/agent`.
const APPROVED: KeteNotices.Notice[] = [
  {
    id: "portal-agents",
    title: "Agents from your portal",
    body: "Agents you set up in the Kete Code Portal sync here automatically. Pick one with `/agent`.",
    isNew: true,
  },
  {
    id: "agents-md",
    title: "Kete reads your AGENTS.md",
    body: "Project conventions in `AGENTS.md` load at the start of every session.",
  },
]

describe("KeteNotices.list", () => {
  test("with the panel's command, equals the approved panel text exactly", () => {
    expect(KeteNotices.list({ agentCommand: "/agent" })).toEqual(APPROVED)
  })

  test("the TUI and panel lists differ only in the agent command", () => {
    const panel = KeteNotices.list({ agentCommand: "/agent" })
    const tui = KeteNotices.list({ agentCommand: "/agents" })
    expect(tui.map((notice) => notice.id)).toEqual(panel.map((notice) => notice.id))
    tui.forEach((notice, i) => {
      const other = panel[i]!
      expect(notice.title).toBe(other.title)
      expect(notice.isNew).toBe(other.isNew)
      expect(notice.body.replaceAll("`/agents`", "`/agent`")).toBe(other.body)
    })
    expect(tui[0]!.body).toContain("`/agents`")
  })

  test("IDS lists every notice id in order", () => {
    expect(KeteNotices.list({ agentCommand: "/agent" }).map((notice) => notice.id)).toEqual([...KeteNotices.IDS])
  })
})

describe("KeteNotices.dismiss", () => {
  test("adds a known id, deduped", () => {
    expect(KeteNotices.dismiss([], "agents-md")).toEqual(["agents-md"])
    expect(KeteNotices.dismiss(["agents-md"], "agents-md")).toEqual(["agents-md"])
  })
  test("ignores an unknown id", () => {
    expect(KeteNotices.dismiss([], "not-a-real-notice")).toEqual([])
  })
  test("caps the list rather than growing it forever", () => {
    const long = Array.from({ length: 60 }, (_, i) => `x${i}`)
    const result = KeteNotices.dismiss(long, "portal-agents")
    expect(result.length).toBe(50)
    expect(result.at(-1)).toBe("portal-agents")
  })
  test("never mutates its input", () => {
    const input = ["agents-md"]
    KeteNotices.dismiss(input, "portal-agents")
    expect(input).toEqual(["agents-md"])
  })
})

describe("KeteNotices.segments", () => {
  test("splits backtick spans into code segments", () => {
    expect(KeteNotices.segments("Project conventions in `AGENTS.md` load.")).toEqual([
      { type: "text", value: "Project conventions in " },
      { type: "code", value: "AGENTS.md" },
      { type: "text", value: " load." },
    ])
  })
  test("a span at the end, and adjacent spans", () => {
    expect(KeteNotices.segments("with `/agents`.`a``b`")).toEqual([
      { type: "text", value: "with " },
      { type: "code", value: "/agents" },
      { type: "text", value: "." },
      { type: "code", value: "a" },
      { type: "code", value: "b" },
    ])
  })
  test("an unmatched backtick stays text", () => {
    expect(KeteNotices.segments("a `b")).toEqual([{ type: "text", value: "a `b" }])
  })
  test("plain text and empty input", () => {
    expect(KeteNotices.segments("plain")).toEqual([{ type: "text", value: "plain" }])
    expect(KeteNotices.segments("")).toEqual([])
  })
})
