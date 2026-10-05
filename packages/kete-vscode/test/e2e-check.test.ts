import { describe, expect, test } from "bun:test"
import { failures, type Report } from "../script/e2e-check"

const passing: Report = {
  exit: 0,
  leftoverServers: 0,
  results: {
    account: { signedIn: true },
    serverBeforeChat: "stopped",
    url: "http://127.0.0.1:4000",
    noAuth: 401,
    rebindHost: 403,
    crossOrigin: 403,
    webUIConnected: true,
    eventStreamConnected: true,
    editorContextFollows: true,
    sentSelection: true,
    contextDelivered: true,
    newCommands: 6,
    themeApplied: { kind: "dark", tokens: 20 },
    session: null,
    reviewRan: true,
    sessionsListed: 1,
    sessionOpened: true,
    sessionStayedOpen: true,
    modeBefore: "default",
    modeAsk: true,
    modeDefault: true,
    editorTools: "connected",
    mcpView: { items: 1, waiting: 1 },
    waiting: 0,
    restartedURL: "http://127.0.0.1:4001",
    oldServerGone: "unreachable",
    webUIConnectedAfterRestart: true,
    ok: true,
  },
}

describe("e2e --assert", () => {
  test("a full run passes", () => {
    expect(failures(passing)).toEqual([])
  })

  test("a suite error, a crash or a leftover server fails", () => {
    expect(failures({ ...passing, results: { ...passing.results, ok: undefined, error: "boom" } })).toEqual([
      'the suite finishes without an error (got "boom")',
    ])
    expect(failures({ ...passing, exit: 1 })).toHaveLength(1)
    expect(failures({ ...passing, leftoverServers: 2 })).toEqual(["no server outlives the editor (got 2)"])
    expect(failures({ exit: null, leftoverServers: 0, results: {} }).length).toBeGreaterThan(10)
  })

  test("a server that answers without the password, a rebound Host or a foreign origin fails", () => {
    expect(failures({ ...passing, results: { ...passing.results, noAuth: 200 } })).toHaveLength(1)
    expect(failures({ ...passing, results: { ...passing.results, rebindHost: 200 } })).toHaveLength(1)
    expect(failures({ ...passing, results: { ...passing.results, crossOrigin: 200 } })).toHaveLength(1)
  })

  test("a restart that keeps the old server fails", () => {
    const results = { ...passing.results, restartedURL: passing.results.url, oldServerGone: 401 }
    expect(failures({ ...passing, results })).toHaveLength(2)
  })
})
