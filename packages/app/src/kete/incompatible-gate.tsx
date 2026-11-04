import { createMemo, Show, type ParentProps } from "solid-js"
import { ServerProvider } from "@/runtime/server/current"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerUnavailablePanel } from "@/session/server-unavailable-panel"
import { useCurrentRoute, useLayout } from "@/shell/state/layout"
import { coveredServer } from "./incompatible-gate-state"
import { KeteIncompatibleGateView } from "./incompatible-gate-view"

/** Covers the page with the "server version isn't supported" panel while the current server is incompatible. */
export function KeteIncompatibleGate(props: ParentProps) {
  const route = useCurrentRoute()
  const layout = useLayout()
  const servers = useServers()
  const global = useGlobal()

  const covered = createMemo(() =>
    coveredServer({
      route: route(),
      selected: layout.home.selection().server,
      visible: servers.visible.map((conn) => ServerConnection.key(conn)),
      health: global.servers.health,
    }),
  )
  const conn = () => servers.visible.find((visible) => ServerConnection.key(visible) === covered())

  return (
    <KeteIncompatibleGateView
      covered={covered()}
      panel={
        <Show when={conn()} keyed>
          {(current) => (
            <ServerProvider conn={current}>
              <ServerUnavailablePanel reason="incompatible" />
            </ServerProvider>
          )}
        </Show>
      }
    >
      {props.children}
    </KeteIncompatibleGateView>
  )
}
