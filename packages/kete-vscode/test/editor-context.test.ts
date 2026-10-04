import { describe, expect, test } from "bun:test"
import { editorContext, glob, same } from "../src/editor-context"

const selection = (start: number, end: number, endCharacter = 5) => ({ start, end, endCharacter, empty: false })
const none = { start: 0, end: 0, endCharacter: 0, empty: true }

describe("editorContext", () => {
  test("the file, or the selected lines (1-based)", () => {
    expect(editorContext({ scheme: "file", relative: "src/app.ts", exclude: [], selection: none })).toEqual({ path: "src/app.ts" })
    expect(editorContext({ scheme: "file", relative: "src/app.ts", exclude: [], selection: selection(2, 4) })).toEqual({
      path: "src/app.ts",
      startLine: 3,
      endLine: 5,
    })
    // Ending at column 0 of the next line doesn't include it.
    expect(editorContext({ scheme: "file", relative: "a.ts", exclude: [], selection: selection(2, 5, 0) })?.endLine).toBe(5)
  })

  test("never outside the workspace, for other schemes, secrets, or files.exclude", () => {
    expect(editorContext({ scheme: "file", relative: undefined, exclude: [], selection: none })).toBeUndefined()
    expect(editorContext({ scheme: "untitled", relative: "Untitled-1", exclude: [], selection: none })).toBeUndefined()
    expect(editorContext({ scheme: "git", relative: "a.ts", exclude: [], selection: none })).toBeUndefined()
    for (const secret of [".env", "config/.env.local", "certs/server.pem", "deploy/id_rsa", ".npmrc", "keys/api.key"])
      expect(editorContext({ scheme: "file", relative: secret, exclude: [], selection: none }), secret).toBeUndefined()
    expect(editorContext({ scheme: "file", relative: "dist/out.js", exclude: ["**/dist"], selection: none })).toBeUndefined()
    expect(editorContext({ scheme: "file", relative: "src/env.ts", exclude: ["**/dist"], selection: none })).toEqual({ path: "src/env.ts" })
  })

  test("same", () => {
    expect(same({ path: "a", startLine: 1, endLine: 2 }, { path: "a", startLine: 1, endLine: 2 })).toBe(true)
    expect(same({ path: "a" }, { path: "a", startLine: 1, endLine: 1 })).toBe(false)
    expect(same(undefined, undefined)).toBe(true)
  })
})

describe("glob (files.exclude)", () => {
  test("VS Code patterns", () => {
    expect(glob("**/.git").test(".git")).toBe(true)
    expect(glob("**/.git").test("sub/.git/config")).toBe(true)
    expect(glob("**/node_modules").test("packages/app/node_modules/x/index.js")).toBe(true)
    expect(glob("**/*.log").test("logs/run.log")).toBe(true)
    expect(glob("**/*.log").test("run.log.txt")).toBe(false)
    expect(glob("build/*.{js,map}").test("build/app.map")).toBe(true)
    expect(glob("build/*.{js,map}").test("build/sub/app.js")).toBe(false)
    expect(glob("a?c").test("abc")).toBe(true)
  })
})
