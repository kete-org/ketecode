// `/` in the desktop/web app: the composer-first home. It opens (or reuses) a new-session draft, which
// is the new-session screen (new-session/view.tsx), the way the titlebar's New tab does from Home.
// Upstream's Home, the project and session browser, stays at `/?view=sessions` (the sidebar's
// "View more") and is also what shows when there is no server or project to open a draft in.
// The decision is home-action.ts's.

import { useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, Show } from "solid-js"
import { createHomeController } from "@/home/model"
import { Home } from "@/home/route"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { homeAction } from "./home-action"

export function KeteHome() {
  const [search] = useSearchParams<{ view?: string }>()
  const home = createHomeController()
  const tabs = useTabs()
  // Once per mount, so a draft that is later closed never reopens itself in a loop.
  let acted = false

  const action = createMemo(() => {
    const conn = home.server.focused()
    return homeAction({
      view: search.view,
      ready: tabs.ready(),
      server: conn ? ServerConnection.key(conn) : undefined,
      directory: home.project.newSession()?.worktree,
      tabs: tabs.store,
    })
  })

  createEffect(() => {
    const current = action()
    if (acted) return
    if (current.kind === "reuse") {
      acted = true
      tabs.select(current.tab)
    } else if (current.kind === "new") {
      acted = true
      void tabs.newDraft({ server: current.server, directory: current.directory })
    }
  })

  return (
    <Show when={action().kind === "home"}>
      <Home />
    </Show>
  )
}
