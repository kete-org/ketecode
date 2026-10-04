import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode/util/kete/brand"
import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import path from "path"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { KeteSubagents } from "@opencode/core/kete/subagents"
import { KeteWorkflows } from "@opencode/core/kete/workflows"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "../fixture/tmpdir"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "../lib/tool"

const childText = "child final response"
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

// What the fake execution was asked to do, per test run.
const calls = { interrupted: [] as Session.ID[], woken: [] as Session.ID[] }

// Children whose title contains "hold" keep running until they are stopped; others answer at once.
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("KeteSubagentsTest.complete")(function* (sessionID: Session.ID) {
        if ((yield* store.get(sessionID))?.title?.includes("hold")) return yield* Effect.never
        if (completed.has(sessionID)) return
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: childText })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: (sessionID) => Effect.sync(() => void calls.woken.push(sessionID)),
        interrupt: (sessionID) => Effect.sync(() => (calls.interrupted.push(sessionID), true)),
        awaitIdle: () => Effect.void,
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const plugins = makeLocationNode({
  name: "test/kete-subagents-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* KeteSubagents.Plugin.effect()
      yield* registerToolPlugin(KeteWorkflows.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Location.node,
    Bus.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    Tool.node,
    PluginHooks.node,
  ],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Job.node, Session.node, SessionExecution.node, LocationServiceMap.node]),
    [
      SessionExecution.node.replace(executionNode),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(plugins),
    ],
  ),
)

/** A parent session in a temporary directory whose config has `kete.subagents` set to `settings`. */
const setup = (settings: Record<string, unknown>, kete: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    calls.interrupted = []
    calls.woken = []
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(dir.path, Brand.configFiles[0]), JSON.stringify({ kete: { subagents: settings, ...kete } })),
    )
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }) })
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(parent.location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
      }),
    ).pipe(Effect.provide(locations.get(parent.location)))
    const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
    const run = (id: string, input: Record<string, unknown>) =>
      executeTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: { type: "tool-call", id, name: SubagentTool.name, input: { agent: "reviewer", ...input } },
      })
    /** Calls the workflow tool as the parent's agent. */
    const workflow = (id: string, input: Record<string, unknown>) =>
      executeTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: { type: "tool-call", id, name: KeteWorkflows.name, input },
      })
    return { sessions, parent, run, workflow }
  })

/** Waits for `check` to hold, polling briefly; fails the test when it never does. */
const eventually = <E>(check: () => Effect.Effect<boolean, E>) =>
  check().pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced(Duration.millis(10)) }),
    Effect.timeout(Duration.seconds(5)),
  )

describe("KeteSubagents.limits", () => {
  test("defaults to a 60 minute timeout and 4 concurrent subagents", () => {
    expect(KeteSubagents.limits(undefined)).toEqual({ timeout: Duration.minutes(60), maxConcurrent: 4 })
  })

  test("a timeout of 0 means no limit", () => {
    expect(KeteSubagents.limits({ timeout: 0, max_concurrent: 2 })).toEqual({ timeout: undefined, maxConcurrent: 2 })
  })
})

describe("KeteSubagents.count", () => {
  const a = Session.ID.make("ses_a")
  const b = Session.ID.make("ses_b")

  test("counts running children and places held for starts in flight", () => {
    expect(KeteSubagents.count({ running: [a], held: [{}, {}] })).toBe(3)
  })

  test("counts a place bound to a running child once", () => {
    expect(KeteSubagents.count({ running: [a], held: [{ child: a }, { child: b }] })).toBe(2)
  })

  test("leaves out the child being continued", () => {
    expect(KeteSubagents.count({ running: [a, b], held: [], exclude: a })).toBe(1)
  })
})

describe("KeteSubagents", () => {
  it.live("refuses a subagent past kete.subagents.max_concurrent, but continues a running one", () =>
    Effect.gen(function* () {
      const { sessions, parent, run } = yield* setup({ max_concurrent: 1 })
      const child = yield* sessions.create({ parentID: parent.id, title: "hold", agent: Agent.ID.make("reviewer") })
      const jobs = yield* Job.Service
      yield* jobs.start({ id: child.id, type: SubagentTool.name, run: Effect.never })

      const refused = yield* run("call-over-limit", { description: "second", prompt: "review" })
      expect(refused).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: expect.stringContaining('"kete.subagents.max_concurrent" is 1') },
      })
      expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)

      const continued = yield* run("call-continue", {
        description: "follow up",
        prompt: "continue",
        sessionID: child.id,
        background: true,
      })
      expect(continued).toMatchObject({ status: "completed", metadata: { sessionID: child.id, status: "running" } })

      yield* jobs.cancel(child.id)
      const next = yield* run("call-after", { description: "third", prompt: "review" })
      expect(next).toMatchObject({ status: "completed", metadata: { status: "completed" } })
    }),
  )

  it.live("refuses parallel calls in one turn past the limit", () =>
    Effect.gen(function* () {
      const { run } = yield* setup({ max_concurrent: 2 })
      const results = yield* Effect.all(
        [1, 2, 3].map((n) =>
          run(`call-parallel-${n}`, { description: `hold ${n}`, prompt: "review", background: true }),
        ),
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result.status === "completed")).toHaveLength(2)
      expect(results.filter((result) => result.status === "error")).toHaveLength(1)
      const jobs = yield* Job.Service
      yield* Effect.forEach(results, (result) =>
        result.status === "completed" ? jobs.cancel(outputSessionID(result.metadata)) : Effect.void,
      )
    }),
  )

  it.live("fails a subagent that runs past kete.subagents.timeout and stops it", () =>
    Effect.gen(function* () {
      // 0.002 minutes is 120 ms.
      const { sessions, parent, run } = yield* setup({ timeout: 0.002 })
      const result = yield* run("call-timeout", { description: "hold review", prompt: "review" })
      expect(result).toMatchObject({
        status: "error",
        error: {
          type: "tool.execution",
          message: expect.stringContaining("Subagent stopped after running for 0.002 minutes"),
        },
      })
      const [child] = (yield* sessions.list({ parentID: parent.id })).data
      expect(child).toBeDefined()
      yield* eventually(() => Effect.sync(() => calls.interrupted.includes(child!.id)))
      expect((yield* (yield* Job.Service).get(child!.id))?.status).toBe("error")
    }),
  )

  it.live("stopping a session stops its background subagents without restarting it", () =>
    Effect.gen(function* () {
      const { sessions, parent, run } = yield* setup({})
      const started = yield* run("call-background", { description: "hold review", prompt: "review", background: true })
      expect(started).toMatchObject({ status: "completed", metadata: { status: "running" } })
      const childID = outputSessionID(started.metadata)
      const jobs = yield* Job.Service
      expect((yield* jobs.get(childID))?.status).toBe("running")

      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: parent.id, reason: "user" })

      yield* eventually(() => jobs.get(childID).pipe(Effect.map((job) => job?.status === "cancelled")))
      expect(calls.interrupted).toContain(childID)
      // The cancelled child's notice reaches the parent's inbox without waking it.
      yield* eventually(() =>
        sessions
          .inbox(parent.id)
          .pipe(
            Effect.map((items) =>
              items.some((item) => item.type === "synthetic" && item.payload.text.includes('state="cancelled"')),
            ),
          ),
      )
      expect(calls.woken).not.toContain(parent.id)
    }),
  )

  it.live("slash-command subtasks get the subagent tool's depth and permission checks", () =>
    Effect.gen(function* () {
      const { sessions, parent } = yield* setup({})
      const locations = yield* LocationServiceMap.Service
      const check = yield* KeteSubagents.subtaskCheck.pipe(Effect.provide(locations.get(parent.location)))
      yield* check(parent.id, "reviewer")

      // A subtask from a subagent session would nest past experimental.subagent_depth (1).
      const child = yield* sessions.create({ parentID: parent.id, title: "child" })
      const nested = yield* check(child.id, "reviewer").pipe(Effect.flip)
      expect(nested.message).toContain("Subagent depth limit reached (1)")

      // The parent's agent is denied starting this subagent.
      yield* sessions.setPermissions({
        sessionID: parent.id,
        permissions: [{ action: "subagent", resource: "reviewer", effect: "deny" }],
      })
      const denied = yield* check(parent.id, "reviewer").pipe(Effect.flip)
      expect(denied.message).toContain("may not start reviewer as a subagent")
    }),
  )

  it.live("gives a background subagent recovered after a restart a timeout", () =>
    Effect.gen(function* () {
      const { sessions, parent } = yield* setup({ timeout: 0.002 })
      const child = yield* sessions.create({ parentID: parent.id, title: "hold recovered" })
      const jobs = yield* Job.Service
      // What SessionRestart does for a background subagent: a running job, without `bound`.
      const recovery = {
        kind: "subagent" as const,
        parentSessionID: parent.id,
        childSessionID: child.id,
        agent: "reviewer",
        description: "recovered review",
      }
      yield* jobs.start({ id: child.id, type: SubagentTool.name, recovery, run: Effect.never })
      yield* jobs.background(child.id)

      // The location's plugins activate after the restart.
      const locations = yield* LocationServiceMap.Service
      yield* KeteSubagents.Plugin.effect().pipe(Effect.provide(locations.get(parent.location)))

      yield* eventually(() => jobs.get(child.id).pipe(Effect.map((job) => job?.status === "cancelled")))
      expect(calls.interrupted).toContain(child.id)
      const notice = (yield* sessions.inbox(parent.id)).find(
        (item) => item.type === "synthetic" && item.payload.text.includes('state="error"'),
      )
      expect(notice?.type === "synthetic" ? notice.payload.text : "").toContain("Subagent stopped after running")
    }),
  )

  it.live("has no workflow tool while no workflows are configured", () =>
    Effect.gen(function* () {
      const { workflow } = yield* setup({})
      expect(yield* workflow("call-none", { name: "any", input: "" })).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining('No tool named "workflow"') },
      })
    }),
  )

  it.live("runs a workflow's steps as subagents, feeding one step's answer to the next", () =>
    Effect.gen(function* () {
      const { sessions, parent, workflow } = yield* setup(
        {},
        {
          workflows: {
            review: {
              description: "Analyze, then review",
              steps: [
                { id: "analyze", agent: "reviewer", prompt: "Analyze {{input}}" },
                { id: "check", agent: "reviewer", after: ["analyze"], prompt: "Check against: {{steps.analyze}}" },
              ],
            },
            broken: { steps: [{ id: "a", agent: "reviewer", prompt: "{{steps.b}}" }] },
          },
        },
      )
      const result = yield* workflow("call-workflow", { name: "review", input: "the login form" })
      expect(result).toMatchObject({
        status: "completed",
        output: {
          state: "completed",
          steps: [
            { id: "analyze", state: "completed" },
            { id: "check", state: "completed" },
          ],
        },
      })

      const children = (yield* sessions.list({ parentID: parent.id })).data
      expect(children.map((child) => child.title).sort()).toEqual(["review: analyze", "review: check"])
      const prompt = (title: string) =>
        Effect.gen(function* () {
          const child = children.find((item) => item.title === title)!
          const item = (yield* sessions.inbox(child.id)).find((entry) => entry.type === "user")
          return item?.type === "user" ? item.payload.text : ""
        })
      expect(yield* prompt("review: analyze")).toContain("Analyze the login form")
      expect(yield* prompt("review: check")).toContain(`Check against: ${childText}`)

      // Unknown and invalid workflows fail with the reason.
      expect(yield* workflow("call-missing", { name: "nope", input: "" })).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining('No workflow named "nope"') },
      })
      expect(yield* workflow("call-broken", { name: "broken", input: "" })).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("doesn't come after") },
      })
    }),
  )

  it.live("leaves subagents running when a session is stopped for shutdown", () =>
    Effect.gen(function* () {
      const { parent, run } = yield* setup({})
      const started = yield* run("call-shutdown", { description: "hold review", prompt: "review", background: true })
      const childID = outputSessionID(started.metadata)
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: parent.id, reason: "shutdown" })
      yield* Effect.sleep(Duration.millis(100))
      const jobs = yield* Job.Service
      expect((yield* jobs.get(childID))?.status).toBe("running")
      expect(calls.interrupted).not.toContain(childID)
      yield* jobs.cancel(childID)
    }),
  )
})
