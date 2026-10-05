import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Secrets } from "../src/secrets"
import { Settings } from "../src/settings"
import { Task } from "../src/task"

/** kete's rule matcher (packages/core/src/util/wildcard.ts), copied: this package doesn't depend on core. */
function wildcard(input: string, pattern: string) {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(input.replaceAll("\\", "/"))
}
const allowed = (rules: readonly Settings.AllowRule[], command: string) =>
  rules.some((r) => r.action === "shell" && wildcard(command, r.resource))

const redact = Secrets.shapes

const base = {
  PLUGIN_BUDGET: "1",
  PLUGIN_TIMEOUT: "10",
  PLUGIN_OPENAI_API_KEY: "sk-test0123456789abcdef",
}

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "kete-harness-ws-"))
}

describe("task", () => {
  test("a plain task is the prompt; PLUGIN_ALLOW rules pass through", () => {
    const s = Settings.parse({ ...base, PLUGIN_TASK: "Upgrade lodash", PLUGIN_ALLOW: "shell:bun test*" })
    expect(Task.build(s, { workspace: workspace(), targetBranch: undefined, redact })).toEqual({
      prompt: "Upgrade lodash",
      allow: [{ action: "shell", resource: "bun test*" }],
    })
  })

  test("fix-build puts the redacted end of the log in the prompt and allows edits", () => {
    const ws = workspace()
    writeFileSync(
      path.join(ws, "build.log"),
      "line 1\nerror: TS2304 Cannot find name 'foo'\nAPI_KEY=supersecretvalue\n",
    )
    const s = Settings.parse({
      ...base,
      PLUGIN_PRESET: "fix-build",
      PLUGIN_LOG: "build.log",
      PLUGIN_TASK: "Only touch src/",
    })
    const built = Task.build(s, { workspace: ws, targetBranch: undefined, redact })
    expect(built.prompt).toContain("Cannot find name 'foo'")
    expect(built.prompt).toContain("API_KEY=[REDACTED]")
    expect(built.prompt).not.toContain("supersecretvalue")
    expect(built.prompt).toContain("Additional instructions:\nOnly touch src/")
    expect(built.allow).toEqual([{ action: "edit", resource: "*" }])
  })

  test("a long log is cut to its end", () => {
    const ws = workspace()
    writeFileSync(path.join(ws, "big.log"), "START\n" + "x".repeat(Task.logTailBytes) + "\nTHE END\n")
    const tail = Task.readLogTail(ws, "big.log", redact)
    expect(tail.truncated).toBe(true)
    expect(tail.text).toContain("THE END")
    expect(tail.text).not.toContain("START")
  })

  test("the log must stay inside the workspace, symlinks included", () => {
    const ws = workspace()
    const outside = workspace()
    writeFileSync(path.join(outside, "secret.txt"), "nope")
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.log"))
    mkdirSync(path.join(ws, "dir"))
    expect(() => Task.readLogTail(ws, "link.log", redact)).toThrow("inside the workspace")
    expect(() => Task.readLogTail(ws, "missing.log", redact)).toThrow("doesn't exist")
    expect(() => Task.readLogTail(ws, "dir", redact)).toThrow("regular file")
  })

  test("review compares with the target branch and is read-only", () => {
    const s = Settings.parse({ ...base, PLUGIN_PRESET: "review" })
    const built = Task.build(s, { workspace: workspace(), targetBranch: "main", redact })
    expect(built.prompt).toContain("git diff origin/main...HEAD")
    expect(built.allow.every((r) => r.action === "shell" && r.resource.startsWith("git "))).toBe(true)
  })

  test("release-notes uses PLUGIN_BASE and de-duplicates rules", () => {
    const s = Settings.parse({
      ...base,
      PLUGIN_PRESET: "release-notes",
      PLUGIN_BASE: "v1.2.0",
      PLUGIN_ALLOW: "shell:git log v1.2.0..HEAD",
    })
    const built = Task.build(s, { workspace: workspace(), targetBranch: undefined, redact })
    expect(built.prompt).toContain("since v1.2.0")
    expect(built.allow.filter((r) => r.resource === "git log v1.2.0..HEAD")).toHaveLength(1)
  })

  test("preset rules are exact commands: no writes, deletes or look-alike commands", () => {
    const review = Task.build(Settings.parse({ ...base, PLUGIN_PRESET: "review" }), {
      workspace: workspace(),
      targetBranch: "main",
      redact,
    })
    expect(allowed(review.allow, "git diff origin/main...HEAD")).toBe(true)
    expect(allowed(review.allow, "git log --oneline origin/main..HEAD")).toBe(true)
    expect(review.prompt).toContain("- `git diff origin/main...HEAD`")
    for (const command of [
      "git diff --output=f",
      "git diff origin/main...HEAD --output=f",
      "git diff origin/main...HEAD > f",
      "git difftool",
      "git logfoo",
      "git log --output=f",
      "git show --output=f HEAD",
    ])
      expect({ command, allowed: allowed(review.allow, command) }).toEqual({ command, allowed: false })

    for (const latestTag of ["v1.0.0", undefined]) {
      const notes = Task.build(Settings.parse({ ...base, PLUGIN_PRESET: "release-notes" }), {
        workspace: workspace(),
        targetBranch: undefined,
        latestTag,
        redact,
      })
      for (const command of [
        "git tag -d x",
        "git tag v9 HEAD",
        "git logfoo",
        "git log --output=f",
        "git describe --dirty=x",
      ])
        expect({ command, allowed: allowed(notes.allow, command) }).toEqual({ command, allowed: false })
      if (latestTag) expect(allowed(notes.allow, "git log --oneline v1.0.0..HEAD")).toBe(true)
      else expect(allowed(notes.allow, "git tag --list")).toBe(true)
    }
  })

  test("a target branch or tag that isn't a plain ref name is never put in a rule", () => {
    const built = Task.build(Settings.parse({ ...base, PLUGIN_PRESET: "review" }), {
      workspace: workspace(),
      targetBranch: "main*",
      redact,
    })
    expect(built.allow.some((r) => r.resource.includes("*"))).toBe(false)
    expect(built.prompt).not.toContain("main*")
  })
})
