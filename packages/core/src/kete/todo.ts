// The session task list: a `todowrite` tool the agent uses to plan multi-step work and show its
// progress, with the list kept per session and readable by every client.
//
// Upstream OpenCode v2 had this tool and removed it (7feefb697f, #35989) together with its database
// table and the app's dock. It comes back here as a Kete plugin rather than a revert, which would
// touch dozens of upstream files on an architecture that has moved since. The tool name and item
// shape are upstream's, so the upstream UI code that still recognises `todowrite` keeps working.
//
// - The tool replaces the whole list on every call (simplest for a model to get right) and refuses
//   a list with more than one item in progress or over the bounds in the shared schema.
// - The list is stored in plugin storage (the SQLite KV table), keyed by session, so it survives a
//   restart and isn't lost when the conversation is compacted; it is removed with the session.
// - Clients read it through the `kete.todo` RPC (`get`) and the `rpc.kete.todo.updated` event:
//   no new HTTP endpoint, so no protocol change.
// - The permission action is `todowrite`. Every agent may use it by default (the catch-all allow);
//   an organization policy can deny it, which also hides the tool. Plan mode allows it.
// - A short instruction in the system prompt says when to use it; the current list isn't repeated
//   in every request (it would change the system prompt and defeat prompt caching).

export * as KeteTodo from "./todo.js"

import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, Stream } from "effect"
import { Permission } from "../permission.js"

export const name = "todowrite"

export const description = `Keep a task list for the current session, visible to the user. Use it for work with three or more steps, or when the user gives several tasks: write the steps as todos, mark one in_progress before starting it, and mark it completed as soon as it is done. Send the whole list every time; it replaces the previous one. At most one todo may be in_progress. Skip it for single, simple requests.`

/** Added to the system prompt when the tool is available (kept short: it is in every request). */
export const guidance = `For multi-step tasks, plan with the ${name} tool and keep it current: one item in_progress at a time, completed as soon as done.`

export const Input = Schema.Struct({
  todos: KeteTodoRpc.List.annotate({ description: "The complete, updated task list" }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({ todos: KeteTodoRpc.List })
export type Output = typeof Output.Type

/** Why a list can't be accepted, if it can't. The schema already checked each item and the size. */
export function problem(todos: ReadonlyArray<KeteTodoRpc.Item>): string | undefined {
  const active = todos.filter((todo) => todo.status === "in_progress").length
  if (active > 1) return `Only one todo may be in_progress at a time (got ${active}). Mark the others pending or completed.`
  return undefined
}

const marks: Record<KeteTodoRpc.Status, string> = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }

/** What the model reads back after an update: the list as a checklist. */
export function modelContent(todos: ReadonlyArray<KeteTodoRpc.Item>): string {
  if (todos.length === 0) return "Todo list cleared."
  const { total, completed } = KeteTodoRpc.progress(todos)
  const lines = todos.map((todo) => `${marks[todo.status]} ${todo.content}`)
  const tail = completed === total ? "\nAll todos are completed." : ""
  return `Todo list updated (${completed}/${total} completed):\n${lines.join("\n")}${tail}`
}

/** The storage key of a session's list. */
export const key = (sessionID: string) => `session/${sessionID}`

const decodeList = Schema.decodeUnknownOption(KeteTodoRpc.List)

/** A stored list, or none when it is missing or no longer matches the schema. */
export function stored(value: unknown): ReadonlyArray<KeteTodoRpc.Item> | undefined {
  if (typeof value !== "object" || value === null || !("todos" in value)) return undefined
  const decoded = decodeList(value.todos)
  return decoded._tag === "Some" ? decoded.value : undefined
}

export const Plugin = {
  id: "kete.todo",
  effect: Effect.fn("KeteTodo.Plugin")(function* (ctx: PluginContext) {
    const permission = yield* Permission.Service

    const read = Effect.fn("KeteTodo.read")(function* (sessionID: string) {
      const value = yield* ctx.storage.get(key(sessionID))
      if (value === undefined) return []
      const todos = stored(value)
      if (todos !== undefined) return todos
      yield* Effect.logWarning("ignoring an unreadable stored todo list", { sessionID })
      return []
    })

    const registration = yield* ctx.rpc
      .register(KeteTodoRpc.Definition, {
        get: (input) => read(input.sessionID).pipe(Effect.map((todos) => ({ sessionID: input.sessionID, todos }))),
      })
      .pipe(Effect.orDie)

    const write = Effect.fn("KeteTodo.write")(function* (sessionID: string, todos: ReadonlyArray<KeteTodoRpc.Item>) {
      // Plain JSON for the KV table: copy out of the decoded (readonly) structures.
      const value = { todos: todos.map((todo) => ({ ...todo })), updated: Date.now() }
      yield* ctx.storage.set(key(sessionID), value)
      // The list is saved; a failed notification only delays clients until their next `get`.
      yield* registration.events
        .emit("updated", { sessionID, todos })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to announce a todo update", { sessionID, cause })))
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const message = problem(input.todos)
              if (message !== undefined) return yield* new Tool.Error({ message })
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new Tool.Error({ message: `Permission denied: ${name}`, error })))
              yield* write(context.sessionID, input.todos)
              return {
                output: { todos: input.todos },
                content: modelContent(input.todos),
                metadata: { todos: input.todos },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (name in event.tools) event.system.push({ type: "text", text: guidance })
      }),
    )

    // A deleted session's list goes with it.
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.deleted"),
      Stream.runForEach((event) => {
        const data: unknown = event.data
        const sessionID =
          typeof data === "object" && data !== null && "sessionID" in data && typeof data.sessionID === "string"
            ? data.sessionID
            : undefined
        if (sessionID === undefined) return Effect.void
        return ctx.storage.remove(key(sessionID))
      }),
      Effect.catchCause((cause) => Effect.logWarning("todo cleanup stopped", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
}
