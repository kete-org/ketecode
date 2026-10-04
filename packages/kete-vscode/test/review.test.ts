import { describe, expect, test } from "bun:test"
import { before, parse } from "../src/review"

// The runtime's format (the `diff` package's formatPatch), with the whole file as context.
const header = "Index: src/app.ts\n===================================================================\n--- src/app.ts\n+++ src/app.ts\n"

describe("before", () => {
  test("a modified file, from the patch alone", () => {
    const patch = `${header}@@ -1,3 +1,3 @@\n export const a = 1\n-export const b = 2\n+export const b = 20\n export const c = 3\n`
    const after = "export const a = 1\nexport const b = 20\nexport const c = 3\n"
    expect(before(patch, after)).toBe("export const a = 1\nexport const b = 2\nexport const c = 3\n")
    // The patch carries the whole file, so it works even if the disk copy is gone.
    expect(before(patch, undefined)).toBe("export const a = 1\nexport const b = 2\nexport const c = 3\n")
  })

  test("an added file was empty; a deleted file comes back whole", () => {
    expect(before(`${header}@@ -0,0 +1,2 @@\n+one\n+two\n`, "one\ntwo\n")).toBe("")
    expect(before(`${header}@@ -1,2 +0,0 @@\n-one\n-two\n`, undefined)).toBe("one\ntwo\n")
  })

  test("a missing final newline on either side", () => {
    const patch = `${header}@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+two\n`
    expect(before(patch, "one\ntwo\n")).toBe("one\ntwo")
  })

  test("CRLF files keep their carriage returns", () => {
    const patch = `${header}@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n`
    expect(before(patch, "a\r\nc\r\n")).toBe("a\r\nb\r\n")
  })

  test("a patch with only some context is reversed against the current file", () => {
    const current = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
    const changed = current.replace("line 5\n", "line five\n")
    const patch = `${header}@@ -4,3 +4,3 @@\n line 4\n-line 5\n+line five\n line 6\n`
    expect(before(patch, changed)).toBe(current)
  })

  test("refuses when the file changed since the turn", () => {
    const patch = `${header}@@ -4,3 +4,3 @@\n line 4\n-line 5\n+line five\n line 6\n`
    expect(() => before(patch, "something else entirely\n")).toThrow("the file changed since this turn")
    expect(() => before(patch, undefined)).toThrow("the file is gone")
  })

  test("parse reads hunks and ignores headers", () => {
    const hunks = parse(`diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d\n`)
    expect(hunks.map((hunk) => [hunk.oldStart, hunk.newStart, hunk.lines.length])).toEqual([
      [1, 1, 2],
      [9, 9, 2],
    ])
  })
})
