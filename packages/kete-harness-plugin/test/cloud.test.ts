// Integration: cloud mode against a fake Kete platform on 127.0.0.1 (no network beyond loopback).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { main } from "../src/main"
import { apiKey, jobID, startFakePlatform, type FakePlatform, type Scenario } from "./fixtures/fake-platform"

let platform: FakePlatform | undefined
afterEach(() => platform?.stop())

async function step(scenario: Scenario, extra: Record<string, string> = {}) {
  platform = startFakePlatform(scenario)
  const ws = mkdtempSync(path.join(tmpdir(), "kete-harness-cloud-"))
  const out = path.join(ws, "drone-output.env")
  const logs: string[] = []
  let clock = 0
  const code = await main({
    env: {
      DRONE_WORKSPACE: ws,
      DRONE_OUTPUT: out,
      PLUGIN_MODE: "cloud",
      PLUGIN_BASE_URL: platform.url,
      PLUGIN_KETE_API_KEY: apiKey,
      PLUGIN_PROJECT: "11111111-1111-4111-8111-111111111111",
      PLUGIN_REPO: "22222222-2222-4222-8222-222222222222",
      PLUGIN_AGENT: "build",
      PLUGIN_TASK: "Fix the flaky test",
      PLUGIN_BUDGET: "1.5",
      PLUGIN_TIMEOUT: "10",
      ...extra,
    },
    log: (line) => logs.push(line),
    // A fake clock: every sleep advances it, so backoff and the wait limit run instantly.
    cloud: {
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      poll: { initialMs: 5_000, factor: 2, maxMs: 30_000 },
      graceMs: 60_000,
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(out, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  )
  return { code, outputs, logs, ws, summary: readFileSync(path.join(ws, "kete-output", "summary.md"), "utf8") }
}

describe("cloud mode", () => {
  test("starts the job, waits for it and reports the URL and pull request", async () => {
    const r = await step(
      {
        statuses: ["provisioning", "running", "finalizing", "succeeded"],
        outcome: "completed",
        pushStatus: "created",
        prURL: "https://github.com/acme/shop/pull/42",
        summary: "Fixed it. token=abc123secret",
      },
      { PLUGIN_PUSH_BRANCH: "true", PLUGIN_OPEN_PR: "true", PLUGIN_PRESET: "review" },
    )
    expect(r.code).toBe(0)
    const create = platform!.creates[0]!
    expect(create.body).toEqual({
      project_id: "11111111-1111-4111-8111-111111111111",
      repository_id: "22222222-2222-4222-8222-222222222222",
      agent: "build",
      prompt: expect.stringContaining("Review the changes"),
      allow: expect.arrayContaining([{ action: "shell", resource: "git diff*" }]),
      budget_micros: 1_500_000,
      timeout_minutes: 10,
      push: true,
      open_pr: true,
    })
    expect(create.headers.authorization).toBe(`Bearer ${apiKey}`)
    expect(create.headers["idempotency-key"]).toMatch(/^kete-harness-[0-9a-f-]{36}$/)
    expect(r.outputs).toEqual({
      KETE_OUTCOME: "completed",
      KETE_SUMMARY: "Fixed it. token=[REDACTED]",
      KETE_BRANCH: "kete/job/harness1",
      KETE_JOB_URL: `${platform!.url}/jobs/${jobID}`,
    })
    expect(r.logs.join("\n")).toContain("Pull request: https://github.com/acme/shop/pull/42")
    expect(r.summary).toContain("Pull request: https://github.com/acme/shop/pull/42")
    expect(r.logs.join("\n")).not.toContain(apiKey)
    expect(platform!.gets).toBe(4)
  })

  test("a job that hit its budget exits 2; a failed one exits 1", async () => {
    const budget = await step({ statuses: ["running", "failed"], outcome: "budget" })
    expect(budget.code).toBe(2)
    expect(budget.outputs.KETE_OUTCOME).toBe("budget")
    expect(budget.outputs.KETE_BRANCH).toBe("")
    platform!.stop()
    const failed = await step({ statuses: ["failed"], outcome: "error" })
    expect(failed.code).toBe(1)
    platform!.stop()
    const timedOut = await step({ statuses: ["timed_out"], outcome: null })
    expect(timedOut.code).toBe(1)
    expect(timedOut.outputs.KETE_OUTCOME).toBe("timed_out")
  })

  test("a refused create (policy, permissions) exits 2 with the platform's code", async () => {
    const r = await step({
      statuses: ["queued"],
      createError: { status: 422, code: "not_permitted", message: "rule shell:* isn't permitted" },
    })
    expect(r.code).toBe(2)
    expect(r.outputs.KETE_OUTCOME).toBe("not_permitted")
    expect(r.outputs.KETE_JOB_URL).toBe("")
    expect(platform!.creates).toHaveLength(1)
  })

  test("a wrong key is refused", async () => {
    const r = await step({ statuses: ["queued"] }, { PLUGIN_KETE_API_KEY: "kete_wrong_key" })
    expect(r.code).toBe(2)
    expect(r.outputs.KETE_OUTCOME).toBe("unauthorized")
    expect(r.logs.join("\n")).not.toContain("kete_wrong_key")
  })

  test("transient errors are retried with the same idempotency key", async () => {
    const r = await step(
      { statuses: ["running", "succeeded"], outcome: "completed", createFailures: 2, getFailures: 2 },
      { PLUGIN_IDEMPOTENCY_KEY: "pipeline-7-step-kete" },
    )
    expect(r.code).toBe(0)
    expect(platform!.creates.map((c) => c.headers["idempotency-key"])).toEqual(Array(3).fill("pipeline-7-step-kete"))
  })

  test("honours the time limit: cancels the job and exits 1", async () => {
    const r = await step({ statuses: ["running"] }, { PLUGIN_TIMEOUT: "1" })
    expect(r.code).toBe(1)
    expect(r.outputs.KETE_OUTCOME).toBe("time_limit")
    expect(r.outputs.KETE_JOB_URL).toBe(`${platform!.url}/jobs/${jobID}`)
    expect(platform!.cancels).toBe(1)
    // 1 minute + 1 minute grace, polling every 5-30 s.
    expect(platform!.gets).toBeLessThan(10)
  })

  test("settings errors are refused before any request", async () => {
    platform = startFakePlatform({ statuses: ["queued"] })
    const ws = mkdtempSync(path.join(tmpdir(), "kete-harness-cloud-"))
    const out = path.join(ws, "o.env")
    const code = await main({
      env: { DRONE_WORKSPACE: ws, DRONE_OUTPUT: out, PLUGIN_MODE: "cloud", PLUGIN_TASK: "x", PLUGIN_BUDGET: "1" },
      log: () => {},
    })
    expect(code).toBe(2)
    expect(readFileSync(out, "utf8")).toContain("KETE_OUTCOME=refused")
    expect(platform.creates).toHaveLength(0)
  })
})
