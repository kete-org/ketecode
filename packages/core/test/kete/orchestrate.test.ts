// The coordinator's `orchestrate` tool (core/src/kete/orchestrate.ts): plan / status / finish against a
// fake platform, the plan file written only after the platform accepted the proposal, the proposal's
// digests computed by the contract mirror, what may leave the zone, and the permission rules.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteOrchestrate } from "@opencode/core/kete/orchestrate"
import { KeteDag } from "@opencode/core/kete/dag"
import * as C from "@opencode/core/kete/orchestration/contract"
import { Environment } from "@opencode/core/environment/index"
import { host } from "../plugin/host"

const id = "ab12cd34-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
const job = "c3d8f1a2-6b4e-4f7a-9c2d-8e1f0a3b5c7d"

const coordinator = (fields: Partial<{ final: boolean; titles: "omit" | "send" }> = {}) => ({
  version: 1 as const,
  id,
  role: "coordinator" as const,
  turn: 1,
  final: fields.final ?? false,
  plan: null,
  titles: fields.titles ?? ("send" as const),
})

const view = (fields: Partial<C.OrchestrationCoordinatorView> = {}): C.OrchestrationCoordinatorView => ({
  id,
  status: "coordinating",
  turn: 1,
  final: false,
  plan: null,
  proposal: null,
  decision: null,
  budget_micros: 20_000_000,
  reserve_micros: 3_000_000,
  allocated_micros: 3_000_000,
  spent_micros: 100_000,
  deadline: "2026-10-09T14:10:00Z",
  max_parallel: 3,
  worker_agents: ["developer"],
  limits: { nodes_per_plan: 8, nodes_total: 16, turns: 6, attempts_per_node: 3, jobs_total: 32, max_parallel: 3 },
  titles: "send",
  nodes: [],
  ...fields,
})

type Request = { method: string; url: string; body?: any }

function platform(answer: (request: Request) => { status: number; body: unknown } | undefined = () => undefined) {
  const requests: Request[] = []
  const fetch: KeteOrchestrate.Deps extends { target: () => infer T } ? any : never = async (
    url: string,
    init: RequestInit,
  ) => {
    const request: Request = {
      method: init.method ?? "GET",
      url,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    }
    requests.push(request)
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer job-key")
    const custom = answer(request)
    if (custom)
      return new Response(JSON.stringify(custom.body), {
        status: custom.status,
        headers: { "x-kete-request-id": "req-1" },
      })
    if (request.method === "PUT")
      return Response.json({
        orchestration: view({ proposal: { rev: request.body.rev, plan_digest: request.body.plan_digest } }),
      })
    if (request.method === "POST") return Response.json({ orchestration: view({ decision: request.body.decision }) })
    return Response.json({ orchestration: view() })
  }
  return { requests, fetch }
}

function files() {
  const written = new Map<string, Uint8Array>()
  const ops: string[] = []
  const impl: KeteOrchestrate.Deps["files"] = {
    write: (path, bytes) => Effect.sync(() => void (ops.push(`write ${path}`), written.set(path, bytes))),
    mkdir: (path) => Effect.sync(() => void ops.push(`mkdir ${path}`)),
    remove: (path) =>
      Effect.sync(() => {
        ops.push(`remove ${path}`)
        for (const key of [...written.keys()]) if (key.startsWith(path)) written.delete(key)
      }),
  }
  return { written, ops, impl }
}

function deps(fields: Partial<KeteOrchestrate.Deps> & { fetch?: any } = {}) {
  const fs = files()
  const d: KeteOrchestrate.Deps = {
    spec: coordinator(),
    target: () => ({ platform: "https://platform.kete.test", jobID: job, key: "job-key", fetch: fields.fetch }),
    files: fs.impl,
    directory: "/repo",
    boundary: { titles: true, summary: true },
    turn: {},
    ...fields,
  }
  return { d, fs }
}

const run = (d: KeteOrchestrate.Deps, input: KeteOrchestrate.Input) =>
  Effect.runPromiseExit(KeteOrchestrate.execute(d, input))
const message = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((exit.cause as any).reasons?.[0]?.error?.message ?? exit.cause) : ""

const node = (
  key: string,
  fields: Partial<KeteOrchestrate.Input["nodes"] extends readonly (infer N)[] | undefined ? N : never> = {},
) => ({
  key,
  title: `Do ${key}`,
  prompt: `Implement ${key}. Run the tests.`,
  agent: "developer",
  budget_usd: 1.5,
  timeout_minutes: 30,
  ...fields,
})

describe("orchestrate: plan", () => {
  test("writes the plan file only after the platform accepted the proposal, which carries no prompt", async () => {
    const p = platform()
    const { d, fs } = deps({ fetch: p.fetch })
    const exit = await run(d, {
      action: "plan",
      notes: "core first",
      nodes: [node("sdk-core"), node("client-web", { depends_on: ["sdk-core"], base_from: "sdk-core" })],
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(p.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET https://platform.kete.test/api/v1/jobs/${job}/orchestration`,
      `PUT https://platform.kete.test/api/v1/jobs/${job}/orchestration/plan`,
    ])
    const file = fs.written.get("/repo/.kete-orchestration/plan.json")!
    expect(file).toBeDefined()
    expect(fs.ops).toEqual(["mkdir /repo/.kete-orchestration", "write /repo/.kete-orchestration/plan.json"])
    // The proposal is exactly what the platform recomputes from the file (digests included).
    const recomputed = await C.orchestrationPlanProposal(file, "send")
    expect(recomputed.ok && recomputed.proposal).toEqual(p.requests[1]!.body)
    const sent = JSON.stringify(p.requests[1]!.body)
    expect(sent).not.toContain("Implement sdk-core")
    expect(sent).not.toContain("core first")
    expect(C.parseOrchestrationPlanFile(file)).toMatchObject({
      ok: true,
      plan: { rev: 1, notes: "core first", orchestration_id: id },
    })
    expect(d.turn.proposed?.rev).toBe(1)
  })

  test("the next revision follows the committed one", async () => {
    const p = platform((r) =>
      r.method === "GET"
        ? {
            status: 200,
            body: {
              orchestration: view({ plan: { rev: 2, branch: `kete/job/ab12cd34-plan-2`, sha: "1".repeat(40) } }),
            },
          }
        : undefined,
    )
    const { d, fs } = deps({ fetch: p.fetch })
    expect(Exit.isSuccess(await run(d, { action: "plan", nodes: [node("a")] }))).toBe(true)
    expect(p.requests[1]!.body.rev).toBe(3)
    expect(C.parseOrchestrationPlanFile(fs.written.get("/repo/.kete-orchestration/plan.json")!)).toMatchObject({
      ok: true,
      plan: { rev: 3 },
    })
  })

  test("titles leave only when the claim and the runtime's boundary allow", async () => {
    for (const [spec, boundary, sent] of [
      ["send", true, true],
      ["omit", true, false],
      ["send", false, false],
    ] as const) {
      const p = platform()
      const { d } = deps({
        fetch: p.fetch,
        spec: coordinator({ titles: spec }),
        boundary: { titles: boundary, summary: true },
      })
      expect(Exit.isSuccess(await run(d, { action: "plan", nodes: [node("a")] }))).toBe(true)
      expect("title" in p.requests[1]!.body.nodes[0]).toBe(sent)
    }
  })

  test("refuses locally what the platform would refuse, sending nothing", async () => {
    const cases: Array<[KeteOrchestrate.Input, string]> = [
      [{ action: "plan", nodes: [node("Bad_Key")] }, "nodes.0.key"],
      [{ action: "plan", nodes: [node("a", { depends_on: ["b"] }), node("b", { depends_on: ["a"] })] }, "cycle (a)"],
      [{ action: "plan", nodes: [node("a", { agent: "reviewer" })] }, "agent_not_permitted (a)"],
      [{ action: "plan", nodes: [node("a", { budget_usd: 25 })] }, "budget_exceeded"],
      [{ action: "plan", nodes: [node("a", { budget_usd: 0.1 })] }, "nodes.0.budget_micros"],
      [{ action: "plan", nodes: [] }, 'needs "nodes"'],
    ]
    for (const [input, expected] of cases) {
      const p = platform()
      const { d, fs } = deps({ fetch: p.fetch })
      const exit = await run(d, input)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(message(exit)).toContain(expected)
      expect(p.requests.filter((r) => r.method === "PUT")).toEqual([])
      expect(fs.written.size).toBe(0)
    }
  })

  test("the platform's refusal comes back with its issues; no file is written", async () => {
    const p = platform((r) =>
      r.method === "PUT"
        ? {
            status: 422,
            body: {
              error: {
                code: "not_permitted",
                message: "The plan is invalid.",
                request_id: "r",
                reason: "plan_invalid",
                issues: [{ code: "timeout_exceeds_deadline", key: "a" }],
              },
            },
          }
        : undefined,
    )
    const { d, fs } = deps({ fetch: p.fetch })
    const exit = await run(d, { action: "plan", nodes: [node("a")] })
    expect(message(exit)).toContain("[plan_invalid]")
    expect(message(exit)).toContain("timeout_exceeds_deadline (a)")
    expect(fs.written.size).toBe(0)
    expect(d.turn.proposed).toBeUndefined()
  })

  test("a final turn can't plan", async () => {
    const p = platform()
    const { d } = deps({ fetch: p.fetch, spec: coordinator({ final: true }) })
    expect(message(await run(d, { action: "plan", nodes: [node("a")] }))).toContain("final turn")
    expect(p.requests).toEqual([])
  })

  test("without a target it fails closed", async () => {
    const { d } = deps({ target: () => "no job key" })
    expect(message(await run(d, { action: "status" }))).toContain("unavailable in this job: no job key")
  })
})

describe("orchestrate: finish and status", () => {
  test("finish after a plan discards the plan file", async () => {
    const p = platform()
    const { d, fs } = deps({ fetch: p.fetch })
    await run(d, { action: "plan", nodes: [node("a")] })
    const exit = await run(d, { action: "finish", decision: "integrated", summary: "Merged a." })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(p.requests.at(-1)).toMatchObject({ method: "POST", body: { decision: "integrated", summary: "Merged a." } })
    expect(fs.ops.at(-1)).toBe("remove /repo/.kete-orchestration")
    expect(fs.written.size).toBe(0)
    expect(message(await run(d, { action: "plan", nodes: [node("a")] }))).toContain("already decided")
  })

  test("the summary stays in-zone when the boundary says so, and is never cut", async () => {
    const p = platform()
    const { d } = deps({ fetch: p.fetch, boundary: { titles: false, summary: false } })
    await run(d, { action: "finish", decision: "abandon", summary: "secret details" })
    expect(p.requests.at(-1)!.body).toEqual({ decision: "abandon" })
    const q = platform()
    const { d: d2 } = deps({ fetch: q.fetch })
    expect(message(await run(d2, { action: "finish", decision: "integrated", summary: "x".repeat(4097) }))).toContain(
      "shorten it",
    )
    expect(q.requests).toEqual([])
  })

  test("status describes the platform's view", async () => {
    const p = platform()
    const { d } = deps({ fetch: p.fetch })
    const exit = await run(d, { action: "status" })
    expect(Exit.isSuccess(exit) && exit.value.content).toContain(`Orchestration ${id}: status coordinating`)
  })
})

describe("orchestrate: permissions", () => {
  const evaluation = (resources: string[], action = "edit") => ({
    sessionID: "s" as any,
    action,
    resources,
    effect: "allow" as const as any,
  })

  test(".kete-orchestration is never edited but by the tool", () => {
    for (const resource of [".kete-orchestration/plan.json", "pkg/.Kete-Orchestration/x", ".kete-orchestration"]) {
      const event = evaluation([resource])
      KeteOrchestrate.applyPermission(undefined, event)
      expect(event.effect).toBe("deny")
    }
    const ok = evaluation(["src/a.ts"])
    KeteOrchestrate.applyPermission(undefined, ok)
    expect(ok.effect).toBe("allow")
  })

  test("after a plan, the turn edits nothing", () => {
    const event = evaluation(["src/a.ts"])
    KeteOrchestrate.applyPermission({ proposed: { rev: 1, digest: "d" } }, event)
    expect(event.effect).toBe("deny")
    const shell = evaluation(["npm test"], "shell")
    KeteOrchestrate.applyPermission({ proposed: { rev: 1, digest: "d" } }, shell)
    expect(shell.effect).toBe("allow")
  })
})

describe("orchestrate: install", () => {
  function recordingHost() {
    const tools: string[] = []
    const hooks: string[] = []
    const ctx: Plugin.Context = host({
      tool: {
        transform: (callback: any) =>
          Effect.sync(() => {
            callback({ add: (tool: { name: string }) => tools.push(tool.name) })
            return { dispose: Effect.void }
          }),
        reload: () => Effect.void,
        list: () => Effect.die("unused"),
        hook: () => Effect.die("unused"),
      } as any,
      permission: { hook: (name: string) => Effect.sync(() => void hooks.push(`permission.${name}`)) } as any,
      session: { hook: ((name: string) => Effect.sync(() => void hooks.push(`session.${name}`))) as any },
    })
    return { ctx, tools, hooks }
  }
  const environment = Environment.Service.of({ files: files().impl as any, spawner: undefined as any })
  const install = (ctx: Plugin.Context, orchestration?: any) =>
    Effect.runPromise(
      Effect.scoped(KeteOrchestrate.install(ctx, { orchestration, env: {} })).pipe(
        Effect.provideService(Environment.Service, environment),
      ),
    )

  test("a coordinator turn gets the tool, its rules and its instructions", async () => {
    const h = recordingHost()
    await install(h.ctx, { jobID: job, spec: coordinator() })
    expect(h.tools).toEqual(["orchestrate"])
    expect(h.hooks.sort()).toEqual(["permission.evaluate", "session.context"])
  })

  test("a node's job gets only the .kete-orchestration rule; any other job nothing", async () => {
    const worker = {
      version: 1,
      id,
      role: "worker",
      node: "a",
      attempt: 1,
      plan: { rev: 1, branch: "kete/job/ab12cd34-plan-1", sha: "1".repeat(40) },
      prompt_digest: "a".repeat(64),
      base_from: null,
    }
    const w = recordingHost()
    await install(w.ctx, { jobID: job, spec: worker })
    expect(w.tools).toEqual([])
    expect(w.hooks).toEqual(["permission.evaluate"])
    const none = recordingHost()
    await install(none.ctx)
    expect(none.tools).toEqual([])
    expect(none.hooks).toEqual([])
  })
})

describe("KeteDag", () => {
  test("orders in waves and reports what is on or behind a cycle", () => {
    expect(
      KeteDag.order([
        ["a", []],
        ["b", ["a"]],
        ["c", ["a"]],
        ["d", ["b", "c"]],
      ]),
    ).toEqual({ order: ["a", "b", "c", "d"], cycle: [] })
    expect(
      KeteDag.order([
        ["a", ["b"]],
        ["b", ["a"]],
        ["c", ["a"]],
        ["d", []],
      ]),
    ).toEqual({ order: ["d"], cycle: ["a", "b", "c"] })
    // Unlisted dependencies and self-references are the caller's to report.
    expect(KeteDag.order([["a", ["a", "zz"]]])).toEqual({ order: ["a"], cycle: [] })
  })
})
