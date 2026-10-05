// Kete-owned test fixture: the cloud-job user routes of the Kete platform API
// (docs/platform/jobs-v1.md) on 127.0.0.1. `POST /api/v1/jobs` creates a job; each
// `GET /api/v1/jobs/{id}` advances it through `statuses`; `POST …/cancel` records the cancel.

export const jobID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff"
export const apiKey = "kete_test_key_0123456789abcdef"

export type Scenario = {
  /** Statuses returned by successive GETs; the last one repeats. */
  statuses: string[]
  outcome?: string | null
  pushStatus?: string
  prURL?: string | null
  summary?: string | null
  /** Answer the create with this error instead. */
  createError?: { status: number; code: string; message: string }
  /** Fail this many creates with 503 first. */
  createFailures?: number
  /** Fail this many GETs with 503 first. */
  getFailures?: number
  /** Answer every cancel with 500. */
  cancelError?: boolean
}

export type FakePlatform = {
  readonly url: string
  readonly creates: { body: Record<string, unknown>; headers: Record<string, string> }[]
  readonly gets: number
  readonly cancels: number
  readonly unauthorized: number
  stop(): void
}

export function startFakePlatform(scenario: Scenario): FakePlatform {
  const state = {
    creates: [] as FakePlatform["creates"],
    gets: 0,
    cancels: 0,
    unauthorized: 0,
    createFailures: 0,
    getFailures: 0,
  }
  const job = (status: string) => ({
    job: {
      id: jobID,
      status,
      outcome: ["succeeded", "failed", "cancelled", "timed_out"].includes(status) ? (scenario.outcome ?? null) : null,
      exit_code: null,
      project_id: "11111111-1111-4111-8111-111111111111",
      repository: { id: "22222222-2222-4222-8222-222222222222", full_name: "acme/shop", base_ref: "main" },
      agent: { id: "33333333-3333-4333-8333-333333333333", slug: "build", version: 1 },
      branch: "kete/job/harness1",
      push: true,
      push_status: status === "succeeded" ? (scenario.pushStatus ?? "not_requested") : "pending",
      pr_url: status === "succeeded" ? (scenario.prURL ?? null) : null,
      warnings: [],
      budget_micros: 2_000_000,
      spent_micros: 120_000,
      timeout_minutes: 30,
      effective_timeout_minutes: 30,
      created_by: "44444444-4444-4444-8444-444444444444",
      created_at: "2026-10-05T00:00:00Z",
      started_at: null,
      ended_at: null,
      reported: { denied_count: 0, summary_text: scenario.summary ?? null },
      some_future_field: "ignored",
    },
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get("authorization") !== `Bearer ${apiKey}`) {
        state.unauthorized++
        return Response.json({ error: { code: "unauthorized", message: "bad key", request_id: "r" } }, { status: 401 })
      }
      if (req.method === "POST" && url.pathname === "/api/v1/jobs") {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => (headers[k] = v))
        state.creates.push({ body: (await req.json()) as Record<string, unknown>, headers })
        if (state.createFailures < (scenario.createFailures ?? 0)) {
          state.createFailures++
          return new Response("unavailable", { status: 503 })
        }
        if (scenario.createError)
          return Response.json(
            { error: { ...scenario.createError, request_id: "r" } },
            { status: scenario.createError.status },
          )
        return Response.json(job("queued"), { status: 201 })
      }
      if (req.method === "GET" && url.pathname === `/api/v1/jobs/${jobID}`) {
        if (state.getFailures < (scenario.getFailures ?? 0)) {
          state.getFailures++
          return new Response("unavailable", { status: 503 })
        }
        const status = scenario.statuses[Math.min(state.gets, scenario.statuses.length - 1)]!
        state.gets++
        return Response.json(job(status))
      }
      if (req.method === "POST" && url.pathname === `/api/v1/jobs/${jobID}/cancel`) {
        state.cancels++
        if (scenario.cancelError)
          return Response.json({ error: { code: "internal", message: "down", request_id: "r" } }, { status: 500 })
        return Response.json(job("cancelling"), { status: 202 })
      }
      return Response.json({ error: { code: "not_found", message: "no route", request_id: "r" } }, { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get creates() {
      return state.creates
    },
    get gets() {
      return state.gets
    },
    get cancels() {
      return state.cancels
    },
    get unauthorized() {
      return state.unauthorized
    },
    stop: () => server.stop(true),
  }
}
