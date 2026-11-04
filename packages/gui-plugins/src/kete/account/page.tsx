import { KeteAccountRpc } from "@opencode/schema/kete/account"
import { usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { create, type Api } from "./controller"
import type definition from "./index"

/** The server the page signs in on, as an Api over its client. Reads the live ref on every call. */
function api(server: Accessor<ServerRef | undefined>, open: (url: string) => void): Api {
  const client = () => {
    const ref = server()
    if (!ref) throw new Error("No server")
    return ref.client
  }
  return {
    call: async (method) =>
      (
        await client().rpc.call(
          { rpcID: KeteAccountRpc.ID, method, input: {} },
          { signal: AbortSignal.timeout(90_000) },
        )
      ).output,
    events: (signal) => client().event.subscribe({ signal }),
    open,
  }
}

export default function AccountPage(props: { server: Accessor<ServerRef | undefined> }) {
  const ctx = usePlugin<typeof definition>()
  const controller = create(api(props.server, (url) => ctx.system.openExternal(url)))
  const [state, setState] = createSignal(controller.state())
  onCleanup(controller.subscribe(() => setState(controller.state())))
  onCleanup(controller.dispose)
  if (props.server()) void controller.start()

  const status = () => state().status
  const busy = () => state().phase === "working"

  return (
    <div data-kete="account-page">
      <Show when={props.server()} fallback={<p>{ctx.t("unavailable")}</p>}>
        <Show when={status()}>
          {(current) => (
            <Show
              when={current().signedIn}
              fallback={
                <div data-kete="account-row">
                  <div>
                    <strong>{state().phase === "waiting" ? ctx.t("waiting.title") : ctx.t("signedOut.title")}</strong>
                    <p>
                      {state().phase === "waiting"
                        ? ctx.t("waiting.description")
                        : current().offline
                          ? ctx.t("offline")
                          : ctx.t("signedOut.description")}
                    </p>
                  </div>
                  <Show
                    when={state().phase === "waiting"}
                    fallback={
                      <ctx.ui.Button disabled={busy() || current().offline} onClick={() => void controller.signIn()}>
                        {ctx.t("signIn")}
                      </ctx.ui.Button>
                    }
                  >
                    <ctx.ui.Button onClick={() => void controller.cancel()}>{ctx.t("cancel")}</ctx.ui.Button>
                  </Show>
                </div>
              }
            >
              <div data-kete="account-row">
                <div>
                  <strong>{ctx.t("signedIn.title", { organization: current().organization ?? "" })}</strong>
                  <p>{ctx.t("signedIn.description")}</p>
                  <Show when={current().platform}>
                    <p>{ctx.t("signedIn.platform", { platform: current().platform ?? "" })}</p>
                  </Show>
                </div>
                <ctx.ui.Button disabled={busy()} onClick={() => void controller.signOut()}>
                  {ctx.t("signOut")}
                </ctx.ui.Button>
              </div>
            </Show>
          )}
        </Show>
        <Show when={state().notice}>{(message) => <p role="status" data-kete="account-notice">{message()}</p>}</Show>
        <Show when={state().error}>{(message) => <p role="alert" data-kete="account-error">{message()}</p>}</Show>
      </Show>
    </div>
  )
}
