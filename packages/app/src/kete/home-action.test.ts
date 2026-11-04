import { describe, expect, test } from "bun:test"
import { homeAction } from "./home-action"

const draft = (id: string, server = "srv") => ({ type: "draft", server, id })
const session = (server = "srv") => ({ type: "session", server })
const base = { ready: true, server: "srv", directory: "/p" }

describe("homeAction", () => {
  test("?view=sessions shows upstream's Home even with a project", () => {
    expect(homeAction({ ...base, view: "sessions", tabs: [] })).toEqual({ kind: "home" })
  })
  test("no server or no project shows Home, which can add one", () => {
    expect(homeAction({ ready: true, tabs: [] })).toEqual({ kind: "home" })
    expect(homeAction({ ready: true, server: "srv", tabs: [] })).toEqual({ kind: "home" })
  })
  test("waits while tabs load", () => {
    expect(homeAction({ ...base, ready: false, tabs: [] })).toEqual({ kind: "wait" })
  })
  test("reuses the newest draft of the server", () => {
    const tabs = [draft("a"), session(), draft("b"), draft("c", "other")]
    expect(homeAction({ ...base, tabs })).toEqual({ kind: "reuse", tab: tabs[2] })
  })
  test("opens a new draft when the server has none", () => {
    expect(homeAction({ ...base, tabs: [session(), draft("x", "other")] })).toEqual({
      kind: "new",
      server: "srv",
      directory: "/p",
    })
  })
})
