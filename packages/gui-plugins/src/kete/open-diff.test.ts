import { describe, expect, test } from "bun:test"
import { OPEN_DIFF_EVENT, openDiffPath } from "./contract"

describe("openDiffPath", () => {
  test("returns the path an open-diff event carries", () => {
    expect(openDiffPath(new CustomEvent(OPEN_DIFF_EVENT, { detail: "src/a.ts" }))).toBe("src/a.ts")
  })

  test("ignores events without a string path", () => {
    expect(openDiffPath(new CustomEvent(OPEN_DIFF_EVENT, { detail: { path: "src/a.ts" } }))).toBeUndefined()
    expect(openDiffPath(new Event(OPEN_DIFF_EVENT))).toBeUndefined()
  })
})
