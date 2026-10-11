import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Info, resolve } from "../../src/config"
import { Definitions } from "../../src/config/keybind"
import { excerpt, find, keteHistorySearchKeys, RENAME_DEFAULT, SEARCH_DEFAULT } from "../../src/kete/history-search"
import type { PromptInfo } from "../../src/prompt/history"
import { stringWidth } from "../../src/util/string-width"

const entry = (text: string, mode?: "normal" | "shell"): PromptInfo => ({
  text,
  files: [],
  agents: [],
  skills: [],
  pasted: [],
  ...(mode ? { mode } : {}),
})

// Oldest first, as the history provider stores them.
const entries = ["fix tests", "build", "Fix lint", "fix tests", "deploy"].map((text) => entry(text))

describe("find", () => {
  test("returns the newest match first, ignoring case", () => {
    expect(find(entries, "FIX")).toMatchObject({ index: 3, entry: { text: "fix tests" }, start: 0, end: 3 })
    expect(find(entries, "lint")).toMatchObject({ index: 2, start: 4, end: 8 })
  })

  test("walks older from `before` and skips texts already shown", () => {
    const first = find(entries, "fix")!
    const shown = new Set([first.entry.text])
    const second = find(entries, "fix", first.index, shown)!
    expect(second.entry.text).toBe("Fix lint")
    shown.add(second.entry.text)
    // index 0 has the same text as the first match, so it is skipped: no older match.
    expect(find(entries, "fix", second.index, shown)).toBeUndefined()
  })

  test("an empty query and a query without a match find nothing", () => {
    expect(find(entries, "")).toBeUndefined()
    expect(find(entries, "nothing like it")).toBeUndefined()
    expect(find([], "fix")).toBeUndefined()
  })
})

describe("excerpt", () => {
  test("keeps short text whole and shows newlines as ⏎", () => {
    expect(excerpt("run\nthe tests", 4, 7, 40)).toEqual({ before: "run⏎", match: "the", after: " tests" })
  })

  test("fits a long entry into the width around the match", () => {
    const text = "a".repeat(60) + "needle" + "b".repeat(60)
    const result = excerpt(text, 60, 66, 30)
    expect(result.match).toBe("needle")
    expect(result.before.startsWith("…")).toBe(true)
    expect(result.after.endsWith("…")).toBe(true)
    expect(stringWidth(result.before + result.match + result.after)).toBeLessThanOrEqual(30)
  })

  test("cuts a match wider than the line", () => {
    const result = excerpt("x".repeat(50), 0, 50, 10)
    expect(stringWidth(result.match)).toBeLessThanOrEqual(10)
    expect(result.match.endsWith("…")).toBe(true)
  })
})

const decodeInfo = Schema.decodeUnknownSync(Info)
const keyOf = (config: ReturnType<typeof resolve>, command: string) =>
  config.keybinds.get(command).map((binding) => binding.key)

describe("keys", () => {
  test("defaults: rename moves off Ctrl+R, history search takes it, redo keeps <leader>r", () => {
    expect(Definitions["session.rename"].default).toBe(RENAME_DEFAULT)
    expect(RENAME_DEFAULT).toBe("<leader>shift+r")
    expect(Definitions["prompt.history.search"].default).toBe("ctrl+r")
    expect(Definitions["session.redo"].default).toBe("<leader>r")
    const config = resolve(decodeInfo({}), { terminalSuspend: true })
    expect(keyOf(config, "prompt.history.search")).toEqual(["ctrl+r"])
    expect(keyOf(config, "session.rename")).toEqual([RENAME_DEFAULT])
  })

  test("a user's ctrl+r rename takes the key from history search", () => {
    const config = resolve(decodeInfo({ keybinds: { "session.rename": "ctrl+r" } }), { terminalSuspend: true })
    expect(keyOf(config, "session.rename")).toEqual(["ctrl+r"])
    expect(keyOf(config, "prompt.history.search")).toEqual([])
    // Any spelling of the same key counts: a list, an object, a key-stroke, upper case.
    for (const rename of ["f2,Ctrl+R", ["f2", "ctrl+r"], { key: "ctrl+r" }, { name: "r", ctrl: true }])
      expect(keteHistorySearchKeys({ "session.rename": rename })).toEqual({ "prompt.history.search": "none" })
  })

  test("both set explicitly: both are kept as written", () => {
    const config = resolve(
      decodeInfo({ keybinds: { "session.rename": "ctrl+r", "prompt.history.search": "ctrl+r" } }),
      { terminalSuspend: true },
    )
    expect(keyOf(config, "session.rename")).toEqual(["ctrl+r"])
    expect(keyOf(config, "prompt.history.search")).toEqual(["ctrl+r"])
  })

  test("rename set to another key: history search keeps ctrl+r", () => {
    const config = resolve(decodeInfo({ keybinds: { "session.rename": "f2" } }), { terminalSuspend: true })
    expect(keyOf(config, "session.rename")).toEqual(["f2"])
    expect(keyOf(config, "prompt.history.search")).toEqual([SEARCH_DEFAULT])
    expect(keteHistorySearchKeys({})).toEqual({})
    expect(keteHistorySearchKeys({ "session.rename": "none" })).toEqual({})
  })
})
