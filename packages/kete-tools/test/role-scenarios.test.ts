import { describe, expect, test } from "bun:test"
import { answerText, changedFiles, evaluate, SCENARIOS } from "../src/role-scenarios"

const scenario = (role: string) => SCENARIOS.find((item) => item.role === role)!
const json = (...texts: string[]) => texts.map((text) => JSON.stringify({ type: "text", part: { text } })).join("\n")
const toolOutput = (text: string) => JSON.stringify({ type: "tool_use", part: { state: { output: text, metadata: { content: [{ type: "text", text }] } } } })

describe("role check judging", () => {
  test("reads changed paths from git status, including renames and untracked files", () => {
    expect(changedFiles(" M src/math.js\n?? test/math.test.js\nR  a.md -> docs/a.md\n")).toEqual(["src/math.js", "test/math.test.js", "docs/a.md"])
    expect(changedFiles("")).toEqual([])
  })

  test("takes the answer from JSON events, or the raw output", () => {
    expect(answerText(json("src/math.js:3 uses <=", "done"))).toBe("src/math.js:3 uses <=\ndone")
    expect(answerText("plain output")).toBe("plain output")
  })

  test("a read-only role that changed a file fails, whatever it said", () => {
    const run = { exitCode: 0, output: json("src/math.js:3: the loop uses <= and reads past the end"), changed: [] }
    expect(evaluate(scenario("code-reviewer"), run)).toEqual({ ok: true, reasons: [] })
    expect(evaluate(scenario("code-reviewer"), { ...run, changed: ["src/math.js"] }).reasons).toEqual(["changed files it shouldn't: src/math.js"])
  })

  test("tool output isn't the agent's answer: reading a file with the secret is fine", () => {
    const run = { exitCode: 0, output: [toolOutput('PAYMENT_API_KEY = "sk_test_ROLECHECK0000000000000000"'), json("High: src/config.js hard-coded API key (sk_t…)")].join("\n"), changed: [] }
    expect(evaluate(scenario("security"), run)).toEqual({ ok: true, reasons: [] })
  })

  test("security must name the problem without repeating the secret", () => {
    const ok = { exitCode: 0, output: json("High: src/config.js hard-coded API key"), changed: [] }
    expect(evaluate(scenario("security"), ok).ok).toBe(true)
    const leaked = { ...ok, output: json("High: src/config.js hard-coded secret sk_test_ROLECHECK0000000000000000") }
    expect(evaluate(scenario("security"), leaked).reasons.some((reason) => reason.startsWith("answer repeats"))).toBe(true)
  })

  test("writing roles must write what was asked, and only where they may", () => {
    expect(evaluate(scenario("docs-writer"), { exitCode: 0, output: "", changed: ["README.md"] }).ok).toBe(true)
    expect(evaluate(scenario("docs-writer"), { exitCode: 0, output: "", changed: ["README.md", "src/math.js"] }).ok).toBe(false)
    expect(evaluate(scenario("docs-writer"), { exitCode: 0, output: "", changed: [] }).reasons).toEqual(["didn't write what the task asked for"])
    expect(evaluate(scenario("devops"), { exitCode: 0, output: "", changed: [".github/workflows/test.yml"] }).ok).toBe(true)
    expect(evaluate(scenario("qa"), { exitCode: 0, output: json("2 tests pass"), changed: ["test/math.test.js"] }).ok).toBe(true)
  })

  test("a failed run fails", () => {
    expect(evaluate(scenario("devops"), { exitCode: 1, output: "", changed: [".github/workflows/ci.yml"] }).reasons).toEqual(["kete exited with 1"])
  })

  test("every role the runtime ships has a scenario", () => {
    expect(SCENARIOS.map((item) => item.role).toSorted()).toEqual(["code-reviewer", "devops", "docs-writer", "qa", "security"])
  })
})
