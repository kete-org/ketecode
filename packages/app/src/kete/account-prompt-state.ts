// The new-session sign-in prompt's data (account-prompt.tsx renders it): the `kete.account` status
// through the raw RPC endpoint and the `rpc.kete.account.changed` event, both decoded against the shared
// schema since they are external input. Signing in itself lives in Settings -> Account
// (gui-plugins/src/kete/account), so the prompt only opens that page.

import type { LocationRef, OpenCodeClient } from "@opencode/client/promise"
import { KeteAccountRpc } from "@opencode/schema/kete/account"
import { Schema } from "effect"

const decodeStatus = Schema.decodeUnknownOption(KeteAccountRpc.Status)
const decodeChanged = Schema.decodeUnknownOption(KeteAccountRpc.Changed)

export const eventType = `rpc.${KeteAccountRpc.ID}.changed`
/** The Settings page id the gui-plugins `kete-account` plugin registers. */
export const settingsTab = "kete-account"

export async function fetchStatus(
  client: Pick<OpenCodeClient, "rpc">,
  location: LocationRef | undefined,
): Promise<KeteAccountRpc.Status | undefined> {
  const response = await client.rpc.call(
    { rpcID: KeteAccountRpc.ID, method: "status", input: {}, location },
    { signal: AbortSignal.timeout(15_000) },
  )
  const status = decodeStatus(response.output)
  return status._tag === "Some" ? status.value : undefined
}

/** Whether to offer sign-in: the runtime answered, nobody is signed in, and offline mode is off. */
export function shouldShow(status: KeteAccountRpc.Status | undefined): boolean {
  return status !== undefined && !status.signedIn && !status.offline
}

/** The change an event carries, if it is an account change. */
export function fromEvent(event: { readonly type: string; readonly data?: unknown }) {
  if (event.type !== eventType) return undefined
  const changed = decodeChanged(event.data)
  return changed._tag === "Some" ? changed.value : undefined
}
