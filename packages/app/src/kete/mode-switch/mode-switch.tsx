// Connects the Code | Work switch to the app: the runtime's mode list (`kete.modes`), the workspace's
// remembered choice, and the hand-off to the new-session composer. The sidebar mounts one per
// (server, directory) of the current draft, so a new workspace starts from its own saved choice.

import { createEffect, createResource } from "solid-js"
import type { ServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Schema } from "effect"
import { KeteModeSwitch } from "./state"
import { KeteModeSwitchView } from "./view"

const Saved = Persistence.struct({ mode: Persistence.optional(Schema.String) })

export function KeteModeSwitchConnector(props: { ctx: ServerCtx; server: string; directory: string }) {
  const language = useLanguage()
  const [modes] = createResource(
    () => props.ctx,
    (ctx) => KeteModeSwitch.fetchModes(ctx.sdk.api),
  )
  const [saved, setSaved, , ready] = persisted(
    Persist.serverWorkspace(props.ctx.sdk.scope, props.directory, "kete-mode"),
    Saved,
    {},
  )
  const list = () => modes() ?? KeteModeSwitch.CODE_ONLY
  const selected = () => KeteModeSwitch.effective(saved.mode, list())

  // Until both are loaded nothing is chosen, so a submit then creates a Code session.
  createEffect(() => {
    if (!ready() || modes.loading) return
    KeteModeSwitch.choose(props.server, props.directory, selected())
  })

  return (
    <KeteModeSwitchView
      modes={list()}
      selected={selected()}
      label={language.t("kete.mode.label")}
      unavailable={language.t("kete.mode.unavailable")}
      onSelect={(id) => setSaved("mode", id)}
    />
  )
}
