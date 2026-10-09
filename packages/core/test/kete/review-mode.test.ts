// Review mode (core/src/kete/review-mode.ts): the `review` tool records only a review the contract
// accepts, every tool but read and review is hidden and refused, every action but read is denied, and
// the review job's instructions are added. The review.json vector's result.review goes through the tool.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { readFileSync } from "node:fs"
import nodePath from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { KeteReviewMode } from "@opencode/core/kete/review-mode"
import type { KeteReview } from "@opencode/util/kete/review"
import { Environment } from "@opencode/core/environment/index"
import { host } from "../plugin/host"

const vector = JSON.parse(
  readFileSync(
    nodePath.join(import.meta.dir, "..", "..", "..", "kete-job-entrypoint", "internal", "fakeplatform", "testdata", "jobs-v1", "review.json"),
    "utf8",
  ),
)
const spec: KeteReview.Spec = vector.response.spec.review

function deps(fields: Partial<KeteReviewMode.Deps> = {}) {
  const recorded: KeteReview.Output[] = []
  const value: KeteReviewMode.Deps = {
    spec,
    record: async (review) => void recorded.push(review),
    ...fields,
  }
  return { value, recorded }
}

const run = (d: KeteReviewMode.Deps, input: KeteReviewMode.Input) => Effect.runPromiseExit(KeteReviewMode.execute(d, input))

const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return JSON.stringify(exit)
}

describe("review tool", () => {
  test("records the vector's review (side made explicit)", async () => {
    const d = deps()
    const exit = await run(d.value, vector.result.review)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(d.recorded).toEqual([vector.result.review])
    if (Exit.isSuccess(exit)) expect(exit.value.output).toEqual({ status: "recorded", findings: 2 })
  })

  test("a later call replaces the record; an empty review is fine", async () => {
    const d = deps()
    await run(d.value, vector.result.review)
    const exit = await run(d.value, { summary: "Nothing to report.", findings: [] })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(d.recorded.at(-1)).toEqual({ version: 1, summary: "Nothing to report.", findings: [] })
  })

  test("refuses what the contract refuses, records nothing", async () => {
    const finding = { path: "a.ts", line: 1, severity: "info" as const, body: "x" }
    const cases: Array<[KeteReviewMode.Input, string]> = [
      [{ summary: "s", findings: [{ ...finding, path: "../etc/passwd" }] }, "findings[0].path"],
      [{ summary: "s", findings: [{ ...finding, line: 0 }] }, "findings[0].line"],
      [{ summary: "s", findings: [{ ...finding, line: 1.5 }] }, "findings[0].line"],
      [{ summary: "s", findings: [{ ...finding, body: "" }] }, "findings[0].body"],
      [{ summary: "s", findings: [{ ...finding, title: "t".repeat(201) }] }, "findings[0].title"],
      [{ summary: "s".repeat(4001), findings: [] }, "summary"],
      [{ summary: "s", findings: Array.from({ length: 51 }, () => finding) }, "findings: at most"],
    ]
    for (const [input, issue] of cases) {
      const d = deps()
      const message = failureMessage(await run(d.value, input))
      expect(message).toContain(issue)
      expect(d.recorded).toEqual([])
    }
  })

  test("the spec's max_findings caps the review", async () => {
    const d = deps({ spec: { ...spec, max_findings: 1 } })
    const message = failureMessage(await run(d.value, vector.result.review))
    expect(message).toContain("findings: at most 1")
    expect(d.recorded).toEqual([])
  })

  test("a RIGHT-side path must exist at the head; LEFT is not checked", async () => {
    const seen: string[] = []
    const d = deps({ exists: (p) => Effect.sync(() => (seen.push(p), p === "src/cart.ts")) })
    expect(Exit.isSuccess(await run(d.value, vector.result.review))).toBe(true)
    expect(seen).toEqual(["src/cart.ts"])
    const missing = deps({ exists: () => Effect.succeed(false) })
    const message = failureMessage(await run(missing.value, vector.result.review))
    expect(message).toContain("findings[0].path: no such file")
    expect(missing.recorded).toEqual([])
  })

  test("a failed record fails the call", async () => {
    const d = deps({ record: async () => Promise.reject(new Error("disk full")) })
    expect(failureMessage(await run(d.value, vector.result.review))).toContain("could not be recorded")
  })
})

describe("review mode rules", () => {
  const evaluation = (action: string, effect: "allow" | "ask" | "deny" = "allow"): PermissionEvaluation =>
    ({ sessionID: "ses_1", action, resources: ["*"], effect }) as unknown as PermissionEvaluation

  test("every action but read is denied", () => {
    const read = evaluation("read")
    KeteReviewMode.applyPermission(read)
    expect(read.effect).toBe("allow")
    for (const action of ["edit", "shell", "external_directory", "webfetch", "websearch", "subagent", "skill", "mcp:x.y", "question"]) {
      for (const effect of ["allow", "ask"] as const) {
        const event = evaluation(action, effect)
        KeteReviewMode.applyPermission(event)
        expect({ action, effect: event.effect }).toEqual({ action, effect: "deny" })
        expect(event.message).toBe(KeteReviewMode.permissionRefusal)
      }
    }
  })

  test("only read and review stay in a request's tools", () => {
    const tools: Record<string, unknown> = Object.fromEntries(
      ["read", "review", "edit", "write", "patch", "shell", "grep", "glob", "webfetch", "subagent", "workflow", "orchestrate", "mcp_x"].map((n) => [n, {}]),
    )
    KeteReviewMode.filterTools(tools)
    expect(Object.keys(tools).sort()).toEqual(["read", "review"])
  })

  test("the instructions say untrusted, line anchoring, severities and no verdict", () => {
    const text = KeteReviewMode.systemPrompt(spec)
    expect(text).toContain("pull request #42")
    expect(text).toContain("comes from a fork")
    expect(text).toContain("at most 50 findings")
    for (const severity of ["critical", "major", "minor", "info"]) expect(text).toContain(`\`${severity}\``)
    expect(text).toContain("Don't approve or request changes")
    expect(KeteReviewMode.systemPrompt({ ...spec, untrusted: false })).not.toContain("comes from a fork")
  })
})

describe("review mode: install", () => {
  function recordingHost() {
    const tools: string[] = []
    const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
    const ctx: Plugin.Context = host({
      tool: {
        transform: (callback: any) =>
          Effect.sync(() => {
            callback({ add: (tool: { name: string }) => tools.push(tool.name) })
            return { dispose: Effect.void }
          }),
        reload: () => Effect.void,
        list: () => Effect.die("unused"),
        hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(`tool.${name}`, handler))) as any,
      } as any,
      permission: { hook: (name: string, handler: any) => Effect.sync(() => void hooks.set(`permission.${name}`, handler)) } as any,
      session: { hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(`session.${name}`, handler))) as any },
    })
    return { ctx, tools, hooks }
  }
  const environment = Environment.Service.of({ files: {} as any, spawner: undefined as any })
  const install = (ctx: Plugin.Context, review?: KeteReview.Spec) =>
    Effect.runPromise(
      Effect.scoped(KeteReviewMode.install(ctx, review ? { review, record: async () => {} } : {})).pipe(
        Effect.provideService(Environment.Service, environment),
      ),
    )

  test("a review job gets the tool, the gates and the instructions", async () => {
    const h = recordingHost()
    await install(h.ctx, spec)
    expect(h.tools).toEqual(["review"])
    expect([...h.hooks.keys()].sort()).toEqual([
      "permission.evaluate",
      "session.compaction",
      "session.context",
      "session.generate",
      "tool.execute.before",
    ])
    const before = h.hooks.get("tool.execute.before")!
    for (const tool of ["shell", "edit", "write", "patch", "grep", "glob", "webfetch", "websearch", "subagent", "skill", "workflow"]) {
      const exit = await Effect.runPromiseExit(before({ tool }))
      expect({ tool, failed: Exit.isFailure(exit) }).toEqual({ tool, failed: true })
    }
    for (const tool of ["read", "review"]) expect(Exit.isSuccess(await Effect.runPromiseExit(before({ tool })))).toBe(true)
    const context = { tools: { read: {}, review: {}, shell: {}, edit: {} }, system: [] as Array<{ type: string; text: string }> }
    await Effect.runPromise(h.hooks.get("session.context")!(context))
    expect(Object.keys(context.tools).sort()).toEqual(["read", "review"])
    expect(context.system[0]?.text).toContain("You are reviewing pull request #42")
  })

  test("any other job gets nothing", async () => {
    const none = recordingHost()
    await install(none.ctx)
    expect(none.tools).toEqual([])
    expect(none.hooks.size).toBe(0)
  })
})
