import { describe, expect, test } from "bun:test"
import {
  compareVersions,
  countLeaks,
  isKeteOwned,
  isUnmarkable,
  leakIncreases,
  parseVersion,
  unmarkedAdditions,
} from "../src/lib"
import { compare, parseTestOutput, type PackageResult } from "../src/verify"

describe("versions", () => {
  test("parses plain release tags only", () => {
    expect(parseVersion("v2.0.16")).toEqual({ major: 2, minor: 0, patch: 16 })
    expect(parseVersion("2.0.16")).toBeUndefined()
    expect(parseVersion("v2.0.16-beta.1")).toBeUndefined()
    expect(parseVersion("vscode-v0.0.9")).toBeUndefined()
  })

  test("orders numerically, not lexically", () => {
    const [a, b] = [parseVersion("v2.0.9")!, parseVersion("v2.0.10")!]
    expect(compareVersions(a, b)).toBeLessThan(0)
    expect(compareVersions(b, a)).toBeGreaterThan(0)
    expect(compareVersions(a, a)).toBe(0)
  })
})

describe("ownership", () => {
  test("paths with kete in them are Kete-owned", () => {
    expect(isKeteOwned("packages/util/src/kete/brand.ts")).toBe(true)
    expect(isKeteOwned("packages/kete-tools/src/sync.ts")).toBe(true)
    expect(isKeteOwned("NOTICE")).toBe(true)
    expect(isKeteOwned("docs/upstream-patches.md")).toBe(true)
    expect(isKeteOwned("docs/local-models.md")).toBe(true)
    expect(isKeteOwned("docs/platform/cli-login-v1.md")).toBe(true)
    expect(isKeteOwned("packages/core/src/config.ts")).toBe(false)
    expect(isKeteOwned("README.md")).toBe(false)
  })

  test("the knowledge base and agent swarm are Kete-owned", () => {
    for (const file of [
      "docs/context/INDEX.md",
      "docs/context/modules/sync.md",
      "docs/tasks/metrics.md",
      "scripts/agent/card-check.mjs",
      ".claude/agents/scout.md",
      ".claude/skills/task-new/SKILL.md",
      ".claude/settings.json",
    ])
      expect(isKeteOwned(file)).toBe(true)
    // Only the swarm's parts of .claude/ and scripts/: anything else stays upstream's.
    expect(isKeteOwned(".claude/scheduled_tasks.lock")).toBe(false)
    expect(isKeteOwned("scripts/other.ts")).toBe(false)
    expect(isKeteOwned("docs/status/report.md")).toBe(false)
  })

  test("data files cannot carry markers", () => {
    expect(isUnmarkable("packages/cli/package.json")).toBe(true)
    expect(isKeteOwned("docs/release.md")).toBe(true)
    expect(isKeteOwned(".github/workflows/kete-release.yml")).toBe(true)
    expect(isUnmarkable("packages/core/src/plugin/system-prompt/gpt.txt")).toBe(true)
    expect(isUnmarkable("packages/core/src/app.ts")).toBe(false)
    expect(isUnmarkable("packages/client/src/promise/generated/types.ts")).toBe(true)
    expect(isUnmarkable("packages/core/src/generator.ts")).toBe(false)
  })
})

const diff = (...added: string[]) => ["@@ -1,0 +1,9 @@", ...added.map((line) => `+${line}`)].join("\n")

describe("marker audit", () => {
  test("accepts every documented marker form", () => {
    expect(
      unmarkedAdditions(
        "a.ts",
        diff(
          "const x = 1 // kete_change",
          "// kete_change start",
          "const y = 2",
          "const z = 3",
          "// kete_change end",
          "// kete_change: why the next line changed",
          "const w = 4",
          "{/* kete_change */}",
          "<text>{Brand.displayName}</text>",
          "",
        ),
      ),
    ).toEqual([])
  })

  test("reports unmarked additions", () => {
    expect(unmarkedAdditions("a.ts", diff("const x = 1", "const y = 2 // kete_change"))).toEqual([
      { file: "a.ts", line: "const x = 1" },
    ])
  })

  test("a marker-only line covers exactly one following line", () => {
    expect(unmarkedAdditions("a.ts", diff("// kete_change: one", "const a = 1", "const b = 2"))).toEqual([
      { file: "a.ts", line: "const b = 2" },
    ])
  })

  test("a marker line does not carry across hunks", () => {
    const text = ["@@ -1 +1 @@", "+// kete_change: one", "@@ -9 +9 @@", "+const later = 1"].join("\n")
    expect(unmarkedAdditions("a.ts", text)).toEqual([{ file: "a.ts", line: "const later = 1" }])
  })

  test("ignores removed and context lines", () => {
    expect(unmarkedAdditions("a.ts", ["@@ -1 +1 @@", "-const old = 1", " const same = 2"].join("\n"))).toEqual([])
  })
})

describe("brand leaks", () => {
  test("counts literals outside comments, tests, imports and marked lines", () => {
    const files = new Map([
      [
        "packages/core/src/a.ts",
        [
          'const dir = ".opencode"',
          'const file = "opencode.json"',
          'log("OpenCode started")',
          "// OpenCode in a comment",
          'import { OpenCode } from "@opencode/client"',
          "const client = OpenCode.make({})",
          'const kete = "OpenCode" // kete_change: kept on purpose',
        ].join("\n"),
      ],
      ["packages/core/test/a.test.ts", 'const dir = ".opencode"'],
      ["packages/core/src/kete/brand.ts", 'const old = "opencode.json"'],
    ])
    expect(countLeaks(files)).toEqual({
      "packages/core/src/a.ts": { "project-dir": 1, "config-file": 1, "display-name": 1 },
    })
  })

  test("reports only increases", () => {
    const before = { "a.ts": { "display-name": 2 }, "b.ts": { "config-file": 1 } }
    const after = { "a.ts": { "display-name": 3 }, "b.ts": { "config-file": 1 }, "c.ts": { "project-dir": 1 } }
    expect(leakIncreases(before, after)).toEqual([
      { file: "a.ts", id: "display-name", before: 2, after: 3 },
      { file: "c.ts", id: "project-dir", before: 0, after: 1 },
    ])
  })
})

describe("verify", () => {
  test("parses bun test output", () => {
    const output = [
      "(pass) works [1.00ms]",
      "(fail) Ripgrep > globs files [3.27ms]",
      "(fail) Ripgrep > globs files [3.27ms]",
      "(fail) shell > times out [5000.45ms]",
      " 58 pass",
      " 2 fail",
    ].join("\n")
    expect(parseTestOutput(output)).toEqual({
      pass: 58,
      fail: 2,
      failures: ["Ripgrep > globs files", "shell > times out"],
    })
  })

  test("only failures missing from the base are regressions", () => {
    const result = (failures: string[], typecheck = true): PackageResult => ({ name: "core", typecheck, failures })
    const [comparison] = compare([result(["known", "new"])], [result(["known"])])
    expect(comparison?.regressions).toEqual(["new"])
    expect(comparison?.typecheckRegression).toBe(false)
    expect(compare([result([], false)], [result([], false)])[0]?.typecheckRegression).toBe(false)
    expect(compare([result([], false)], [result([])])[0]?.typecheckRegression).toBe(true)
    expect(compare([result(["a"])])[0]?.regressions).toEqual(["a"])
  })
})
