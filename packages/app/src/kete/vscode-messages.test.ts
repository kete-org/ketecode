import { describe, expect, test } from "bun:test"
import {
  contextMessage,
  editorContextMessage,
  isNewSessionMessage,
  openSessionMessage,
  panelMessage,
  workspaceMessage,
} from "./vscode-messages"

describe("contextMessage", () => {
  test("a file, with or without lines", () => {
    expect(contextMessage({ type: "kete.addContext", path: "src/app.ts" })).toEqual({
      path: "src/app.ts",
      startLine: undefined,
      endLine: undefined,
    })
    expect(contextMessage({ type: "kete.addContext", path: "src/app.ts", startLine: 3, endLine: 7 })).toEqual({
      path: "src/app.ts",
      startLine: 3,
      endLine: 7,
    })
    // A reversed or missing end becomes a valid range.
    expect(contextMessage({ type: "kete.addContext", path: "a", startLine: 5, endLine: 2 })?.endLine).toBe(5)
    expect(contextMessage({ type: "kete.addContext", path: "a", startLine: 5 })?.endLine).toBe(5)
  })

  test("ignores anything else", () => {
    for (const data of [
      null,
      "kete.addContext",
      { type: "other", path: "a" },
      { type: "kete.addContext" },
      { type: "kete.addContext", path: "" },
      { type: "kete.addContext", path: 1 },
    ])
      expect(contextMessage(data)).toBeUndefined()
    expect(contextMessage({ type: "kete.addContext", path: "a", startLine: 0 })?.startLine).toBeUndefined()
    expect(contextMessage({ type: "kete.addContext", path: "a", startLine: 1.5 })?.startLine).toBeUndefined()
  })
})

describe("workspaceMessage", () => {
  test("the workspace folder", () => {
    expect(workspaceMessage({ type: "kete.workspace", directory: "/work/project" })).toBe("/work/project")
    for (const data of [null, { type: "kete.workspace" }, { type: "kete.workspace", directory: "" }, { type: "x", directory: "/a" }])
      expect(workspaceMessage(data)).toBeUndefined()
  })
})

describe("editorContextMessage", () => {
  test("the editor's file and selection, or null for nothing", () => {
    expect(editorContextMessage({ type: "kete.editorContext", context: { path: "src/a.ts", startLine: 3, endLine: 5 } })).toEqual({
      path: "src/a.ts",
      startLine: 3,
      endLine: 5,
    })
    expect(editorContextMessage({ type: "kete.editorContext", context: { path: "src/a.ts" } })).toEqual({
      path: "src/a.ts",
      startLine: undefined,
      endLine: undefined,
    })
    expect(editorContextMessage({ type: "kete.editorContext", context: null })).toBeNull()
    expect(editorContextMessage({ type: "kete.editorContext", context: { path: "" } })).toBeNull()
    expect(editorContextMessage({ type: "kete.addContext", path: "a" })).toBeUndefined()
    expect(isNewSessionMessage({ type: "kete.newSession" })).toBe(true)
    expect(isNewSessionMessage({ type: "kete.workspace" })).toBe(false)
  })
})

describe("openSessionMessage", () => {
  test("accepts a session id and rejects anything else", () => {
    expect(openSessionMessage({ type: "kete.openSession", sessionID: "ses_123" })).toBe("ses_123")
    expect(openSessionMessage({ type: "kete.openSession", sessionID: "../x" })).toBeUndefined()
    expect(openSessionMessage({ type: "kete.openSession", sessionID: 1 })).toBeUndefined()
    expect(openSessionMessage({ type: "kete.newSession", sessionID: "ses_1" })).toBeUndefined()
  })
})

describe("panelMessage", () => {
  const valid = {
    type: "kete.panel",
    platform: "mac",
    defaultMode: "ask",
    cliHint: true,
    notices: [{ id: "agents-md", title: "Kete reads your AGENTS.md", body: "Loads at session start." }],
  }

  test("accepts a well-formed message", () => {
    expect(panelMessage(valid)).toEqual({
      platform: "mac",
      defaultMode: "ask",
      cliHint: true,
      notices: [{ id: "agents-md", title: "Kete reads your AGENTS.md", body: "Loads at session start.", isNew: undefined }],
    })
  })

  test("an empty notice list and isNew are both fine", () => {
    expect(panelMessage({ ...valid, notices: [] })?.notices).toEqual([])
    expect(
      panelMessage({ ...valid, notices: [{ id: "a", title: "t", body: "b", isNew: true }] })?.notices[0]?.isNew,
    ).toBe(true)
  })

  test("extra fields on the message and on a notice are ignored, not rejected", () => {
    expect(panelMessage({ ...valid, extra: "x" })).not.toBeUndefined()
    expect(panelMessage({ ...valid, notices: [{ id: "a", title: "t", body: "b", extra: 1 }] })).not.toBeUndefined()
  })

  test("rejects a bad platform, default mode or cliHint", () => {
    expect(panelMessage({ ...valid, platform: "windows" })).toBeUndefined()
    expect(panelMessage({ ...valid, defaultMode: "allow" })).toBeUndefined()
    expect(panelMessage({ ...valid, cliHint: "yes" })).toBeUndefined()
  })

  test("rejects more than 10 notices", () => {
    const notices = Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, title: "t", body: "b" }))
    expect(panelMessage({ ...valid, notices })).toBeUndefined()
  })

  test("rejects a bad notice id, oversize title/body, or a malformed notice, dropping the whole message", () => {
    expect(panelMessage({ ...valid, notices: [{ id: "Not Valid!", title: "t", body: "b" }] })).toBeUndefined()
    expect(panelMessage({ ...valid, notices: [{ id: "a", title: "t".repeat(121), body: "b" }] })).toBeUndefined()
    expect(panelMessage({ ...valid, notices: [{ id: "a", title: "t", body: "b".repeat(601) }] })).toBeUndefined()
    expect(panelMessage({ ...valid, notices: [{ id: "a", title: "t" }] })).toBeUndefined()
    expect(panelMessage({ ...valid, notices: ["not-an-object"] })).toBeUndefined()
  })

  test("ignores anything that isn't kete.panel", () => {
    expect(panelMessage(null)).toBeUndefined()
    expect(panelMessage({ type: "kete.theme" })).toBeUndefined()
    expect(panelMessage({ ...valid, notices: undefined })).toBeUndefined()
  })
})
