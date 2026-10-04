import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteJobSync } from "../../src/kete/job-sync"

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const jobKey = "kete_job_0123456789abcdef"

const agent = (slug: string) => ({
  id: "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
  slug,
  version: 1,
  name: slug,
  description: `The ${slug} agent.`,
  mode: "primary" as const,
  model: { provider: "deepseek" as const, model_id: "test-chat" },
  instructions: `You are ${slug}.`,
  tools: { edit: true, shell: false, web: false, skills: [], subagents: [], mcp: {} },
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
  budget: { monthly_micros: null, spent_micros: 0, period: "2026-10" },
})

const skill = {
  id: "9a1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c02",
  slug: "lint",
  name: "Lint",
  description: "",
  version: "1.0.0",
  instructions: "Run the linter.",
  requires_mcp: [],
  files: [{ path: "run.sh", size_bytes: 1, sha256: "0".repeat(64), executable: true }],
}

const body = (extra: object = {}) => ({
  organization: { id: org, name: "Kete Labs" },
  generated_at: "2026-10-01T10:00:00Z",
  agents: [agent("developer"), agent("reviewer")],
  ...extra,
})

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function run(
  reply: (url: string, init: RequestInit) => Response | Promise<Response>,
  overrides: Partial<KeteJobSync.Input> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-job-sync-"))
  directories.push(root)
  const seen: Array<{ url: string; authorization: string | null }> = []
  const result = await KeteJobSync.first({
    key: jobKey,
    spec: { agent: "developer" },
    environment: { OPENCODE_PLATFORM_URL: "https://platform.test" },
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    fetch: async (url, init) => {
      seen.push({ url, authorization: new Headers(init.headers).get("authorization") })
      return reply(url, init)
    },
    ...overrides,
  })
  return { result, seen, root }
}

const ok = () => Response.json(body(), { headers: { etag: '"e1"' } })

describe("KeteJobSync.first", () => {
  test("syncs with the job key and returns the organization; the cache is written", async () => {
    const { result, seen, root } = await run(ok)
    expect(result).toEqual({ kind: "ok", organization: org })
    expect(seen).toEqual([{ url: "https://platform.test/api/v1/sync", authorization: `Bearer ${jobKey}` }])
    const cache = await readFile(path.join(root, "config", "managed", org, "agents.json"), "utf8")
    expect(cache).not.toContain(jobKey)
  })

  test("a failed sync is an error: refused key, platform error, network failure", async () => {
    const unauthorized = await run(() =>
      Response.json({ error: { code: "invalid_key", message: "revoked", request_id: "r1" } }, { status: 401 }),
    )
    expect(unauthorized.result.kind).toBe("error")
    expect(unauthorized.result).toMatchObject({ message: expect.stringContaining("refused the job's key") })
    expect(JSON.stringify(unauthorized.result)).not.toContain("kete login")
    expect(JSON.stringify(unauthorized.result)).not.toContain(jobKey)

    const unavailable = await run(() => Response.json({}, { status: 500 }))
    expect(unavailable.result).toMatchObject({ kind: "error", message: expect.stringContaining("first sync with the platform failed") })

    const offline = await run(() => {
      throw new Error("connection refused")
    })
    expect(offline.result).toMatchObject({ kind: "error", message: expect.stringContaining("Could not reach the platform") })
  })

  test("a managed skill that fails to download is an error", async () => {
    const { result } = await run((url) =>
      url.endsWith("/api/v1/sync") ? Response.json(body({ skills: [skill] }), { headers: { etag: '"e1"' } }) : Response.json({}, { status: 500 }),
    )
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("managed skill") })
  })

  test("no platform URL (or one that is not http(s)) is an error and makes no request", async () => {
    for (const environment of [{}, { OPENCODE_PLATFORM_URL: "ftp://platform.test" }]) {
      const { result, seen } = await run(ok, { environment })
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("KETE_PLATFORM_URL") })
      expect(seen).toEqual([])
    }
  })

  test("spec.agent is required, and must be one of the synced agents (refused)", async () => {
    const missing = await run(ok, { spec: {} })
    expect(missing.result).toMatchObject({ kind: "refused", message: expect.stringContaining("must name an `agent`") })

    const unknown = await run(ok, { spec: { agent: "ghost" } })
    expect(unknown.result).toMatchObject({
      kind: "refused",
      message: expect.stringContaining('spec.agent "ghost" is not among Kete Labs\'s synced agents (developer, reviewer)'),
    })
  })
})

describe("KeteJobSync.first is bounded", () => {
  test("an interrupt aborts the in-flight sync and is an error", async () => {
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const pending = run(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!
          signals.push(signal)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          setTimeout(() => controller.abort(), 10)
        }),
      { signal: controller.signal },
    )
    const { result } = await pending
    expect(signals).toHaveLength(1)
    expect(result).toEqual({ kind: "error", message: "Job mode: the job was interrupted during its first sync." })
  })

  test("every request carries the overall deadline's signal", async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const { result } = await run((url, init) => {
      signals.push(init.signal)
      return ok()
    })
    expect(result.kind).toBe("ok")
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true)
    expect(KeteJobSync.deadline).toBe(120_000)
  })
})
