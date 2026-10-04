import { describe, expect, test } from "bun:test"
import { fileReference } from "../src/reference"

const selection = (startLine: number, endLine: number, endCharacter: number) => ({
  isEmpty: startLine === endLine && endCharacter === 0,
  start: { line: startLine },
  end: { line: endLine, character: endCharacter },
})

describe("fileReference", () => {
  test("references the file when nothing is selected", () => {
    expect(fileReference("src/app.ts")).toBe("@src/app.ts")
    expect(fileReference("src/app.ts", selection(4, 4, 0))).toBe("@src/app.ts")
  })

  test("references one line with one-based numbering", () => {
    expect(fileReference("src/app.ts", selection(0, 0, 5))).toBe("@src/app.ts#L1")
  })

  test("references a line range", () => {
    expect(fileReference("src/app.ts", selection(2, 6, 3))).toBe("@src/app.ts#L3-7")
  })

  test("excludes the following line when whole lines are selected", () => {
    expect(fileReference("src/app.ts", selection(2, 3, 0))).toBe("@src/app.ts#L3")
    expect(fileReference("src/app.ts", selection(2, 7, 0))).toBe("@src/app.ts#L3-7")
  })
})
