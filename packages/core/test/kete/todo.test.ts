// The session task list (core/src/kete/todo.ts): the `todowrite` tool validates and stores the
// whole list per session, announces it, serves it through the `kete.todo` RPC, survives a new
// plugin instance (a restart), is removed with its session, and adds its short guidance only when
// the tool is offered. Plan mode lets it through.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Queue, Scope, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteTodo } from "@opencode/core/kete/todo"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { Permission } from "@opencode/core/permission"
import { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { host } from "../plugin/host"

type Tool = { name: string; execute: (input: unknown, context: unknown) => Effect.Effect<any, any> }

function harness(store = new Map<string, unknown>(), options: { deny?: boolean } = {}) {
  const tools: Tool[] = []
  const emitted: Array<{ name: string; data: unknown }> = []
  const asserted: string[] = []
  let handlers: Record<string, (input: any) => Effect.Effect<any, any>> = {}
  const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
  const events = Effect.runSync(Queue.unbounded<{ type: string; data: unknown }>())
  const ctx: Plugin.Context = host({
    storage: {
      get: (key: string) => Effect.sync(() => store.get(key) as any),
      set: (key: string, value: unknown) => Effect.sync(() => void store.set(key, value)),
      remove: (key: string) => Effect.sync(() => void store.delete(key)),
      scan: () => Effect.die("unused"),
    },
    rpc: Object.assign(() => Effect.die("unused"), {
      register: (_definition: unknown, given: any) =>
        Effect.sync(() => {
          handlers = given
          return {
            dispose: Effect.void,
            events: { emit: (name: string, data: unknown) => Effect.sync(() => void emitted.push({ name, data })) },
          }
        }),
    }) as any,
    tool: {
      transform: (callback: any) =>
        Effect.sync(() => {
          callback({ add: (tool: Tool) => tools.push(tool) })
          return { dispose: Effect.void }
        }),
    } as any,
    session: { hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(name, handler))) as any },
    event: { subscribe: () => Stream.fromQueue(events) as any },
  })
  const permission = Permission.Service.of({
    assert: (input: { action: string }) =>
      Effect.suspend(() => {
        asserted.push(input.action)
        return options.deny ? Effect.fail(new Permission.DeclinedError() as any) : Effect.void
      }),
  } as any)
  return { ctx, tools, emitted, asserted, hooks, events, store, permission, handlers: () => handlers }
}

async function start(h: ReturnType<typeof harness>) {
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    KeteTodo.Plugin.effect(h.ctx).pipe(Effect.provideService(Permission.Service, h.permission), Scope.provide(scope)),
  )
  return scope
}

const context = (sessionID = "ses_1") => ({ sessionID, agent: "build", messageID: "msg_1", id: "call_1" })
const list: KeteTodoRpc.Item[] = [
  { content: "Run the build", status: "completed" },
  { content: "Fix the type errors", status: "in_progress", priority: "high" },
  { content: "Run the tests", status: "pending" },
]

describe("todowrite", () => {
  test("stores the list per session, announces it and answers with a checklist", async () => {
    const h = harness()
    await start(h)
    expect(h.tools.map((tool) => tool.name)).toEqual(["todowrite"])
    const result = await Effect.runPromise(h.tools[0]!.execute({ todos: list }, context()))
    expect(result.output).toEqual({ todos: list })
    expect(result.content).toBe(
      "Todo list updated (1/3 completed):\n[x] Run the build\n[>] Fix the type errors\n[ ] Run the tests",
    )
    expect(h.asserted).toEqual(["todowrite"])
    expect(h.emitted).toEqual([{ name: "updated", data: { sessionID: "ses_1", todos: list } }])
    expect(KeteTodo.stored(h.store.get(KeteTodo.key("ses_1")))).toEqual(list)
    expect(h.store.has(KeteTodo.key("ses_2"))).toBe(false)
  })

  test("refuses two items in progress and stores nothing", async () => {
    const h = harness()
    await start(h)
    const exit = await Effect.runPromiseExit(
      h.tools[0]!.execute(
        {
          todos: [
            { content: "a", status: "in_progress" },
            { content: "b", status: "in_progress" },
          ],
        },
        context(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("Only one todo may be in_progress")
    expect(h.store.size).toBe(0)
    expect(h.emitted).toEqual([])
  })

  test("a denied permission stores nothing", async () => {
    const h = harness(new Map(), { deny: true })
    await start(h)
    const exit = await Effect.runPromiseExit(h.tools[0]!.execute({ todos: list }, context()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.store.size).toBe(0)
  })

  test("the schema bounds the list and each item", () => {
    const valid = (todos: unknown) => KeteTodo.stored({ todos }) !== undefined
    expect(valid(list)).toBe(true)
    expect(valid([{ content: "", status: "pending" }])).toBe(false)
    expect(valid([{ content: "x".repeat(KeteTodoRpc.MAX_CONTENT + 1), status: "pending" }])).toBe(false)
    expect(valid([{ content: "x", status: "done" }])).toBe(false)
    expect(valid(Array.from({ length: KeteTodoRpc.MAX_ITEMS + 1 }, () => ({ content: "x", status: "pending" })))).toBe(false)
    expect(KeteTodo.stored("garbage")).toBeUndefined()
  })

  test("an empty list clears it; all done says so", () => {
    expect(KeteTodo.modelContent([])).toBe("Todo list cleared.")
    expect(KeteTodo.modelContent([{ content: "a", status: "completed" }])).toContain("All todos are completed.")
    expect(KeteTodoRpc.finished([{ content: "a", status: "completed" }])).toBe(true)
    expect(KeteTodoRpc.finished([])).toBe(false)
    expect(KeteTodoRpc.progress(list)).toEqual({ total: 3, completed: 1, current: list[1] })
  })
})

describe("kete.todo RPC and lifecycle", () => {
  test("get returns the stored list, also from a new plugin instance (restart)", async () => {
    const store = new Map<string, unknown>()
    const first = harness(store)
    await start(first)
    await Effect.runPromise(first.tools[0]!.execute({ todos: list }, context()))
    const second = harness(store)
    await start(second)
    expect(await Effect.runPromise(second.handlers().get!({ sessionID: "ses_1" }))).toEqual({ sessionID: "ses_1", todos: list })
    expect(await Effect.runPromise(second.handlers().get!({ sessionID: "ses_other" }))).toEqual({
      sessionID: "ses_other",
      todos: [],
    })
  })

  test("an unreadable stored value reads as an empty list", async () => {
    const h = harness(new Map([[KeteTodo.key("ses_1"), { todos: [{ content: 1 }] }]]))
    await start(h)
    expect(await Effect.runPromise(h.handlers().get!({ sessionID: "ses_1" }))).toEqual({ sessionID: "ses_1", todos: [] })
  })

  test("a deleted session's list is removed", async () => {
    const h = harness()
    await start(h)
    await Effect.runPromise(h.tools[0]!.execute({ todos: list }, context("ses_1")))
    await Effect.runPromise(h.tools[0]!.execute({ todos: list }, context("ses_2")))
    await Effect.runPromise(Queue.offer(h.events, { type: "session.deleted", data: { sessionID: "ses_1" } }))
    for (let i = 0; i < 50 && h.store.has(KeteTodo.key("ses_1")); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.store.has(KeteTodo.key("ses_1"))).toBe(false)
    expect(h.store.has(KeteTodo.key("ses_2"))).toBe(true)
  })

  test("the guidance is added only when the tool is offered", async () => {
    const h = harness()
    await start(h)
    const offered = { tools: { todowrite: {} }, system: [] as Array<{ type: string; text: string }> }
    await Effect.runPromise(h.hooks.get("context")!(offered))
    expect(offered.system).toEqual([{ type: "text", text: KeteTodo.guidance }])
    const hidden = { tools: { read: {} }, system: [] as Array<{ type: string; text: string }> }
    await Effect.runPromise(h.hooks.get("context")!(hidden))
    expect(hidden.system).toEqual([])
  })

  test("Plan mode lets the task list through", () => {
    expect(KetePermissionMode.planAllowed.has("todowrite")).toBe(true)
    const outcome = KetePermissionMode.decide({ mode: "plan", action: "todowrite", resources: [], unattended: false })
    expect(outcome.effect).toBe("allow")
  })
})
