import { describe, expect, test } from "bun:test"
import { Settings } from "../src/settings"

const run = (extra: Record<string, string>) => ({
  PLUGIN_TASK: "Fix the failing test",
  PLUGIN_BUDGET: "2",
  PLUGIN_TIMEOUT: "30",
  PLUGIN_ANTHROPIC_API_KEY: "sk-ant-secretvalue0123456789",
  ...extra,
})
const cloud = (extra: Record<string, string>) => ({
  PLUGIN_MODE: "cloud",
  PLUGIN_TASK: "Fix the failing test",
  PLUGIN_BUDGET: "2",
  PLUGIN_TIMEOUT: "30",
  PLUGIN_KETE_API_KEY: "kete_secretvalue",
  PLUGIN_PROJECT: "11111111-1111-4111-8111-111111111111",
  PLUGIN_REPO: "22222222-2222-4222-8222-222222222222",
  PLUGIN_AGENT: "build",
  ...extra,
})

function refusal(env: Record<string, string | undefined>): string {
  try {
    Settings.parse(env)
  } catch (error) {
    expect(error).toBeInstanceOf(Settings.SettingsError)
    return (error as Error).message
  }
  throw new Error("expected a refusal")
}

describe("run mode", () => {
  test("defaults to run with the budget, time limit and provider keys", () => {
    const s = Settings.parse(run({}))
    expect(s.mode).toBe("run")
    if (s.mode !== "run") return
    expect(s.budget).toBe(2)
    expect(s.timeout).toBe(30)
    expect(s.access).toEqual({ kind: "providers", env: { ANTHROPIC_API_KEY: "sk-ant-secretvalue0123456789" } })
    expect(s.outputDir).toBe("kete-output")
    expect(s.platformURL).toBe(Settings.defaultBaseURL)
    expect(s.pushBranch).toBeUndefined()
  })

  test("a missing budget, time limit or task is refused with a named reason", () => {
    expect(refusal(run({ PLUGIN_BUDGET: "" }))).toContain("PLUGIN_BUDGET is required")
    expect(refusal(run({ PLUGIN_TIMEOUT: " " }))).toContain("PLUGIN_TIMEOUT is required")
    expect(refusal({ ...run({}), PLUGIN_TASK: undefined })).toContain("Set PLUGIN_TASK")
  })

  test("invalid modes, presets, budgets and limits are refused", () => {
    expect(refusal(run({ PLUGIN_MODE: "local" }))).toContain("PLUGIN_MODE must be run or cloud")
    expect(refusal(run({ PLUGIN_PRESET: "deploy" }))).toContain("PLUGIN_PRESET must be one of")
    expect(refusal(run({ PLUGIN_BUDGET: "-1" }))).toContain("positive amount")
    expect(refusal(run({ PLUGIN_BUDGET: "0" }))).toContain("greater than 0")
    expect(refusal(run({ PLUGIN_BUDGET: "lots" }))).toContain("positive amount")
    expect(refusal(run({ PLUGIN_TIMEOUT: "0" }))).toContain("greater than 0")
    expect(refusal(run({ PLUGIN_TIMEOUT: "1.5" }))).toContain("whole minutes")
    expect(refusal(run({ PLUGIN_TIMEOUT: "2000" }))).toContain("at most 1440")
  })

  test("time limits accept minutes and hours, budgets a dollar sign", () => {
    expect(Settings.timeout("45m", 1440)).toBe(45)
    expect(Settings.timeout("2h", 1440)).toBe(120)
    expect(Settings.budget("$0.50", undefined)).toBe(0.5)
  })

  test("fix-build needs a log path inside the workspace", () => {
    expect(refusal(run({ PLUGIN_TASK: "", PLUGIN_PRESET: "fix-build" }))).toContain("needs PLUGIN_LOG")
    expect(refusal(run({ PLUGIN_PRESET: "fix-build", PLUGIN_LOG: "/etc/passwd" }))).toContain("not an absolute path")
    expect(refusal(run({ PLUGIN_PRESET: "fix-build", PLUGIN_LOG: "logs/../../x" }))).toContain('".."')
    const s = Settings.parse(run({ PLUGIN_TASK: "", PLUGIN_PRESET: "fix-build", PLUGIN_LOG: "build.log" }))
    expect(s.preset).toBe("fix-build")
    expect(s.task).toBeUndefined()
  })

  test("model access: exactly one kind, the gateway with its URL, an endpoint with its model", () => {
    expect(refusal({ ...run({}), PLUGIN_ANTHROPIC_API_KEY: undefined })).toContain("needs model access")
    expect(refusal(run({ PLUGIN_KETE_API_KEY: "kete_x" }))).toContain("one kind of model access")
    expect(refusal({ ...run({}), PLUGIN_ANTHROPIC_API_KEY: undefined, PLUGIN_KETE_API_KEY: "kete_x" })).toContain(
      "PLUGIN_GATEWAY_URL",
    )
    const gw = Settings.parse({
      ...run({}),
      PLUGIN_ANTHROPIC_API_KEY: undefined,
      PLUGIN_KETE_API_KEY: "kete_x",
      PLUGIN_GATEWAY_URL: "https://gateway.example.com/",
    })
    expect(gw.mode === "run" && gw.access).toEqual({
      kind: "gateway",
      key: "kete_x",
      gatewayURL: "https://gateway.example.com",
    })
    expect(
      refusal({ ...run({}), PLUGIN_ANTHROPIC_API_KEY: undefined, PLUGIN_MODEL_URL: "http://10.0.0.5:8000/v1" }),
    ).toContain("needs PLUGIN_MODEL")
    const ep = Settings.parse({
      ...run({}),
      PLUGIN_ANTHROPIC_API_KEY: undefined,
      PLUGIN_MODEL_URL: "http://10.0.0.5:8000/v1",
      PLUGIN_MODEL: "qwen",
    })
    expect(ep.mode === "run" && ep.access).toEqual({ kind: "endpoint", url: "http://10.0.0.5:8000/v1", key: undefined })
    expect(
      refusal({
        ...run({}),
        PLUGIN_ANTHROPIC_API_KEY: undefined,
        PLUGIN_MODEL_URL: "http://models.example.com/v1",
        PLUGIN_MODEL: "q",
      }),
    ).toContain("https")
    const gemini = Settings.parse({ ...run({}), PLUGIN_ANTHROPIC_API_KEY: undefined, PLUGIN_GEMINI_API_KEY: "AIzaKey" })
    expect(gemini.mode === "run" && gemini.access).toEqual({
      kind: "providers",
      env: { GEMINI_API_KEY: "AIzaKey", GOOGLE_GENERATIVE_AI_API_KEY: "AIzaKey" },
    })
  })

  test("a malformed key is refused without echoing it", () => {
    const message = refusal(run({ PLUGIN_ANTHROPIC_API_KEY: "sk-ant with spaces" }))
    expect(message).toContain("PLUGIN_ANTHROPIC_API_KEY is not a valid key")
    expect(message).not.toContain("with spaces")
  })

  test("push branch: true means the run's own branch; names must be valid", () => {
    const t = Settings.parse(run({ PLUGIN_PUSH_BRANCH: "true" }))
    expect(t.mode === "run" && t.pushBranch).toBe("generated")
    const n = Settings.parse(run({ PLUGIN_PUSH_BRANCH: "kete/fix-123" }))
    expect(n.mode === "run" && n.pushBranch).toBe("kete/fix-123")
    const f = Settings.parse(run({ PLUGIN_PUSH_BRANCH: "false" }))
    expect(f.mode === "run" && f.pushBranch).toBeUndefined()
    expect(refusal(run({ PLUGIN_PUSH_BRANCH: "bad..name" }))).toContain("PLUGIN_PUSH_BRANCH")
    expect(refusal(run({ PLUGIN_PUSH_BRANCH: "-x" }))).toContain("PLUGIN_PUSH_BRANCH")
  })

  test("allow rules from JSON or action:resource lists; question and budget never", () => {
    expect(Settings.allow('[{"action":"shell","resource":"bun test*"}]')).toEqual([
      { action: "shell", resource: "bun test*" },
    ])
    expect(Settings.allow("shell:bun test*,edit:src/**\nshell:npm run build")).toEqual([
      { action: "shell", resource: "bun test*" },
      { action: "edit", resource: "src/**" },
      { action: "shell", resource: "npm run build" },
    ])
    expect(refusal(run({ PLUGIN_ALLOW: "question:*" }))).toContain("can never be allowed")
    expect(refusal(run({ PLUGIN_ALLOW: '[{"action":"budget","resource":"*"}]' }))).toContain("can never be allowed")
    expect(refusal(run({ PLUGIN_ALLOW: '[{"action":"edit","resource":"*","extra":1}]' }))).toContain("unknown field")
    expect(refusal(run({ PLUGIN_ALLOW: "[not json" }))).toContain("not valid JSON")
    expect(refusal(run({ PLUGIN_ALLOW: "justtext" }))).toContain("action:resource")
  })

  test("base and output paths are validated", () => {
    expect(refusal(run({ PLUGIN_BASE_URL: "http://app.example.com" }))).toContain("https")
    expect(refusal(run({ PLUGIN_BASE_URL: "https://user:pw@app.example.com" }))).toContain("credentials")
    expect(refusal(run({ PLUGIN_OUTPUT_DIR: "../out" }))).toContain("PLUGIN_OUTPUT_DIR")
    const local = Settings.parse(run({ PLUGIN_BASE_URL: "http://127.0.0.1:8080" }))
    expect(local.mode === "run" && local.platformURL).toBe("http://127.0.0.1:8080")
  })
})

describe("cloud mode", () => {
  test("parses a complete cloud step", () => {
    const s = Settings.parse(cloud({ PLUGIN_PUSH_BRANCH: "true", PLUGIN_OPEN_PR: "true", PLUGIN_BASE_REF: "develop" }))
    expect(s.mode).toBe("cloud")
    if (s.mode !== "cloud") return
    expect(s.baseURL).toBe("https://app.ketecode.ai")
    expect(s.push).toEqual({ suffix: undefined })
    expect(s.openPR).toBe(true)
    expect(s.baseRef).toBe("develop")
  })

  test("needs the key, project, repository and agent", () => {
    expect(refusal({ ...cloud({}), PLUGIN_KETE_API_KEY: undefined })).toContain("PLUGIN_KETE_API_KEY")
    expect(refusal(cloud({ PLUGIN_PROJECT: "nope" }))).toContain("PLUGIN_PROJECT")
    expect(refusal({ ...cloud({}), PLUGIN_REPO: undefined })).toContain("PLUGIN_REPO")
    expect(refusal({ ...cloud({}), PLUGIN_AGENT: undefined })).toContain("PLUGIN_AGENT")
  })

  test("the API's limits apply", () => {
    expect(refusal(cloud({ PLUGIN_BUDGET: "30" }))).toContain("at most 25")
    expect(refusal(cloud({ PLUGIN_TIMEOUT: "3h" }))).toContain("at most 120")
    expect(refusal(cloud({ PLUGIN_OPEN_PR: "true" }))).toContain("needs PLUGIN_PUSH_BRANCH")
    expect(refusal(cloud({ PLUGIN_OPEN_PR: "maybe", PLUGIN_PUSH_BRANCH: "true" }))).toContain("true or false")
  })

  test("a push suffix becomes kete/job/<suffix>", () => {
    const s = Settings.parse(cloud({ PLUGIN_PUSH_BRANCH: "kete/job/fix-1" }))
    expect(s.mode === "cloud" && s.push).toEqual({ suffix: "fix-1" })
    expect(refusal(cloud({ PLUGIN_PUSH_BRANCH: "a..b" }))).toContain("suffix")
  })
})
