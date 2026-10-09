// The session task list above the composer (web UI, and so the VS Code and JetBrains panels, which
// host this app): the agent's `todowrite` list (core/src/kete/todo.ts) with a progress count, folded
// to one line on request. Read through the `kete.todo` RPC when a session opens and kept current
// from the `rpc.kete.todo.updated` event (todo.ts). Nothing is shown on the new-session screen or
// for an empty list.

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { useData, useServer } from "@/runtime/server/current"
import { fetchTodos, fromEvent, STATUS_LABEL, summary } from "./todo"
import "./panel.css"

export function KeteTodoDock() {
  const server = useServer()
  const data = useData()
  const route = useLocation()
  const sessionID = createMemo(() => /\/session\/([^/]+)$/.exec(route.pathname)?.[1])
  const [todos, setTodos] = createSignal<ReadonlyArray<KeteTodoRpc.Item>>([])
  const [folded, setFolded] = createSignal(false)

  createEffect(
    on(sessionID, (id) => {
      setTodos([])
      if (!id) return
      const location = data.session.get(id)?.location
      fetchTodos(server.ctx.sdk.api, id, location)
        .then((value) => {
          if (sessionID() === id) setTodos(value)
        })
        .catch(() => {
          // An older runtime without the task list, or a transient failure: show nothing.
        })
    }),
  )

  const stop = server.ctx.sdk.event.listen((event) => {
    const id = sessionID()
    if (!id) return
    const next = fromEvent(event, id)
    if (next) setTodos(next)
  })
  onCleanup(stop)

  return (
    <Show when={todos().length > 0}>
      <section data-kete="todo-dock" aria-label="Task list">
        <button
          type="button"
          data-kete="todo-header"
          aria-expanded={!folded()}
          onClick={() => setFolded((value) => !value)}
        >
          <span data-kete="todo-title">Tasks</span>
          <span data-kete="todo-progress">{summary(todos())}</span>
          <span data-kete="todo-current">
            {folded() ? (KeteTodoRpc.progress(todos()).current?.content ?? "") : ""}
          </span>
        </button>
        <Show when={!folded()}>
          <ul data-kete="todo-list">
            <For each={todos()}>
              {(item) => (
                <li data-kete="todo-item" data-status={item.status} title={STATUS_LABEL[item.status]}>
                  <span data-kete="todo-mark" aria-label={STATUS_LABEL[item.status]} />
                  <span data-kete="todo-content">{item.content}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  )
}
