import { describe, expect, test } from "bun:test"
import type { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { eventType, fetchTodos, fromEvent, summary } from "./todo"

const todos: KeteTodoRpc.Item[] = [
  { content: "Run the build", status: "completed" },
  { content: "Fix the type errors", status: "in_progress", priority: "high" },
  { content: "Run the tests", status: "pending" },
]

describe("web task list data", () => {
  test("fetches the session's list through the kete.todo RPC", async () => {
    const calls: unknown[] = []
    const client = {
      rpc: {
        call: async (input: unknown) => {
          calls.push(input)
          return { output: { sessionID: "ses_1", todos } }
        },
      },
    }
    expect(await fetchTodos(client as never, "ses_1", { directory: "/w" } as never)).toEqual(todos)
    expect(calls).toEqual([{ rpcID: "kete.todo", method: "get", input: { sessionID: "ses_1" }, location: { directory: "/w" } }])
  })

  test("a reply that doesn't match the schema shows nothing", async () => {
    const client = { rpc: { call: async () => ({ output: { sessionID: "ses_1", todos: [{ status: "pending" }] } }) } }
    expect(await fetchTodos(client as never, "ses_1", undefined)).toEqual([])
  })

  test("events update only their own session", () => {
    const event = { type: eventType, data: { sessionID: "ses_1", todos } }
    expect(eventType).toBe("rpc.kete.todo.updated")
    expect(fromEvent(event, "ses_1")).toEqual(todos)
    expect(fromEvent(event, "ses_2")).toBeUndefined()
    expect(fromEvent({ type: "session.idle" }, "ses_1")).toBeUndefined()
  })

  test("the progress summary", () => {
    expect(summary(todos)).toBe("1 of 3 done")
    expect(summary([{ content: "a", status: "completed" }])).toBe("All 1 done")
  })
})
