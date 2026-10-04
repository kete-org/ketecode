import { describe, expect, test } from "bun:test"
import { ago, parseSessions, sessionFromLink, sessionLink } from "../src/sessions"

describe("session list", () => {
  test("keeps top-level, unarchived sessions, newest first", () => {
    const items = parseSessions({
      data: [
        { id: "ses_a", title: "Old", time: { created: 1, updated: 10 } },
        { id: "ses_b", title: "  New  ", time: { created: 2, updated: 30 } },
        { id: "ses_child", parentID: "ses_b", title: "Subagent", time: { updated: 40 } },
        { id: "ses_gone", title: "Archived", time: { updated: 50, archived: 51 } },
        { id: "ses_c", time: { created: 20 } },
        { id: "../evil", title: "Bad id", time: { updated: 60 } },
        "junk",
      ],
    })
    expect(items).toEqual([
      { id: "ses_b", title: "New", updated: 30 },
      { id: "ses_c", title: "Untitled session", updated: 20 },
      { id: "ses_a", title: "Old", updated: 10 },
    ])
  })

  test("tolerates a malformed response", () => {
    expect(parseSessions(undefined)).toEqual([])
    expect(parseSessions({ data: "nope" })).toEqual([])
  })

  test("relative times", () => {
    const now = Date.UTC(2026, 8, 26)
    expect(ago(now - 5_000, now)).toBe("just now")
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago")
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago")
    expect(ago(now - 2 * 86_400_000, now)).toBe("2 d ago")
    expect(ago(Date.UTC(2026, 0, 2), now)).toBe("2026-01-02")
  })
})

describe("session links", () => {
  test("round trip", () => {
    const link = new URL(sessionLink("vscode", "ketecode.kete-code", "ses_123"))
    expect(sessionFromLink(link.pathname, link.search.slice(1))).toBe("ses_123")
  })

  test("reject other paths and malformed ids", () => {
    expect(sessionFromLink("/other", "id=ses_1")).toBeUndefined()
    expect(sessionFromLink("/session", "")).toBeUndefined()
    expect(sessionFromLink("/session", "id=../../etc")).toBeUndefined()
    expect(sessionFromLink("/session", `id=${"a".repeat(200)}`)).toBeUndefined()
  })
})
