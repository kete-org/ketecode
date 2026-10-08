// The local OS sandbox in the TUI footers (ADR 0013, docs/sandbox.md): an "Unsandboxed" warning on
// the home and prompt footers when the runtime reports that agent commands run without the OS
// sandbox (turned off, or not available on this machine). Nothing is shown while it is on. Asked once
// per location through the `kete.sandbox` status RPC; the answer is decoded against the shared schema.

import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { Schema } from "effect"
import { createResource, Show } from "solid-js"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"

const decode = Schema.decodeUnknownPromise(KeteSandboxRpc.Status)

export async function fetchSandboxStatus(
  client: Pick<OpenCodeClient, "rpc">,
  location: LocationRef | undefined,
): Promise<KeteSandboxRpc.Status> {
  const response = await client.rpc.call(
    { rpcID: KeteSandboxRpc.ID, method: "status", input: {}, location },
    { signal: AbortSignal.timeout(15_000) },
  )
  return decode(response.output)
}

/** The footer label: undefined while sandboxed (or in a job, or unknown). */
export function label(status: KeteSandboxRpc.Status | undefined): string | undefined {
  if (status?.state === "off") return "Unsandboxed (sandbox off)"
  if (status?.state === "unavailable") return status.mode === "required" ? "No sandbox: commands refused" : "Unsandboxed"
  return undefined
}

function Indicator(props: { context: Plugin.Context }) {
  const client = useClient()
  const location = useLocation()
  const [status] = createResource(() => fetchSandboxStatus(client.api, location.ref).catch(() => undefined))
  return (
    <Show when={label(status())}>
      {(text) => (
        <box flexDirection="row" flexShrink={0}>
          <text fg={props.context.theme.text.base}>
            <span style={{ fg: props.context.theme.text.feedback.warning.base }}>⚠ </span>
            {text()}
          </text>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "kete.sandbox-status",
  setup(context) {
    context.ui.slot({ append: "home.footer.status", render: () => <Indicator context={context} /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <Indicator context={context} /> })
  },
})
