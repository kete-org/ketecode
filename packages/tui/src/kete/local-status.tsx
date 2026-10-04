// Local models in the TUI footers: an "Offline" indicator on the home and prompt footers while offline
// mode is on (--offline, KETE_OFFLINE, or `kete.offline` in config). Decided like the runtime does:
// the process flag the CLI sets before the TUI starts, or the location's config, so it needs no
// request to the runtime.

import { Plugin } from "@opencode/plugin/tui"
import { KeteOffline } from "@opencode/util/kete/offline"
import { createMemo, Show, type Accessor } from "solid-js"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { KeteLocalPicker, offlineFrom } from "./local-models"

export function OfflineIndicator(props: { context: Plugin.Context; offline: Accessor<boolean> }) {
  return (
    <Show when={props.offline()}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.context.theme.text.base}>
          <span style={{ fg: props.context.theme.text.feedback.warning.base }}>⊘ </span>
          {KeteLocalPicker.offlineLabel}
        </text>
      </box>
    </Show>
  )
}

function Indicator(props: { context: Plugin.Context }) {
  const data = useData()
  const location = useLocation()
  const offline = createMemo(() => offlineFrom(KeteOffline.enabled(), data.location.config.list(location.ref)))
  return <OfflineIndicator context={props.context} offline={offline} />
}

export default Plugin.define({
  id: "kete.local-status",
  setup(context) {
    context.ui.slot({ append: "home.footer.status", render: () => <Indicator context={context} /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <Indicator context={context} /> })
  },
})
