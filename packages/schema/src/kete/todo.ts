// The session task list (core/src/kete/todo.ts): the items the agent keeps with the `todowrite`
// tool, and the `kete.todo` plugin RPC that clients (TUI, web UI, VS Code, JetBrains, SDK users)
// read it through. Served by the existing `POST /api/rpc/:rpcID/:method` and the event stream, so
// it needs no new HTTP endpoint. The item shape (`content`, `status`, `priority`) is the one
// upstream OpenCode's removed `todowrite` tool used, so upstream UI code that still recognises the
// tool name reads it the same way.

export * as KeteTodoRpc from "./todo.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

/** At most this many items in one list. */
export const MAX_ITEMS = 50
/** At most this many characters in one item. */
export const MAX_CONTENT = 500

export const Status = Schema.Literals(["pending", "in_progress", "completed"]).annotate({
  identifier: "KeteTodo.Status",
})
export type Status = typeof Status.Type

export const Priority = Schema.Literals(["high", "medium", "low"]).annotate({ identifier: "KeteTodo.Priority" })
export type Priority = typeof Priority.Type

export const Item = Schema.Struct({
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CONTENT)).annotate({
    description: "What to do, as a short imperative sentence",
  }),
  status: Status.annotate({ description: "pending, in_progress (at most one item at a time) or completed" }),
  priority: optional(Priority.annotate({ description: "Optional: high, medium or low" })),
}).annotate({ identifier: "KeteTodo.Item" })
export type Item = typeof Item.Type

export const List = Schema.Array(Item).check(Schema.isMaxLength(MAX_ITEMS)).annotate({ identifier: "KeteTodo.List" })
export type List = typeof List.Type

export const State = Schema.Struct({
  sessionID: Schema.String,
  todos: List,
}).annotate({ identifier: "KeteTodo.State" })
export type State = typeof State.Type

export const ID = "kete.todo"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    get: { input: Schema.Struct({ sessionID: Schema.String }), output: State },
  },
  events: { updated: { schema: State } },
})

/** Counts for a compact progress label. */
export function progress(todos: ReadonlyArray<Item>) {
  const completed = todos.filter((todo) => todo.status === "completed").length
  return {
    total: todos.length,
    completed,
    current: todos.find((todo) => todo.status === "in_progress"),
  }
}

/** Whether every item is done (an empty list counts as nothing to show). */
export function finished(todos: ReadonlyArray<Item>) {
  return todos.length > 0 && todos.every((todo) => todo.status === "completed")
}
