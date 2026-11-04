// The new-session prompt "Sign in to Kete Code to use your organization's models": shown in the empty
// state while nobody is signed in (and not offline). Its button opens Settings -> Account, where the
// sign-in flow lives (gui-plugins/src/kete/account); it disappears when the account changes.

import { Button } from "@opencode/ui/button"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { useServer } from "@/runtime/server/current"
import { useSettingsSurface, type SettingsPluginTab } from "@/settings/surface"
import { useWorkspaceLocation } from "@/workspaces/location"
import { fetchStatus, fromEvent, settingsTab, shouldShow } from "./account-prompt-state"
import "./panel.css"

export function KeteAccountPrompt() {
  const server = useServer()
  const location = useWorkspaceLocation()
  const settings = useSettingsSurface()
  const [dismissed, setDismissed] = createSignal(false)
  // Advisory: an older runtime without `kete.account`, or a failed request, shows nothing.
  const [status, { refetch }] = createResource(
    () => location().ref,
    (ref) => fetchStatus(server.ctx.sdk.api, ref).catch(() => undefined),
  )
  onCleanup(
    server.ctx.sdk.event.listen((event) => {
      if (fromEvent(event)) void refetch()
    }),
  )
  return (
    <Show when={!dismissed() && shouldShow(status())}>
      <div data-kete="account-prompt" role="status">
        <p>Sign in to Kete Code to use your organization's models</p>
        <div data-kete="account-prompt-actions">
          {/* SAFETY: the id is the SettingsPage the gui-plugins `kete-account` plugin registers. */}
          <Button size="small" variant="contrast" onClick={() => settings.open(settingsTab as SettingsPluginTab)}>
            Sign in
          </Button>
          <Button size="small" variant="ghost" onClick={() => setDismissed(true)}>
            Not now
          </Button>
        </div>
      </div>
    </Show>
  )
}
