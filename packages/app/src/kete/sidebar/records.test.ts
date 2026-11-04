import { describe, expect, test } from "bun:test"
import { accountLabel, projectGroups, recentSessions, relativeTime } from "./records"

const record = (id: string, worktree: string, updated: number) => ({
  session: { id, time: { created: updated, updated } },
  project: { worktree },
})

// Local-time dates, so the cases hold in any time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const now = at(10, 15, 30)

describe("recentSessions", () => {
  const records = [record("a", "/p", 3), record("b", "/p", 2), record("c", "/q", 1)]
  test("keeps the order and the first `limit` records", () => {
    expect(recentSessions(records, 2).items.map((r) => r.session.id)).toEqual(["a", "b"])
  })
  test("flags that more exist only past the limit", () => {
    expect(recentSessions(records, 2).more).toBe(true)
    expect(recentSessions(records, 3).more).toBe(false)
    expect(recentSessions([], 8)).toEqual({ items: [], more: false })
  })
})

describe("projectGroups", () => {
  const records = [
    record("a", "/p", 5),
    record("b", "/q", 4),
    record("c", "/p", 3),
    record("d", "/p", 2),
    record("e", "/p", 1),
  ]
  const groups = projectGroups(records, [{ worktree: "/p" }, { worktree: "/q", name: "Quux" }, { worktree: "/empty" }], 3)
  test("counts every session of a project but lists only perProject", () => {
    expect(groups[0]?.count).toBe(4)
    expect(groups[0]?.sessions.map((r) => r.session.id)).toEqual(["a", "c", "d"])
  })
  test("names a project by its name, else its folder", () => {
    expect(groups.map((g) => g.name)).toEqual(["p", "Quux", "empty"])
  })
  test("keeps a project with no sessions", () => {
    expect(groups[2]).toMatchObject({ count: 0, sessions: [] })
  })
})

describe("relativeTime", () => {
  test("under a minute is Just now", () => {
    expect(relativeTime(now - 30_000, now)).toBe("Just now")
  })
  test("under an hour counts minutes", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago")
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59 min ago")
  })
  test("earlier today shows the clock time", () => {
    expect(relativeTime(at(10, 9, 5), now)).toBe("09:05")
  })
  test("yesterday, then a short date", () => {
    expect(relativeTime(at(9, 23, 59), now)).toBe("Yesterday")
    expect(relativeTime(at(8, 12), now)).toBe("Nov 8")
  })
})

describe("accountLabel", () => {
  const base = { signedIn: false, offline: false, signingIn: false }
  test("unknown status shows nothing", () => {
    expect(accountLabel(undefined)).toBeUndefined()
  })
  test("signed out and offline", () => {
    expect(accountLabel(base)).toEqual({ kind: "signed-out" })
    expect(accountLabel({ ...base, offline: true })).toEqual({ kind: "offline" })
  })
  test("signed in exposes only the organization and host", () => {
    const label = accountLabel({ ...base, signedIn: true, organization: "Acme", platform: "kete.example" })
    expect(label).toEqual({ kind: "signed-in", organization: "Acme", host: "kete.example" })
  })
})
