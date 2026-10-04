// Local models in the TUI app shell (called once from app.tsx):
// - the first-run offer "Use local models (Ollama, N models)": once ever (persisted in TUI storage),
//   only when no model is configured, chosen or favourited and a local server is reachable with
//   models; accepting selects a model the same way the model dialog does (no config write).
// - the "this model can only answer" notice, once per session, when a session runs with a model that
//   can't call tools (the agent itself is told by the runtime's `session.context` hook).
// And `useKeteLocalStatus()` for the model dialog: the local servers' status (for its unreachable
// lines) plus Ollama's context-window warnings as toasts, once per model per TUI run.

import { createEffect, createResource, untrack } from "solid-js"
import { useArgs } from "../context/args"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useStorage } from "../context/storage"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { canCallTools, fetchStatus, firstRunOffer, hasLocalModels, KeteLocalPicker, noToolsTracker } from "./local-models"

export function useKeteLocalModels() {
  const args = useArgs()
  const client = useClient()
  const data = useData()
  const local = useLocal()
  const location = useLocation()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const [state, update] = useStorage().store<{ offered: boolean }>("kete-local-offer", { initial: { offered: false } })

  let checked = false
  createEffect(() => {
    if (checked || !local.model.ready || !local.model.catalogReady) return
    const config = data.location.config.list(location.ref)
    if (config === undefined) return
    checked = true
    untrack(() => {
      // No model from a local server in the catalog: nothing to offer, so no status request either.
      if (!hasLocalModels(data.location.model.list(location.ref))) return
      const hasModel =
        !!args.model ||
        config.some((entry) => entry.type === "document" && entry.info.model !== undefined) ||
        local.model.recent().length > 0 ||
        local.model.favorite().length > 0
      void firstRunOffer({
        hasModel,
        offered: state.offered,
        status: () => fetchStatus(client.api, location.ref),
        markOffered: () =>
          update((draft) => {
            draft.offered = true
          }),
        confirm: (offer) =>
          new Promise<boolean>((resolve) =>
            dialog.replace(
              () => (
                <DialogConfirm
                  title={offer.title}
                  message={`${KeteLocalPicker.providers[offer.providerID]} is running with ${offer.models} ${offer.models === 1 ? "model" : "models"}. Use it now? You can switch models any time with /models.`}
                  label={{ confirm: "Use local models", cancel: "Not now" }}
                  onConfirm={() => resolve(true)}
                  onCancel={() => resolve(false)}
                />
              ),
              () => resolve(false),
            ),
          ),
        models: () =>
          (data.location.model.list(location.ref) ?? []).map((model) => ({
            providerID: model.providerID,
            id: model.id,
            tools: canCallTools(model),
          })),
        select: (model) => local.model.set(model, { recent: true }),
      })
        .then((result) => {
          if (result.kind === "selected")
            toast.show({ variant: "success", message: `Using ${result.providerID}/${result.modelID}.` })
          if (result.kind === "no_model")
            toast.show({
              variant: "warning",
              message: `${KeteLocalPicker.providers[result.providerID]} isn't listing its models yet. Pick one with /models in a moment.`,
            })
        })
        // Advisory: without a status (an older runtime, a failed probe) there is simply no offer.
        .catch(() => undefined)
    })
  })

  const notice = noToolsTracker()
  createEffect(() => {
    if (route.data.type !== "session") return
    const sessionID = route.data.sessionID
    const current = local.model.current()
    if (!current) return
    const info = data.location.model
      .list(location.ref)
      ?.find((model) => model.providerID === current.providerID && model.id === current.modelID)
    const message = notice.check(sessionID, info && { tools: canCallTools(info) })
    if (message) untrack(() => toast.show({ variant: "warning", message, duration: 10_000 }))
  })
}

export function useKeteLocalStatus() {
  const client = useClient()
  const location = useLocation()
  const toast = useToast()
  const [shown, update] = useStorage().memory<{ warned: string[] }>("kete-local-context-warnings", {
    initial: { warned: [] },
  })
  // Advisory: a runtime without the status (an older server) or a failed probe just shows no lines.
  const [status] = createResource(() => fetchStatus(client.api, location.ref).catch(() => undefined))
  createEffect(() => {
    for (const warning of KeteLocalPicker.contextWarnings(status())) {
      if (untrack(() => shown.warned.includes(warning.key))) continue
      update((draft) => {
        draft.warned.push(warning.key)
      })
      untrack(() => toast.show({ variant: "warning", title: "Ollama context window", message: warning.message }))
    }
  })
  return {
    status,
    showHint: (line: KeteLocalPicker.Unreachable) =>
      toast.show({ variant: "warning", title: line.text, message: line.hint.replaceAll("`", "") }),
  }
}
