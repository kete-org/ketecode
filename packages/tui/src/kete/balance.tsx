// Kete credit balance in the session sidebar.
//
// The runtime's Kete Gateway provider (core/src/kete/gateway.ts) publishes the platform
// account as the `kete` integration's metadata: `balance_micros` (integer micro-USD, may be
// negative), `currency` and `organization`. Nothing is shown without a platform connection.

import { Plugin } from "@opencode/plugin/tui"
import { Brand } from "@opencode/util/kete/brand"
import { createMemo, Show } from "solid-js"

/** Below this balance the sidebar warns that credit is running low. */
export const lowBalanceMicros = 1_000_000

export function account(metadata: Record<string, unknown> | undefined) {
  if (typeof metadata?.balance_micros !== "number" || typeof metadata.currency !== "string") return
  return {
    balance: metadata.balance_micros / 1_000_000,
    micros: metadata.balance_micros,
    currency: metadata.currency,
    organization: typeof metadata.organization === "string" ? metadata.organization : undefined,
  }
}

export function KeteBalance(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const current = createMemo(() =>
    account(
      props.context.data.location.integration
        .list(session()?.location ?? props.context.location)
        ?.find((integration) => integration.id === "kete")?.metadata,
    ),
  )

  return (
    <Show when={current()}>
      {(value) => {
        const money = new Intl.NumberFormat("en-US", { style: "currency", currency: value().currency })
        const status = () =>
          value().micros <= 0
            ? { fg: theme.text.feedback.error.base, note: "Out of credit. Top up to continue." }
            : value().micros < lowBalanceMicros
              ? { fg: theme.text.feedback.warning.base, note: "Credit is running low." }
              : undefined
        return (
          <box>
            <text fg={theme.text.base}>
              <b>{Brand.displayName}</b>
            </text>
            <text fg={status()?.fg ?? theme.text.muted}>{money.format(value().balance)} balance</text>
            <Show when={status()}>{(item) => <text fg={item().fg}>{item().note}</text>}</Show>
            <Show when={value().organization}>
              {(organization) => <text fg={theme.text.muted}>{organization()}</text>}
            </Show>
          </box>
        )
      }}
    </Show>
  )
}

export default Plugin.define({
  id: "kete.sidebar.balance",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <KeteBalance context={context} sessionID={props.sessionID} />,
    })
  },
})
