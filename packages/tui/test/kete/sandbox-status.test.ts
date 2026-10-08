import { describe, expect, test } from "bun:test"
import { label } from "../../src/kete/sandbox-status"

const base = { platform: "linux", mode: "auto", network: "approved", ignored: [] } as const

describe("TUI sandbox indicator", () => {
  test("nothing while sandboxed, in a job, or unknown", () => {
    expect(label({ ...base, state: "on", mechanism: "bubblewrap" })).toBeUndefined()
    expect(label({ ...base, state: "job" })).toBeUndefined()
    expect(label(undefined)).toBeUndefined()
  })
  test("a warning when off or unavailable", () => {
    expect(label({ ...base, state: "off", mode: "off" })).toContain("Unsandboxed")
    expect(label({ ...base, state: "unavailable" })).toBe("Unsandboxed")
    expect(label({ ...base, state: "unavailable", mode: "required" })).toContain("refused")
  })
})
