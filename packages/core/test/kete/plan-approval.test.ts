import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { KetePlanApproval } from "@opencode/core/kete/plan-approval"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { host } from "../plugin/host"

type Info = { id: string; parentID?: string; agent?: string; metadata?: Record<string, unknown> }
type Reply = KetePlanApproval.Reply

async function setup(options: {
  sessions: Info[]
  reply?: Reply | ((sessions: Map<string, Info>) => Effect.Effect<Reply>)
  defaultAgent?: string
  agents?: string[]
  denyQuestion?: boolean
}) {
  const sessions = new Map(options.sessions.map((info) => [info.id, structuredClone(info)]))
  const tools: any[] = []
  const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
  const asked: Array<{ sessionID: string; plan: string }> = []
  const switched: Array<{ sessionID: string; agent: string }> = []
  const asserted: string[] = []
  const ctx = host({
    tool: {
      transform: (callback: any) =>
        Effect.sync(() => {
          callback({ add: (tool: unknown) => tools.push(tool) })
          return { dispose: Effect.void }
        }),
    } as any,
    session: { hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(name, handler))) as any },
  })
  const known = new Set(options.agents ?? ["build", "plan"])
  const layer = Layer.mergeAll(
    Layer.succeed(
      Session.Service,
      Session.Service.of({
        get: (id: string) =>
          Effect.suspend(() => {
            const info = sessions.get(id)
            return info ? Effect.succeed(info as never) : Effect.fail(new Error(`no session ${id}`) as never)
          }),
        setMetadata: (input: { sessionID: string; metadata: Record<string, unknown> }) =>
          Effect.sync(() => void (sessions.get(input.sessionID)!.metadata = input.metadata)),
        switchAgent: (input: { sessionID: string; agent: string }) =>
          Effect.sync(() => {
            switched.push(input)
            sessions.get(input.sessionID)!.agent = input.agent
          }),
      } as never),
    ),
    Layer.succeed(
      Agent.Service,
      Agent.Service.of({
        select: () => Effect.succeed({ id: options.defaultAgent ?? "build" } as never),
        get: (id: string) => Effect.succeed((known.has(id) ? { id } : undefined) as never),
      } as never),
    ),
    Layer.succeed(
      Permission.Service,
      Permission.Service.of({
        assert: (input: { action: string }) =>
          Effect.suspend(() => {
            asserted.push(input.action)
            return options.denyQuestion ? Effect.fail(new Permission.DeclinedError() as never) : Effect.void
          }),
      } as never),
    ),
  )
  const plugin = KetePlanApproval.make({
    ask: (input) =>
      Effect.suspend(() => {
        asked.push({ sessionID: input.sessionID, plan: input.plan })
        const reply = options.reply ?? { kind: "cancelled" as const }
        return typeof reply === "function" ? reply(sessions) : Effect.succeed(reply)
      }),
  })
  await Effect.runPromise(Effect.scoped(plugin.effect(ctx)).pipe(Effect.provide(layer)))
  const tool = tools.find((item) => item.name === KetePlanApproval.name)
  const present = (plan: string, sessionID = "ses_root") =>
    Effect.runPromiseExit(tool.execute({ plan }, { sessionID, agent: "plan", messageID: "msg_1", id: "call_1" }))
  const context = async (sessionID = "ses_root") => {
    const event: any = { sessionID, system: [], tools: { [KetePlanApproval.name]: {}, read: {} } }
    await Effect.runPromise(hooks.get("context")!(event))
    return { tools: Object.keys(event.tools), system: event.system.map((part: { text: string }) => part.text) }
  }
  return { sessions, asked, switched, asserted, present, context, tool, hooks }
}

const plan = (mode?: string, extra: Partial<Info> = {}): Info => ({
  id: "ses_root",
  agent: "plan",
  metadata: { other: 1, ...(mode ? { "kete.permissionMode": mode } : {}) },
  ...extra,
})
const answer = (decision: KetePlanApproval.Decision, feedback?: string): Reply => ({
  kind: "answer",
  answer: { decision, ...(feedback ? { feedback } : {}) },
})
const text = (exit: Exit.Exit<any, any>) =>
  Exit.isSuccess(exit) ? exit.value.content.map((part: { text: string }) => part.text).join("") : JSON.stringify(exit)
const mode = (h: { sessions: Map<string, Info> }) => h.sessions.get("ses_root")!.metadata!["kete.permissionMode"]

describe("KetePlanApproval", () => {
  test("AC1: offered with its reminder only to a root session in Plan mode", async () => {
    const h = await setup({ sessions: [plan("plan"), { id: "ses_sub", parentID: "ses_root" }, { id: "ses_other", metadata: { "kete.permissionMode": "default" } }] })
    expect(h.tool.options).toEqual({ codemode: false })
    const root = await h.context()
    expect(root.tools).toContain(KetePlanApproval.name)
    expect(root.system).toEqual([KetePlanApproval.reminder])
    for (const id of ["ses_sub", "ses_other"]) expect(await h.context(id)).toEqual({ tools: ["read"], system: [] })
  })

  test("AC2: approve and accept edits: the mode changes (other metadata kept) and the plan agent switches to the default", async () => {
    const h = await setup({ sessions: [plan("plan")], reply: answer("accept-edits") })
    const exit = await h.present("1. Edit a.ts\n2. Run the tests")
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.asserted).toEqual(["question"])
    expect(h.asked).toEqual([{ sessionID: "ses_root", plan: "1. Edit a.ts\n2. Run the tests" }])
    expect(h.sessions.get("ses_root")!.metadata).toEqual({ other: 1, "kete.permissionMode": "accept-edits" })
    expect(h.switched).toEqual([{ sessionID: "ses_root", agent: "build" }])
    expect(text(exit)).toContain("The user approved the plan")
    expect((exit as Exit.Success<any, any>).value.output).toEqual({ approved: true, mode: "accept-edits" })
    expect((await h.context()).tools).toEqual(["read"])
  })

  test("AC3: approve with the default checks; another agent is kept; a session on the default plan agent switches too", async () => {
    const h = await setup({ sessions: [plan("plan", { agent: "build" })], reply: answer("default") })
    expect(Exit.isSuccess(await h.present("plan"))).toBe(true)
    expect(mode(h)).toBe("default")
    expect(h.switched).toEqual([])
    // No agent on the session and `plan` as the default agent: it still leaves the Plan agent, for build.
    const planDefault = await setup({ sessions: [plan("plan", { agent: undefined })], reply: answer("default"), defaultAgent: "plan" })
    expect(Exit.isSuccess(await planDefault.present("plan"))).toBe(true)
    expect(planDefault.switched).toEqual([{ sessionID: "ses_root", agent: "build" }])
    // ...unless there's no build agent: then nothing changes and the user is told.
    const noBuild = await setup({ sessions: [plan("plan")], reply: answer("default"), defaultAgent: "plan", agents: ["plan"] })
    expect(text(await noBuild.present("plan"))).toContain("no build agent")
    expect(mode(noBuild)).toBe("plan")
  })

  test("AC4: keep planning changes nothing and returns the feedback; the user's own words count as feedback", async () => {
    const revise = await setup({ sessions: [plan("plan")], reply: answer("revise", "Add a migration step") })
    const exit = await revise.present("plan")
    expect(text(exit)).toContain("Add a migration step")
    expect((exit as Exit.Success<any, any>).value.output).toEqual({ approved: false, mode: "plan", feedback: "Add a migration step" })
    expect(mode(revise)).toBe("plan")
    expect(revise.switched).toEqual([])
    expect(KetePlanApproval.decide(KetePlanApproval.LABELS["accept-edits"])).toEqual({ decision: "accept-edits" })
    expect(KetePlanApproval.decide([KetePlanApproval.LABELS.default])).toEqual({ decision: "default" })
    expect(KetePlanApproval.decide(KetePlanApproval.LABELS.revise)).toEqual({ decision: "revise" })
    expect(KetePlanApproval.decide("  split step 2  ")).toEqual({ decision: "revise", feedback: "split step 2" })
    expect(KetePlanApproval.decide(undefined)).toEqual({ decision: "revise" })
  })

  test("a dismissed question ends the step; one dismissed with a message (kete run) is feedback", async () => {
    const dismissed = await setup({ sessions: [plan("plan")] })
    const exit = await dismissed.present("plan")
    expect(Exit.isFailure(exit) && Cause.hasDies((exit as Exit.Failure<any, any>).cause)).toBe(true)
    expect(mode(dismissed)).toBe("plan")
    const noninteractive = await setup({ sessions: [plan("plan")], reply: { kind: "cancelled", message: "kete run can't ask questions." } })
    const failed = await noninteractive.present("plan")
    expect(Exit.isFailure(failed)).toBe(true)
    expect(text(failed)).toContain("kete run can't ask questions.")
    expect(mode(noninteractive)).toBe("plan")
  })

  test("AC5: refused outside Plan mode, in a subagent or an unattended run, without asking; empty or over-long plans fail", async () => {
    const h = await setup({
      sessions: [
        plan("default", { id: "ses_default" }),
        { id: "ses_root", metadata: { "kete.permissionMode": "plan" } },
        { id: "ses_sub", parentID: "ses_root", agent: "plan" },
        { id: "ses_job", metadata: { "kete.permissionMode": "plan", "kete.unattended": {} } },
      ],
      reply: answer("accept-edits"),
    })
    for (const id of ["ses_default", "ses_sub", "ses_job"]) expect(text(await h.present("plan", id))).toContain("only available in Plan mode")
    expect(Exit.isFailure(await h.present("   "))).toBe(true)
    expect(text(await h.present("x".repeat(KetePlanApproval.MAX_PLAN + 1)))).toContain("longer than")
    expect(h.asked).toEqual([])
    expect(mode(h)).toBe("plan")
    const denied = await setup({ sessions: [plan("plan")], reply: answer("accept-edits"), denyQuestion: true })
    expect(text(await denied.present("plan"))).toContain("Permission denied: question")
    expect(denied.asked).toEqual([])
  })

  test("an answer after the user left Plan mode changes nothing", async () => {
    const h = await setup({
      sessions: [plan("plan")],
      reply: (sessions) =>
        Effect.sync(() => {
          sessions.get("ses_root")!.metadata = { "kete.permissionMode": "ask" }
          return answer("accept-edits")
        }),
    })
    expect(text(await h.present("plan"))).toContain("isn't in Plan mode any more")
    expect(mode(h)).toBe("ask")
    expect(h.switched).toEqual([])
  })

  test("only one plan question is open per session", async () => {
    const gate = Effect.runSync(Deferred.make<Reply>())
    const h = await setup({ sessions: [plan("plan")], reply: () => Deferred.await(gate) })
    const first = h.present("plan one")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(text(await h.present("plan two"))).toContain("already waiting")
    Effect.runSync(Deferred.succeed(gate, answer("default")))
    expect(Exit.isSuccess(await first)).toBe(true)
    expect(h.asked).toHaveLength(1)
  })

  test("summaries and generate requests never get the tool", async () => {
    const h = await setup({ sessions: [plan("plan")] })
    for (const hook of ["compaction", "generate"]) {
      const event: any = { sessionID: "ses_root", system: [], tools: { [KetePlanApproval.name]: {}, read: {} } }
      await Effect.runPromise(h.hooks.get(hook)!(event))
      expect(Object.keys(event.tools)).toEqual(["read"])
    }
  })
})
