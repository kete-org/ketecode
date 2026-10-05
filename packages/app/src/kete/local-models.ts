// Local models in the web UI (and the VS Code panel): the shared picker rules
// (util/src/kete/local-picker.ts) plus fetching the `kete.local-models` status from the runtime. The
// promise client's typed `rpc()` accepts only Standard Schema definitions and the shared definition is
// Effect Schema, so this calls the raw RPC endpoint and decodes the reply against the shared schema:
// the server's answer is external input either way. Rendering lives in local-ui.tsx.

import type { LocationRef, OpenCodeClient } from "@opencode/client/promise"
import { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { KeteLocalPicker } from "@opencode/util/kete/local-picker"
import { Schema } from "effect"

export { KeteLocalPicker }
export const { firstRunOffer, noToolsTracker, offlineFrom, hasLocalModels } = KeteLocalPicker
export type OfferDeps = KeteLocalPicker.OfferDeps

const decode = Schema.decodeUnknownPromise(KeteLocalModelsRpc.Status)

/** Asks the runtime for the local servers' status (it probes them; at most a few seconds). */
export async function fetchStatus(
  client: Pick<OpenCodeClient, "rpc">,
  location: LocationRef | undefined,
): Promise<KeteLocalModelsRpc.Status> {
  const response = await client.rpc.call(
    { rpcID: KeteLocalModelsRpc.ID, method: "status", input: {}, location },
    { signal: AbortSignal.timeout(15_000) },
  )
  return decode(response.output)
}

/** A model as the web picker lists it (providers/models/selection.tsx). */
export type PickerItem = {
  readonly id: string
  readonly provider: { readonly id: string; readonly name: string }
  readonly capabilities?: { readonly toolcall?: boolean }
  readonly limit?: { readonly context?: number }
}

/** Whether a picker model can call tools; an unknown value keeps upstream's behaviour (tools offered). */
export function canCallTools(item: Pick<PickerItem, "capabilities"> | undefined): boolean {
  return item?.capabilities?.toolcall !== false
}

/** The picker's badges for a model: "no tools" and the context size for local models, nothing for others. */
export function itemBadges(item: PickerItem): string[] {
  return KeteLocalPicker.badges({
    providerID: item.provider.id,
    tools: canCallTools(item),
    context: item.limit?.context ?? 0,
  })
}

/** A provider group's title in the picker: local servers read "Local · Ollama". */
export function groupTitle(provider: { readonly id: string }, name: string): string {
  return KeteLocalPicker.isLocal(provider.id) ? `${KeteLocalPicker.group} · ${name}` : name
}

/** The first-run offer's inputs from the web picker's own state. */
export function offerModels(items: readonly PickerItem[]) {
  return items.map((item) => ({ providerID: item.provider.id, id: item.id, tools: canCallTools(item) }))
}
