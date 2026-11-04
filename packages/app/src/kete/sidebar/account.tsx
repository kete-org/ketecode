// The sidebar footer: who is signed in (organization and platform host only, from `kete.account.status`),
// a Sign in button while nobody is, and the notifications button. Signing in itself lives in
// Settings -> Account (gui-plugins/src/kete/account); the status is advisory, so a runtime without
// `kete.account` or a failed request shows nothing.

import { createEffect, createResource, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import type { ServerCtx } from "@/runtime/server/runtime"
import { useSettingsSurface, type SettingsPluginTab } from "@/settings/surface"
import { fetchStatus, fromEvent, settingsTab } from "../account-prompt-state"
import { accountLabel, type AccountLabel } from "./records"

export function KeteSidebarAccount(props: { ctx: ServerCtx | undefined }) {
  const settings = useSettingsSurface()
  const [status, { refetch }] = createResource(
    () => props.ctx,
    (ctx) => fetchStatus(ctx.sdk.api, undefined).catch(() => undefined),
  )
  createEffect(() => {
    const ctx = props.ctx
    if (!ctx) return
    onCleanup(
      ctx.sdk.event.listen((event) => {
        if (fromEvent(event)) void refetch()
      }),
    )
  })
  const label = () => accountLabel(status())

  const who = (current: AccountLabel) => {
    switch (current.kind) {
      case "signed-in":
        return (
          <>
            <span data-kete="sidebar-account-name">{current.organization ?? "Signed in"}</span>
            <Show when={current.host}>
              <span data-kete="sidebar-account-host">{current.host}</span>
            </Show>
          </>
        )
      case "signed-out":
        return (
          // SAFETY: the id is the SettingsPage the gui-plugins `kete-account` plugin registers.
          <button type="button" onClick={() => settings.open(settingsTab as SettingsPluginTab)}>
            Sign in
          </button>
        )
      case "offline":
        return <span data-kete="sidebar-account-name">Offline</span>
    }
  }

  return (
    <div data-kete="sidebar-account">
      <div data-kete="sidebar-account-who">
        <Show when={label()}>{(current) => who(current())}</Show>
      </div>
      <button type="button" aria-label="Notifications" onClick={() => settings.open("notifications")}>
        <Icon name="notifications" />
      </button>
    </div>
  )
}
