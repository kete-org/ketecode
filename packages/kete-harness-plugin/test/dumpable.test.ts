import { describe, expect, test } from "bun:test"
import { Dumpable } from "../src/dumpable"

describe("non-dumpable step", () => {
  test("other platforms are a no-op", () => {
    expect(Dumpable.disable("darwin")).toEqual({ kind: "unsupported" })
    expect(Dumpable.disable("win32")).toEqual({ kind: "unsupported" })
  })

  test.skipIf(process.platform !== "linux")("on Linux the process ends up non-dumpable", () => {
    expect(Dumpable.disable()).toEqual({ kind: "ok" })
    expect(Dumpable.dumpable()).toBe(false)
  })
})
