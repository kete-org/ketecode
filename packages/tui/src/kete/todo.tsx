// The session task list in the TUI (core/src/kete/todo.ts): the full list in the session sidebar
// and a one-line progress label ("Todo 1/3 · Fix the type errors") on the prompt footer while work
// is open. The list comes from the `kete.todo` RPC when a session is shown and from the
// `rpc.kete.todo.updated` event as the agent changes it; both are decoded against the shared schema.

import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { Schema } from "effect"
import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"

const decodeState = Schema.decodeUnknownOption(KeteTodoRpc.State)
export const eventType = `rpc.${KeteTodoRpc.ID}.updated`

export async function fetchTodos(
  client: Pick<OpenCodeClient, "rpc">,
  sessionID: string,
  location: LocationRef | undefined,
): Promise<ReadonlyArray<KeteTodoRpc.Item>> {
  const response = await client.rpc.call(
    { rpcID: KeteTodoRpc.ID, method: "get", input: { sessionID }, location },
    { signal: AbortSignal.timeout(15_000) },
  )
  const state = decodeState(response.output)
  return state._tag === "Some" ? state.value.todos : []
}

/** The todo list an event carries for a session, if it is that session's update. */
export function fromEvent(event: { readonly type: string; readonly data?: unknown }, sessionID: string) {
  if (event.type !== eventType) return undefined
  const state = decodeState(event.data)
  if (state._tag === "None" || state.value.sessionID !== sessionID) return undefined
  return state.value.todos
}

/** The footer label: undefined when there is nothing open to show. */
export function footerLabel(todos: ReadonlyArray<KeteTodoRpc.Item>): string | undefined {
  if (todos.length === 0 || KeteTodoRpc.finished(todos)) return undefined
  const { total, completed, current } = KeteTodoRpc.progress(todos)
  return current ? `Todo ${completed}/${total} · ${current.content}` : `Todo ${completed}/${total}`
}

export const mark = (status: KeteTodoRpc.Status) => (status === "completed" ? "✓" : status === "in_progress" ? "▶" : "○")

/** A session's list, kept current from the RPC and its events. */
export function useTodos(context: Plugin.Context, sessionID: Accessor<string | undefined>) {
  const [todos, setTodos] = createSignal<ReadonlyArray<KeteTodoRpc.Item>>([])
  const load = (id: string) => {
    const location = context.data.session.get(id)?.location ?? context.location
    fetchTodos(context.client, id, location)
      .then((value) => {
        if (sessionID() === id) setTodos(value)
      })
      .catch(() => {
        // An older runtime without the task list, or a transient failure: show nothing.
      })
  }
  let loaded: string | undefined
  const current = createMemo(() => {
    const id = sessionID()
    if (id !== loaded) {
      loaded = id
      setTodos([])
      if (id) load(id)
    }
    return todos()
  })
  const stop = context.data.listen((event) => {
    const id = sessionID()
    if (!id) return
    const next = fromEvent(event.details, id)
    if (next) setTodos(next)
  })
  onCleanup(stop)
  return current
}

export function TodoSidebar(props: { context: Plugin.Context; todos: Accessor<ReadonlyArray<KeteTodoRpc.Item>> }) {
  const theme = props.context.theme
  const color = (status: KeteTodoRpc.Status) =>
    status === "completed"
      ? theme.text.feedback.success.base
      : status === "in_progress"
        ? theme.text.feedback.warning.base
        : theme.text.muted
  return (
    <Show when={props.todos().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Todo</b>
          <span style={{ fg: theme.text.muted }}>
            {" "}
            {KeteTodoRpc.progress(props.todos()).completed}/{props.todos().length}
          </span>
        </text>
        <For each={props.todos()}>
          {(item) => (
            <box flexDirection="row" gap={1} minWidth={0}>
              <text flexShrink={0} fg={color(item.status)}>
                {mark(item.status)}
              </text>
              <text fg={item.status === "completed" ? theme.text.muted : theme.text.base} flexShrink={1} minWidth={0}>
                {item.content}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

export function TodoFooter(props: { context: Plugin.Context; todos: Accessor<ReadonlyArray<KeteTodoRpc.Item>> }) {
  return (
    <Show when={footerLabel(props.todos())}>
      {(text) => (
        <box flexDirection="row" flexShrink={1} minWidth={0}>
          <text fg={props.context.theme.text.muted} wrapMode="none" truncate>
            {text()}
          </text>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "kete.todo",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <TodoSidebar context={context} todos={useTodos(context, () => props.sessionID)} />,
    })
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <TodoFooter context={context} todos={useTodos(context, () => props.sessionID)} />,
    })
  },
})
