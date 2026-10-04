// Local models in the TUI: the shared picker rules (util/src/kete/local-picker.ts) plus fetching the
// `kete.local-models` status from the runtime. The promise client's typed `rpc()` accepts only Standard
// Schema definitions and the shared definition is Effect Schema, so this calls the raw RPC endpoint and
// decodes the answer against the shared schema: the server's reply is external input either way.

import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { KeteLocalPicker } from "@opencode/util/kete/local-picker"
import { Schema } from "effect"

export { KeteLocalPicker }

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

export type OfferDeps = {
  readonly hasModel: boolean
  readonly offered: boolean
  readonly status: () => Promise<KeteLocalPicker.Status>
  /** Records that the offer was made (persisted), before it is shown, so it never repeats. */
  readonly markOffered: () => Promise<void> | void
  /** Shows the offer; resolves true when the user accepts. */
  readonly confirm: (offer: KeteLocalPicker.Offer) => Promise<boolean>
  readonly models: () => readonly { readonly providerID: string; readonly id: string; readonly tools: boolean }[]
  /** Selects the model the same way the model dialog does (the TUI's persisted selection; no config write). */
  readonly select: (model: { readonly providerID: string; readonly modelID: string }) => void
}

export type OfferResult =
  | { readonly kind: "skipped" }
  | { readonly kind: "declined" }
  | { readonly kind: "selected"; readonly providerID: string; readonly modelID: string }
  | { readonly kind: "no_model"; readonly providerID: KeteLocalPicker.ProviderID }

/**
 * The first-run offer: when the user has no model yet and has never been offered, ask the runtime
 * for the local servers' status; with a reachable server that has models, record the offer and ask
 * once. Accepting selects that server's first model (one that can call tools if any can).
 */
export async function firstRunOffer(deps: OfferDeps): Promise<OfferResult> {
  if (deps.offered || deps.hasModel) return { kind: "skipped" }
  const offer = KeteLocalPicker.offer({ status: await deps.status(), hasModel: deps.hasModel, offered: deps.offered })
  if (!offer) return { kind: "skipped" }
  await deps.markOffered()
  if (!(await deps.confirm(offer))) return { kind: "declined" }
  const model = KeteLocalPicker.pick(deps.models(), offer.providerID)
  if (!model) return { kind: "no_model", providerID: offer.providerID }
  deps.select({ providerID: model.providerID, modelID: model.id })
  return { kind: "selected", providerID: model.providerID, modelID: model.id }
}

/**
 * Tracks the once-per-session "this model can only answer" notice: `check` returns the message the
 * first time a session runs with a model that can't call tools, and nothing after that.
 */
export function noToolsTracker() {
  const seen = new Set<string>()
  return {
    check(sessionID: string, model: { readonly tools: boolean } | undefined): string | undefined {
      const message = KeteLocalPicker.noToolsNotice({ sessionKey: sessionID, model, seen })
      if (message) seen.add(sessionID)
      return message
    },
  }
}

type ConfigEntry = { readonly type: string; readonly info?: { readonly kete?: { readonly offline?: boolean } } }

/**
 * Whether offline mode is on for this location, as the runtime decides it: the process flag (on or
 * invalid; the CLI sets it before the TUI starts) or `kete.offline` in the highest-priority config
 * document that has a `kete` block (core's `Config.latest`).
 */
export function offlineFrom(flag: boolean, entries: readonly ConfigEntry[] | undefined): boolean {
  if (flag) return true
  const kete = entries?.findLast((entry) => entry.type === "document" && entry.info?.kete !== undefined)?.info?.kete
  return kete?.offline === true
}

/** Whether the catalog lists any model from a local server: the first-run offer asks for status only then. */
export function hasLocalModels(models: readonly { readonly providerID: string }[] | undefined): boolean {
  return (models ?? []).some((model) => KeteLocalPicker.isLocal(model.providerID))
}
