import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Outputs } from "../src/outputs"

describe("outputs", () => {
  test("exit codes: 0 success, 2 refused or budget, 1 everything else", () => {
    expect(Outputs.exitCode("completed")).toBe(0)
    expect(Outputs.exitCode("succeeded")).toBe(0)
    for (const o of ["refused", "audit_failed", "budget", "insufficient_balance", "not_permitted"])
      expect(Outputs.exitCode(o)).toBe(2)
    for (const o of ["error", "time_limit", "interrupted", "cancelled", "timed_out", "something_new"])
      expect(Outputs.exitCode(o)).toBe(1)
  })

  test("values are single redacted lines, so a summary can't inject a variable", () => {
    const text = Outputs.format({
      KETE_OUTCOME: "completed",
      KETE_SUMMARY: "done\nKETE_BRANCH=main\r\nkey sk-abcdefghijklmnopqrstu",
      KETE_BRANCH: "",
      KETE_JOB_URL: "",
    })
    const lines = text.trimEnd().split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe("KETE_SUMMARY=done KETE_BRANCH=main key [REDACTED]")
    expect(lines[2]).toBe("KETE_BRANCH=")
  })

  test("long values are cut", () => {
    const line = Outputs.oneLine("x".repeat(10_000))
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(Outputs.summaryMaxBytes)
    expect(line.endsWith("...")).toBe(true)
  })

  test("writes to DRONE_OUTPUT and HARNESS_OUTPUT, once per path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kete-harness-out-"))
    const a = path.join(dir, "drone.env")
    const b = path.join(dir, "harness.env")
    const values = { KETE_OUTCOME: "completed", KETE_SUMMARY: "ok", KETE_BRANCH: "kete/x", KETE_JOB_URL: "" }
    Outputs.write({ DRONE_OUTPUT: a, HARNESS_OUTPUT: b }, values)
    Outputs.write({ DRONE_OUTPUT: a, HARNESS_OUTPUT: a }, values)
    expect(readFileSync(b, "utf8")).toBe("KETE_OUTCOME=completed\nKETE_SUMMARY=ok\nKETE_BRANCH=kete/x\nKETE_JOB_URL=\n")
    expect(readFileSync(a, "utf8").split("\n").filter(Boolean)).toHaveLength(8)
    expect(Outputs.targets({})).toEqual([])
  })
})
