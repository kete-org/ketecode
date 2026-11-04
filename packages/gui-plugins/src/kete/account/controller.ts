// The state behind Settings -> Account: reads `kete.account` (core/src/kete/account.ts) through the
// server's raw RPC endpoint, starts and cancels sign-in, opens the approval URL in the user's browser,
// and follows `rpc.kete.account.changed`. Plain TypeScript, no JSX, so it is testable on its own; the
// page (page.tsx) renders `state()`. Every RPC output is decoded against the shared schema.

import { KeteAccountRpc } from "@opencode/schema/kete/account"
import { Schema } from "effect"

export type Api = {
  /** Calls a `kete.account` method and returns its output. Rejects when the request fails. */
  readonly call: (method: "status" | "login" | "cancel" | "logout") => Promise<unknown>
  /** The server's event stream, ended by `signal`. */
  readonly events: (signal: AbortSignal) => AsyncIterable<{ readonly type: string; readonly data?: unknown }>
  /** Opens a URL in the system browser. */
  readonly open: (url: string) => void
}

export type State = {
  readonly status: KeteAccountRpc.Status | undefined
  /** `working`: a request is in flight. `waiting`: the browser has the approval URL. */
  readonly phase: "idle" | "working" | "waiting"
  readonly error: string | undefined
  /** A caveat after a sign-out that worked (e.g. the platform could not revoke the key). */
  readonly notice: string | undefined
}

export const failedMessage = "Something went wrong. Try again."

const decodeStatus = Schema.decodeUnknownOption(KeteAccountRpc.Status)
const decodeLogin = Schema.decodeUnknownOption(KeteAccountRpc.Login)
const decodeLogout = Schema.decodeUnknownOption(KeteAccountRpc.Logout)
const decodeChanged = Schema.decodeUnknownOption(KeteAccountRpc.Changed)

export const changedType = `rpc.${KeteAccountRpc.ID}.changed`

/** Whether a failed request was the server's local-only gate (HTTP 403). */
function forbidden(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 403
}

function describe(error: unknown) {
  return forbidden(error) ? KeteAccountRpc.localOnlyMessage : failedMessage
}

export function create(api: Api) {
  let state: State = { status: undefined, phase: "idle", error: undefined, notice: undefined }
  const listeners = new Set<() => void>()
  const abort = new AbortController()
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch }
    listeners.forEach((listener) => listener())
  }

  const refresh = async () => {
    try {
      const status = decodeStatus(await api.call("status"))
      if (status._tag === "None") return set({ error: failedMessage })
      set({ status: status.value })
    } catch (error) {
      set({ error: describe(error) })
    }
  }

  const signIn = async () => {
    set({ phase: "working", error: undefined, notice: undefined })
    try {
      const result = decodeLogin(await api.call("login"))
      if (result._tag === "None") return set({ phase: "idle", error: failedMessage })
      if (result.value.kind === "started") {
        api.open(result.value.url)
        return set({ phase: "waiting" })
      }
      set({ phase: "idle", error: result.value.message })
    } catch (error) {
      set({ phase: "idle", error: describe(error) })
    }
  }

  const cancel = async () => {
    try {
      await api.call("cancel")
    } catch (error) {
      return set({ phase: "idle", error: describe(error) })
    }
    set({ phase: "idle", error: undefined })
  }

  const signOut = async () => {
    set({ phase: "working", error: undefined, notice: undefined })
    try {
      const result = decodeLogout(await api.call("logout"))
      if (result._tag === "None") return set({ phase: "idle", error: failedMessage })
      if (result.value.kind !== "done") return set({ phase: "idle", error: result.value.message })
      set({ phase: "idle", notice: result.value.message })
      await refresh()
    } catch (error) {
      set({ phase: "idle", error: describe(error) })
    }
  }

  const changed = async (data: unknown) => {
    const event = decodeChanged(data)
    if (event._tag === "None") return
    if (event.value.state === "failed") return set({ phase: "idle", error: event.value.message ?? failedMessage })
    set({ phase: "idle", error: undefined })
    if (event.value.state !== "cancelled") await refresh()
  }

  /** Follows the server's events until `dispose()`; a dropped stream is not retried (the page reloads status on open). */
  const follow = async () => {
    try {
      for await (const event of api.events(abort.signal)) if (event.type === changedType) await changed(event.data)
    } catch (error) {
      if (!abort.signal.aborted) set({ error: describe(error) })
    }
  }

  return {
    state: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    start: () => {
      void follow()
      return refresh()
    },
    refresh,
    signIn,
    cancel,
    signOut,
    dispose: () => abort.abort(),
  }
}
