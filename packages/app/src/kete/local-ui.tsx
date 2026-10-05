// Local models in the web UI (also the VS Code panel), rendered from local-models.ts's rules:
// - the model picker's "no tools" and context-size badges and its line for each local server that
//   can't be reached (URL and how to start it);
// - the "Offline" indicator in the panel header;
// - the first-run offer "Use local models (Ollama, N models)" in the empty state, once ever;
// - the "this model can only answer" notice, once per session, for a model that can't call tools.

import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Schema } from "effect"
import { createEffect, createMemo, createResource, createSignal, For, Show, untrack, type Accessor } from "solid-js"
import { useConfiguredModel } from "@/providers/models/configured"
import { useLocal } from "@/providers/models/selection"
import { useData, useServer } from "@/runtime/server/current"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { showToast } from "@/shell/notifications/toast"
import { useWorkspaceLocation } from "@/workspaces/location"
import {
  canCallTools,
  fetchStatus,
  firstRunOffer,
  hasLocalModels,
  itemBadges,
  KeteLocalPicker,
  noToolsTracker,
  offerModels,
  offlineFrom,
  type PickerItem,
} from "./local-models"
import { segments } from "./panel-state"
import "./tokens.css"
import "./panel.css"

/** The local servers' status for the open location. Advisory: an older runtime or a failed probe gives undefined. */
export function useKeteLocalStatus() {
  const server = useServer()
  const location = useWorkspaceLocation()
  const [status] = createResource(
    () => location().ref,
    (ref) => fetchStatus(server.ctx.sdk.api, ref).catch(() => undefined),
  )
  return status
}

export function KeteLocalBadges(props: { item: PickerItem }) {
  return <For each={itemBadges(props.item)}>{(badge) => <Badge class="shrink-0">{badge}</Badge>}</For>
}

function Text(props: { text: string }) {
  return (
    <For each={segments(props.text)}>
      {(segment) => (segment.type === "code" ? <code>{segment.value}</code> : segment.value)}
    </For>
  )
}

export function KeteLocalUnreachableLines(props: { status: KeteLocalPicker.Status | undefined }) {
  return (
    <For each={KeteLocalPicker.unreachable(props.status)}>
      {(line) => (
        <div data-kete="local-unreachable" role="status">
          <p>{line.text}</p>
          <p>
            <Text text={line.hint} />
          </p>
        </div>
      )}
    </For>
  )
}

/** The model dialog's lines for local servers that can't be reached. */
export function KeteLocalUnreachable() {
  const status = useKeteLocalStatus()
  return <KeteLocalUnreachableLines status={status()} />
}

export function KeteOfflineBadge(props: { offline: Accessor<boolean> }) {
  return (
    <Show when={props.offline()}>
      <span data-kete="offline-indicator" role="status" title="Offline mode: only local models are used">
        {KeteLocalPicker.offlineLabel}
      </span>
    </Show>
  )
}

/** "Offline" in the panel header: the runtime's answer (flag or config), or the location's config while it loads. */
export function KeteOfflineIndicator() {
  const status = useKeteLocalStatus()
  const data = useData()
  const location = useWorkspaceLocation()
  const offline = createMemo(
    () => status()?.offline === true || offlineFrom(false, data.location.config.list({ directory: location().directory })),
  )
  return <KeteOfflineBadge offline={offline} />
}

const OfferState = Persistence.struct({ offered: Schema.Boolean })

export function KeteLocalOfferCard(props: {
  offer: KeteLocalPicker.Offer
  onAnswer: (accepted: boolean) => void
}) {
  return (
    <div data-kete="local-offer" role="status">
      <p>{props.offer.title}</p>
      <div data-kete="local-offer-actions">
        <Button size="small" variant="contrast" onClick={() => props.onAnswer(true)}>
          Use local models
        </Button>
        <Button size="small" variant="ghost" onClick={() => props.onAnswer(false)}>
          Not now
        </Button>
      </div>
    </div>
  )
}

/**
 * The first-run offer, in the empty state: once ever (persisted), when no model is configured or
 * recently used and a local server is reachable with models. Accepting selects a model through the
 * picker's own selection (no config write).
 */
export function KeteLocalOffer() {
  const local = useLocal()
  const configured = useConfiguredModel()
  const server = useServer()
  const location = useWorkspaceLocation()
  const [state, setState, , ready] = persisted(Persist.global("kete.local-offer"), OfferState, { offered: false })
  const [pending, setPending] = createSignal<{
    readonly offer: KeteLocalPicker.Offer
    readonly resolve: (accepted: boolean) => void
  }>()
  let started = false
  createEffect(() => {
    if (started || !ready() || !local.model.ready()) return
    const items = local.model.list()
    // No model from a local server in the catalog: nothing to offer, so no status request either.
    if (!hasLocalModels(items.map((item) => ({ providerID: item.provider.id })))) return
    started = true
    untrack(() => {
      void firstRunOffer({
        hasModel: configured() !== undefined || local.model.recent().length > 0,
        offered: state.offered,
        status: () => fetchStatus(server.ctx.sdk.api, location().ref),
        markOffered: () => setState("offered", true),
        confirm: (offer) => new Promise<boolean>((resolve) => setPending({ offer, resolve })),
        models: () => offerModels(local.model.list()),
        select: (model) => local.model.set(model, { recent: true }),
      })
        .then((result) => {
          if (result.kind === "selected") showToast({ description: `Using ${result.providerID}/${result.modelID}.` })
          if (result.kind === "no_model")
            showToast({
              description: `${KeteLocalPicker.providers[result.providerID]} isn't listing its models yet. Pick one from the model menu in a moment.`,
            })
        })
        // Advisory: without a status (an older runtime, a failed probe) there is simply no offer.
        .catch(() => undefined)
    })
  })
  return (
    <Show when={pending()}>
      {(item) => (
        <KeteLocalOfferCard
          offer={item().offer}
          onAnswer={(accepted) => {
            setPending(undefined)
            item().resolve(accepted)
          }}
        />
      )}
    </Show>
  )
}

/** Shows the "this model can only answer" notice once per session while the session's model can't call tools. */
export function useKeteNoToolsNotice(input: {
  sessionID: Accessor<string | undefined>
  model: Accessor<Pick<PickerItem, "capabilities"> | undefined>
}) {
  const notice = noToolsTracker()
  createEffect(() => {
    const sessionID = input.sessionID()
    const model = input.model()
    if (!sessionID || !model) return
    const message = notice.check(sessionID, { tools: canCallTools(model) })
    if (message) untrack(() => showToast({ title: "Answer-only model", description: message }))
  })
}
