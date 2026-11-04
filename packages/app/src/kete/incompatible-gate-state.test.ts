import { describe, expect, test } from "bun:test"
import { coveredServer } from "./incompatible-gate-state"

const health = { a: { incompatible: true }, b: { incompatible: false } }
const base = { route: { type: "home" }, selected: "a", visible: ["a", "b"], health }

describe("coveredServer", () => {
  test("covers an incompatible focused server on home", () => {
    expect(coveredServer(base)).toBe("a")
  })

  test("covers nothing when the focused server is compatible", () => {
    expect(coveredServer({ ...base, selected: "b" })).toBeUndefined()
  })

  test.each(["settings", "session", "draft"])("does not cover the %s route", (type) => {
    expect(coveredServer({ ...base, route: { type } })).toBeUndefined()
  })

  test("falls back to the first visible server when the selection is not visible", () => {
    expect(coveredServer({ ...base, selected: "hidden" })).toBe("a")
    expect(coveredServer({ ...base, selected: "hidden", visible: ["b", "a"] })).toBeUndefined()
  })

  test("covers nothing without servers", () => {
    expect(coveredServer({ ...base, visible: [] })).toBeUndefined()
  })
})
