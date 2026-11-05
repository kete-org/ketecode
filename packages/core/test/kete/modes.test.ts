import { describe, expect, test } from "bun:test"
// Importing the loader decodes both shipped profiles strictly; a bad one throws here.
import { KeteModes } from "../../src/kete/modes"

describe("mode profiles", () => {
  test("both shipped profiles load, in order", () => {
    expect(KeteModes.list().map((item) => item.id)).toEqual(["code", "work"])
    expect(KeteModes.get("work").available).toBe(false)
  })

  test("code is today's behaviour", () => {
    expect(KeteModes.get("code").agent).toBe("build")
  })

  test("work is locked down", () => {
    const work = KeteModes.get("work")
    expect(work.network).toBe("off")
    expect(work.git).toBe(false)
    expect(work.shell.windows).toBe("off")
  })

  test("summaries carry no enforcement fields", () => {
    for (const summary of KeteModes.summaries()) expect(Object.keys(summary)).not.toContain("shell")
  })

  test("only code is available", () => {
    expect(KeteModes.available()).toEqual(["code"])
  })
})
