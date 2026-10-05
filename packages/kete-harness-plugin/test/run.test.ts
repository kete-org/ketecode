// Integration: run mode drives a real `kete job run` (built binary or source) against a fake
// OpenAI-compatible model endpoint on 127.0.0.1, in a throwaway git workspace with a local bare
// remote. Nothing leaves the machine.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fakeSecret, finalAnswer, startFakeModel, type FakeModel } from "./fixtures/fake-model"
import { keteBinary, pipeline, sh } from "./fixtures/kete"

const main = path.resolve(import.meta.dir, "../src/main.ts")
let model: FakeModel | undefined
const dirs: string[] = []
afterEach(() => {
  model?.stop()
  // kete's data and cache under each throwaway HOME are tens of MB.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Async: the fake model lives in this process, so the test must not block its event loop.
async function step(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, main], { env, stdout: "ignore", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill("SIGTERM"), 150_000)
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  clearTimeout(timer)
  const read = (file: string) =>
    existsSync(file)
      ? Object.fromEntries(
          readFileSync(file, "utf8")
            .trimEnd()
            .split("\n")
            .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
        )
      : {}
  return { code, stderr, drone: read(env.DRONE_OUTPUT!), harness: read(env.HARNESS_OUTPUT!) }
}

// No key shape and no secret-looking variable name would give it away: only keeping it out of the
// agent's environment (and literal masking) can.
const endpointKey = "plainendpointvalue0123"

function settings(
  p: ReturnType<typeof pipeline>,
  extra: Record<string, string>,
  fake: Parameters<typeof startFakeModel>[0] = {},
) {
  dirs.push(p.dir)
  model = startFakeModel(fake)
  return {
    ...p.env,
    KETE_HARNESS_KETE_BIN: keteBinary(p.dir),
    PLUGIN_PRESET: "fix-build",
    PLUGIN_LOG: "build.log",
    PLUGIN_BUDGET: "1",
    PLUGIN_TIMEOUT: "5",
    PLUGIN_MODEL_URL: model.url,
    PLUGIN_MODEL: "fake-model",
    PLUGIN_MODEL_API_KEY: endpointKey,
    ...extra,
  }
}

describe("run mode", () => {
  test("runs kete job run with the budget and limit, writes outputs and the audit artifact, pushes a new branch", async () => {
    const p = pipeline()
    const r = await step(settings(p, { PLUGIN_PUSH_BRANCH: "kete/fix-build-1" }))
    if (r.code !== 0) console.error(r.stderr)
    expect(r.code).toBe(0)
    expect(r.drone).toEqual({
      KETE_OUTCOME: "completed",
      KETE_SUMMARY: finalAnswer.replace(fakeSecret, "[REDACTED]"),
      KETE_BRANCH: "kete/fix-build-1",
      KETE_JOB_URL: "",
    })
    expect(r.harness).toEqual(r.drone)

    // The model got the endpoint key; the log's secret never reached it or the outputs.
    expect(model!.requests.length).toBeGreaterThanOrEqual(2)
    expect(model!.requests[0]!.authorization).toBe(`Bearer ${endpointKey}`)
    expect(r.stderr).not.toContain(endpointKey)
    expect(r.stderr).not.toContain(fakeSecret)

    // Artifacts in the workspace: the audit log (the run's policy, the allowed edit), result, summary.
    const out = path.join(p.workspace, "kete-output")
    const audit = readFileSync(path.join(out, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(audit[0]).toMatchObject({
      type: "run",
      event: "started",
      limits: { budget_usd: 1, timeout_minutes: 5, missing: [] },
    })
    expect(audit.some((l) => l.type === "permission" && l.action === "edit" && l.effect === "allow")).toBe(true)
    expect(audit.some((l) => l.type === "run" && l.event === "ended")).toBe(true)
    const summary = readFileSync(path.join(out, "summary.md"), "utf8")
    expect(summary).toContain("## Kete Code: completed")
    expect(summary).toContain("Pushed to new branch `kete/fix-build-1`")
    expect(summary).not.toContain(fakeSecret)
    expect(readFileSync(path.join(out, "result.json"), "utf8")).not.toContain(fakeSecret)

    // The new branch holds the agent's change; main is untouched.
    expect(sh(p.remote, ["show", "kete/fix-build-1:FIXED.md"])).toBe("fixed")
    expect(sh(p.remote, ["log", "-1", "--format=%an <%ae> %s", "kete/fix-build-1"])).toBe(
      "Kete Code <kete-code@users.noreply.invalid> kete: fix-build",
    )
    expect(sh(p.remote, ["rev-list", "--count", "main"])).toBe("1")
    expect(() => sh(p.remote, ["show", "main:FIXED.md"])).toThrow()
  }, 180_000)

  test("an allowed shell command can't print the model key: it isn't in the agent's environment", async () => {
    const p = pipeline()
    const r = await step(settings(p, { PLUGIN_ALLOW: "shell:printenv" }, { shell: "printenv" }))
    if (r.code !== 0) console.error(r.stderr)
    expect(r.code).toBe(0)
    // The command ran and its output went back to the model...
    const toolTurn = model!.requests.find((q) => q.body.includes('"role":"tool"'))
    expect(toolTurn?.body).toContain("DRONE_WORKSPACE=")
    // ...without the key, the step's settings or the clone credentials.
    for (const q of model!.requests) {
      expect(q.body).not.toContain(endpointKey)
      expect(q.body).not.toContain("PLUGIN_")
    }
    const out = path.join(p.workspace, "kete-output")
    for (const file of ["audit.jsonl", "result.json", "summary.md"])
      expect(readFileSync(path.join(out, file), "utf8")).not.toContain(endpointKey)
  }, 180_000)

  test("never pushes to the target branch: refused (exit 2) before the run starts", async () => {
    const p = pipeline()
    const r = await step(settings(p, { PLUGIN_PUSH_BRANCH: "MAIN" }))
    expect(r.code).toBe(2)
    expect(r.drone.KETE_OUTCOME).toBe("refused")
    expect(model!.requests).toHaveLength(0)
    expect(sh(p.remote, ["rev-list", "--count", "main"])).toBe("1")
  }, 60_000)

  test("an existing remote branch is never overwritten (exit 2)", async () => {
    const p = pipeline()
    sh(p.workspace, ["push", "-q", "origin", "main:refs/heads/kete/taken"])
    const before = sh(p.remote, ["rev-parse", "kete/taken"])
    const r = await step(settings(p, { PLUGIN_PUSH_BRANCH: "kete/taken" }))
    expect(r.code).toBe(2)
    expect(r.drone.KETE_OUTCOME).toBe("push_refused")
    expect(sh(p.remote, ["rev-parse", "kete/taken"])).toBe(before)
  }, 180_000)

  test("without a push the run's changes stay in its worktree; no budget is refused by the step", async () => {
    const p = pipeline()
    const r = await step(settings(p, {}))
    expect(r.code).toBe(0)
    expect(r.drone.KETE_BRANCH).toBe("")
    expect(sh(p.remote, ["branch", "--list"])).not.toContain("kete/")
    model!.stop()
    const refused = await step(settings(p, { PLUGIN_BUDGET: "" }))
    expect(refused.code).toBe(2)
    expect(refused.drone.KETE_SUMMARY).toContain("PLUGIN_BUDGET is required")
  }, 180_000)
})
