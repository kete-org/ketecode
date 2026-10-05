import { describe, expect, test } from "bun:test"
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Outputs } from "../src/outputs"
import { Secrets } from "../src/secrets"

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
    const text = Outputs.format(
      {
        KETE_OUTCOME: "completed",
        KETE_SUMMARY: "done\nKETE_BRANCH=main\r\nkey sk-abcdefghijklmnopqrstu",
        KETE_BRANCH: "",
        KETE_JOB_URL: "",
      },
      Secrets.shapes,
    )
    const lines = text.trimEnd().split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe("KETE_SUMMARY=done KETE_BRANCH=main key [REDACTED]")
    expect(lines[2]).toBe("KETE_BRANCH=")
  })

  test("long values are cut", () => {
    const line = Outputs.oneLine("x".repeat(10_000), Secrets.shapes)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(Outputs.summaryMaxBytes)
    expect(line.endsWith("...")).toBe(true)
  })

  test("writes to DRONE_OUTPUT and HARNESS_OUTPUT, once per path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kete-harness-out-"))
    const a = path.join(dir, "drone.env")
    const b = path.join(dir, "harness.env")
    const values = { KETE_OUTCOME: "completed", KETE_SUMMARY: "ok", KETE_BRANCH: "kete/x", KETE_JOB_URL: "" }
    Outputs.write({ DRONE_OUTPUT: a, HARNESS_OUTPUT: b }, values, Secrets.shapes)
    Outputs.write({ DRONE_OUTPUT: a, HARNESS_OUTPUT: a }, values, Secrets.shapes)
    expect(readFileSync(b, "utf8")).toBe("KETE_OUTCOME=completed\nKETE_SUMMARY=ok\nKETE_BRANCH=kete/x\nKETE_JOB_URL=\n")
    expect(readFileSync(a, "utf8").split("\n").filter(Boolean)).toHaveLength(8)
    expect(Outputs.targets({})).toEqual([])
  })

  test("an artifact replaces a symlink planted in the output directory instead of writing through it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kete-harness-art-"))
    const target = path.join(mkdtempSync(path.join(tmpdir(), "kete-harness-victim-")), "victim.txt")
    writeFileSync(target, "original")
    symlinkSync(target, path.join(dir, "summary.md"))
    Outputs.writeArtifact(dir, "summary.md", "## summary")
    expect(readFileSync(target, "utf8")).toBe("original")
    expect(lstatSync(path.join(dir, "summary.md")).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(dir, "summary.md"), "utf8")).toBe("## summary")
    // A dangling symlink is replaced too.
    symlinkSync(path.join(dir, "nowhere"), path.join(dir, "result.json"))
    Outputs.writeArtifact(dir, "result.json", "{}")
    expect(readFileSync(path.join(dir, "result.json"), "utf8")).toBe("{}")
  })
})
