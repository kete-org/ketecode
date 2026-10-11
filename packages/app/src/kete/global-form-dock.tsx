// The dock for session-less questions above the composer (global-forms.ts explains which and why):
// lists the current location's `"global"` forms from the data store, which keeps them current from
// `form.*` events, and shows the first one. A reply carries the location.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { choose, dismiss, OWNER, pick, view, type Actions } from "./global-forms"
import "./panel.css"

export function KeteGlobalFormDock() {
  const serverSDK = useServerSDK()
  const data = useData()
  const workspace = useWorkspaceLocation()
  const location = createMemo(() => ({ directory: workspace().ref.directory }), undefined, {
    equals: (a, b) => a.directory === b.directory,
  })
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string>()

  createEffect(() => {
    const ref = location()
    if (serverSDK.connection.status() !== "connected") return
    void data.session.form.sync(OWNER, ref).catch(() => undefined)
  })

  const form = createMemo(() => pick(data.session.form.list(OWNER, location())))
  const shown = createMemo(() => {
    const current = form()
    return current ? view(current) : undefined
  })
  const actions: Actions = {
    reply: (input, ref) => data.session.form.reply(input, ref),
    cancel: (input, ref) => data.session.form.cancel(input, ref),
  }
  const run = (work: () => Promise<void>) => {
    if (sending()) return
    setSending(true)
    setError(undefined)
    work()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false))
  }

  return (
    <Show when={shown()}>
      {(current) => (
        <section data-kete="global-form" data-trust={current().trust} aria-label={current().title} role="group">
          <div data-kete="global-form-title">{current().title}</div>
          <Show when={current().description}>
            <div data-kete="global-form-description">{current().description}</div>
          </Show>
          <div data-kete="global-form-actions">
            <For each={current().choices}>
              {(choice) => (
                <button
                  type="button"
                  data-kete="global-form-choice"
                  data-value={choice.value}
                  title={choice.description}
                  disabled={sending()}
                  onClick={() => run(() => choose(actions, form()!, choice.value, location()))}
                >
                  {choice.label}
                </button>
              )}
            </For>
            <Show when={current().choices.length === 0}>
              <button
                type="button"
                data-kete="global-form-choice"
                disabled={sending()}
                onClick={() => run(() => dismiss(actions, form()!, location()))}
              >
                Dismiss
              </button>
            </Show>
          </div>
          <Show when={error()}>
            <div data-kete="global-form-error" role="alert">
              {error()}
            </div>
          </Show>
        </section>
      )}
    </Show>
  )
}
