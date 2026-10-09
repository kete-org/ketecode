/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import type { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { eventType, fetchTodos, footerLabel, fromEvent, TodoFooter, TodoSidebar } from "../../src/kete/todo"

const todos: KeteTodoRpc.Item[] = [
  { content: "Run the build", status: "completed" },
  { content: "Fix the type errors", status: "in_progress" },
  { content: "Run the tests", status: "pending" },
]

function context() {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { success: { base: color }, warning: { base: color }, error: { base: color } },
      },
    },
  } as unknown as Context
}

async function frame(view: () => unknown, width = 40) {
  const app = await testRender(() => <box width={width}>{view() as any}</box>, { width, height: 8 })
  await app.renderOnce()
  try {
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("TUI task list", () => {
  test("the sidebar lists every item with its state", async () => {
    const text = await frame(() => <TodoSidebar context={context()} todos={() => todos} />)
    expect(text).toContain("Todo 1/3")
    expect(text).toContain("✓ Run the build")
    expect(text).toContain("▶ Fix the type errors")
    expect(text).toContain("○ Run the tests")
  })

  test("the sidebar shows nothing for an empty list", async () => {
    const text = await frame(() => <TodoSidebar context={context()} todos={() => []} />)
    expect(text).not.toContain("Todo")
  })

  test("the footer shows progress and the current item while work is open", async () => {
    expect(footerLabel(todos)).toBe("Todo 1/3 · Fix the type errors")
    expect(footerLabel([{ content: "a", status: "pending" }])).toBe("Todo 0/1")
    expect(footerLabel([{ content: "a", status: "completed" }])).toBeUndefined()
    expect(footerLabel([])).toBeUndefined()
    const text = await frame(() => <TodoFooter context={context()} todos={() => todos} />, 60)
    expect(text).toContain("Todo 1/3 · Fix the type errors")
  })

  test("events update only their own session, and are checked against the schema", () => {
    const event = { type: eventType, data: { sessionID: "ses_1", todos } }
    expect(fromEvent(event, "ses_1")).toEqual(todos)
    expect(fromEvent(event, "ses_2")).toBeUndefined()
    expect(fromEvent({ type: "session.idle", data: {} }, "ses_1")).toBeUndefined()
    expect(fromEvent({ type: eventType, data: { sessionID: "ses_1", todos: [{ content: 3 }] } }, "ses_1")).toBeUndefined()
  })

  test("fetches the list through the kete.todo RPC", async () => {
    const calls: unknown[] = []
    const client = {
      rpc: {
        call: async (input: unknown) => {
          calls.push(input)
          return { output: { sessionID: "ses_1", todos } }
        },
      },
    }
    expect(await fetchTodos(client as any, "ses_1", { directory: "/w" } as any)).toEqual(todos)
    expect(calls).toEqual([{ rpcID: "kete.todo", method: "get", input: { sessionID: "ses_1" }, location: { directory: "/w" } }])
    const bad = { rpc: { call: async () => ({ output: { nope: true } }) } }
    expect(await fetchTodos(bad as any, "ses_1", undefined)).toEqual([])
  })
})
