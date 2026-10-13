import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parse } from "jsonc-parser"
import { KeteTerminalSetup } from "@opencode/util/kete/terminal-setup"
import { KeteTerminalSetupFlow } from "../../src/kete/terminal-setup-flow"

const FILE = "/Users/a/Library/Application Support/Cursor/User/keybindings.json"

function deps(overrides: Partial<KeteTerminalSetupFlow.Deps> = {}, files: Record<string, string> = {}) {
  const calls = { writes: [] as Array<[string, string]>, copies: [] as Array<[string, string]>, confirms: 0, out: [] as string[], err: [] as string[] }
  const value: KeteTerminalSetupFlow.Deps = {
    env: { TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" },
    platform: "darwin",
    home: "/Users/a",
    join: path.posix.join,
    read: async (file) => files[file],
    write: async (file, text) => void calls.writes.push([file, text]),
    copy: async (from, to) => void calls.copies.push([from, to]),
    now: () => new Date("2026-10-13T10:00:00.000Z"),
    interactive: true,
    confirm: async () => {
      calls.confirms++
      return true
    },
    out: (text) => void calls.out.push(text),
    err: (text) => void calls.err.push(text),
    ...overrides,
  }
  return { value, calls }
}

describe("withKeybinding", () => {
  test("a missing or empty file becomes a list with the binding", () => {
    for (const text of [undefined, "", "  "]) {
      const result = KeteTerminalSetupFlow.withKeybinding(text)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") expect(parse(result.text)).toEqual([KeteTerminalSetup.KEYBINDING])
    }
  })
  test("comments and the person's own bindings are kept", () => {
    const text = '// my keys\n[\n  { "key": "ctrl+k", "command": "x" }, // mine\n]\n'
    const result = KeteTerminalSetupFlow.withKeybinding(text)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.text).toContain("// my keys")
    expect(result.text).toContain("// mine")
    expect(parse(result.text, [], { allowTrailingComma: true })).toEqual([{ key: "ctrl+k", command: "x" }, KeteTerminalSetup.KEYBINDING])
  })
  test("already there, not JSON, or not a list: no change", () => {
    expect(KeteTerminalSetupFlow.withKeybinding(JSON.stringify([KeteTerminalSetup.KEYBINDING])).kind).toBe("present")
    expect(KeteTerminalSetupFlow.withKeybinding("[ { oops ").kind).toBe("invalid")
    expect(KeteTerminalSetupFlow.withKeybinding('{ "key": "x" }').kind).toBe("invalid")
  })
})

describe("kete terminal-setup", () => {
  test("in Cursor it asks, keeps a backup, then writes the binding", async () => {
    const { value, calls } = deps({}, { [FILE]: "[]" })
    expect(await KeteTerminalSetupFlow.run(value, { yes: false, print: false })).toBe(0)
    expect(calls.confirms).toBe(1)
    expect(calls.copies).toEqual([[FILE, `${FILE}.kete-backup-2026-10-13T10-00-00-000Z`]])
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0]![0]).toBe(FILE)
    expect(parse(calls.writes[0]![1])).toEqual([KeteTerminalSetup.KEYBINDING])
  })
  test("a no changes nothing", async () => {
    const { value, calls } = deps({ confirm: async () => false })
    await KeteTerminalSetupFlow.run(value, { yes: false, print: false })
    expect(calls.writes).toEqual([])
  })
  test("not a terminal: nothing without --yes; --yes writes without asking (no backup for a new file)", async () => {
    const first = deps({ interactive: false })
    await KeteTerminalSetupFlow.run(first.value, { yes: false, print: false })
    expect(first.calls.writes).toEqual([])
    expect(first.calls.out.join("\n")).toContain("--yes")
    const second = deps({ interactive: false })
    await KeteTerminalSetupFlow.run(second.value, { yes: true, print: false })
    expect(second.calls.confirms).toBe(0)
    expect(second.calls.copies).toEqual([])
    expect(second.calls.writes).toHaveLength(1)
  })
  test("--print and native terminals change nothing", async () => {
    const printed = deps()
    await KeteTerminalSetupFlow.run(printed.value, { yes: true, print: true })
    expect(printed.calls.writes).toEqual([])
    const native = deps({ env: { TERM_PROGRAM: "ghostty" } })
    await KeteTerminalSetupFlow.run(native.value, { yes: true, print: false })
    expect(native.calls.writes).toEqual([])
    expect(native.calls.out[0]).toContain("already inserts a newline")
  })
  test("--editor picks the editor when the environment can't tell", async () => {
    const { value, calls } = deps({ env: {} })
    await KeteTerminalSetupFlow.run(value, { editor: "vscodium", yes: true, print: false })
    expect(calls.writes[0]![0]).toBe("/Users/a/Library/Application Support/VSCodium/User/keybindings.json")
  })
  test("an invalid keybindings.json is left alone, and says so (exit 1)", async () => {
    const { value, calls } = deps({}, { [FILE]: "[ { broken" })
    expect(await KeteTerminalSetupFlow.run(value, { yes: true, print: false })).toBe(1)
    expect(calls.writes).toEqual([])
    expect(calls.err.join("\n")).toContain("wasn't changed")
  })
  test("already set up: nothing changes", async () => {
    const { value, calls } = deps({}, { [FILE]: JSON.stringify([KeteTerminalSetup.KEYBINDING]) })
    await KeteTerminalSetupFlow.run(value, { yes: false, print: false })
    expect(calls.confirms).toBe(0)
    expect(calls.writes).toEqual([])
    expect(calls.out.join("\n")).toContain("already has the keybinding")
  })
})
