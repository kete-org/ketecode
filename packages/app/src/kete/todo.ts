// The session task list's data for the web UI (todo-dock.tsx renders it): fetching it through the
// `kete.todo` RPC and reading `rpc.kete.todo.updated` events, both decoded against the shared schema
// since they are external input. The promise client's typed `rpc()` accepts only Standard Schema
// definitions (local-models.ts), so this calls the raw RPC endpoint.

import type { LocationRef, OpenCodeClient } from "@opencode/client/promise"
import { KeteTodoRpc } from "@opencode/schema/kete/todo"
import { Schema } from "effect"

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

/** The list an event carries for this session, if it is this session's update. */
export function fromEvent(event: { readonly type: string; readonly data?: unknown }, sessionID: string) {
  if (event.type !== eventType) return undefined
  const state = decodeState(event.data)
  if (state._tag === "None" || state.value.sessionID !== sessionID) return undefined
  return state.value.todos
}

/** "1 of 3 done", or "All 3 done". */
export function summary(todos: ReadonlyArray<KeteTodoRpc.Item>) {
  const { total, completed } = KeteTodoRpc.progress(todos)
  return completed === total ? `All ${total} done` : `${completed} of ${total} done`
}

export const STATUS_LABEL: Record<KeteTodoRpc.Status, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
}
