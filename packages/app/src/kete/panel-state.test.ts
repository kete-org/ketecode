import { describe, expect, test } from "bun:test"
import { segments, tipKeys } from "./panel-state"

describe("tipKeys", () => {
  test("mac shows the option glyph", () => {
    expect(tipKeys("mac")).toEqual(["⌥", "K"])
  })
  test("other platforms spell out Alt", () => {
    expect(tipKeys("other")).toEqual(["Alt", "K"])
  })
})

describe("segments", () => {
  test("splits balanced backticks into text/code", () => {
    expect(segments("Kete reads your `AGENTS.md`")).toEqual([
      { type: "text", value: "Kete reads your " },
      { type: "code", value: "AGENTS.md" },
    ])
  })
  test("multiple code spans", () => {
    expect(segments("`a` and `b`")).toEqual([
      { type: "code", value: "a" },
      { type: "text", value: " and " },
      { type: "code", value: "b" },
    ])
  })
  test("an unterminated backtick renders as plain text, not a guessed code span", () => {
    expect(segments("a `stray backtick")).toEqual([{ type: "text", value: "a `stray backtick" }])
  })
  test("HTML-looking input is only ever a text segment, never markup", () => {
    const text = "<img src=x onerror=alert(1)>"
    expect(segments(text)).toEqual([{ type: "text", value: text }])
  })
  test("empty string yields no segments", () => {
    expect(segments("")).toEqual([])
  })
})
