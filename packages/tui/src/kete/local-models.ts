// Local models in the TUI: the shared picker rules (util/src/kete/local-picker.ts) plus fetching the
// `kete.local-models` status from the runtime. The promise client's typed `rpc()` accepts only Standard
// Schema definitions and the shared definition is Effect Schema, so this calls the raw RPC endpoint and
// decodes the answer against the shared schema: the server's reply is external input either way.

import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { KeteLocalPicker } from "@opencode/util/kete/local-picker"
import { Schema } from "effect"

export { KeteLocalPicker }
export const { firstRunOffer, noToolsTracker, offlineFrom, hasLocalModels } = KeteLocalPicker
export type OfferDeps = KeteLocalPicker.OfferDeps
export type OfferResult = KeteLocalPicker.OfferResult

const decode = Schema.decodeUnknownPromise(KeteLocalModelsRpc.Status)

/** Asks the runtime for the local servers' status (probes them; at most a few seconds). */
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

type RuntimeModel = {
  readonly providerID: string
  readonly capabilities: { readonly tools: boolean }
  readonly limit: { readonly context: number }
}

/**
 * Whether a runtime model can call tools. The catalog is the server's answer (external input), so a
 * missing field reads as "unknown", which keeps upstream's behaviour (tools offered, no badge).
 */
export function canCallTools(model: Partial<RuntimeModel> | undefined): boolean {
  return model?.capabilities?.tools !== false
}

/** The model fields the picker rules read, from a runtime model. */
export function pickerModel(model: RuntimeModel): KeteLocalPicker.Model {
  const context: unknown = (model as Partial<RuntimeModel>).limit?.context
  return { providerID: model.providerID, tools: canCallTools(model), context: typeof context === "number" ? context : 0 }
}

/**
 * What the model dialog changes for a local model: it goes in the "Local" group (sorted as one
 * provider, with the server's name as its description) and its footer shows "no tools" and the
 * context size. Other models keep the dialog's own values.
 */
export function dialogFields(
  model: Parameters<typeof pickerModel>[0],
  upstream: { readonly category?: string; readonly providerName: string; readonly footer?: string; readonly description?: string },
) {
  if (!KeteLocalPicker.isLocal(model.providerID)) return upstream
  const badges = KeteLocalPicker.badges(pickerModel(model))
  return {
    category: upstream.category === undefined ? undefined : KeteLocalPicker.group,
    providerName: KeteLocalPicker.group,
    footer: badges.length > 0 ? badges.join(" · ") : upstream.footer,
    description: upstream.description ?? upstream.providerName,
  }
}

/**
 * The dialog rows for local servers that can't be reached: the URL and error as the title, how to
 * start the server as a detail line. Selecting one shows the full hint (`onSelect`) and keeps the
 * dialog open; the dialog hides disabled rows, so these stay selectable.
 */
export function unreachableOptions(
  status: KeteLocalPicker.Status | undefined,
  onSelect: (line: KeteLocalPicker.Unreachable) => void,
) {
  return KeteLocalPicker.unreachable(status).map((line) => ({
    value: { providerID: line.providerID, modelID: "" },
    title: line.text,
    details: [line.hint.replaceAll("`", "")],
    releaseDate: 0,
    category: KeteLocalPicker.group,
    onSelect: () => onSelect(line),
  }))
}
