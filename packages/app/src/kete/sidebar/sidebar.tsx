// The desktop/web sidebar body: Search, New session, Settings, then the recent Sessions and the
// Projects with theirs, and the account footer (account.tsx). It replaces the body of upstream's
// vertical sidebar (shell/titlebar/titlebar.tsx, one marked wrap); the sidebar's header row,
// collapse, resize and shortcut stay upstream's. The data is the Home page's own pipeline
// (home/sessions/controller.tsx), minus its project filter and its command registration; view.tsx
// draws it.

import { useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createHomeController } from "@/home/model"
import { HOME_SESSION_LIMIT, mergeHomeSessionIndex, retainHomeSessions } from "@/home/sessions/index"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { buildHomeSessionRecords, type HomeSessionRecord } from "@/home/sessions/records"
import { HomeSessionStatusController } from "@/home/sessions/controller"
import { useCommand } from "@/shell/commands/command"
import { useCurrentRoute } from "@/shell/state/layout"
import { ServerConnection } from "@/runtime/server/registry"
import { useSettingsSurface } from "@/settings/surface"
import { sessionHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { sessionLabel } from "@/session/title"
import { KeteModeSwitchConnector } from "../mode-switch/mode-switch"
import { KeteSidebarAccount } from "./account"
import { projectGroups, recentSessions } from "./records"
import { KeteSidebarView, type SidebarSession } from "./view"

const SESSIONS_SHOWN = 8
const PER_PROJECT = 3

export function KeteSidebar(props: { newSession: () => unknown }) {
  const home = createHomeController()
  const tabs = useTabs()
  const command = useCommand()
  const navigate = useNavigate()
  const settings = useSettingsSurface()
  const route = useCurrentRoute()
  // Relative times ("5 min ago") refresh once a minute.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(tick))

  const load = useQuery(() => {
    const ctx = home.server.focusedContext()
    return {
      ...homeSessionsQuery(home.server.focused(), ctx),
      enabled: !!ctx && ctx.sdk.connection.status() === "connected",
    }
  })

  const records = createMemo<HomeSessionRecord[]>(() => {
    const ctx = home.server.focusedContext()
    if (!ctx) return []
    const sessions = retainHomeSessions(
      ctx.data.session.apply(
        mergeHomeSessionIndex(load.isPending ? [] : (load.data?.() ?? []), ctx.data.session.list()),
      ),
      HOME_SESSION_LIMIT,
      Date.now(),
    )
    return buildHomeSessionRecords({
      sessions: () => sessions,
      projectDirectories: () => undefined,
      projects: home.project.list,
      resolveProject: (session) => ctx.projects.forSession(session),
    })
  })

  const row = (record: HomeSessionRecord): SidebarSession => ({
    id: record.session.id,
    title: sessionLabel(record.session),
    time: record.session.time.updated ?? record.session.time.created,
  })
  const recent = createMemo(() => recentSessions(records(), SESSIONS_SHOWN))
  const groups = createMemo(() =>
    projectGroups(
      records(),
      home.project.list().map((project) => ({ worktree: project.worktree, name: project.name })),
      PER_PROJECT,
    ),
  )
  const currentId = () => {
    const current = route()
    return current.type === "session" ? current.sessionId : undefined
  }

  // The switch acts on the new-session draft's workspace: only a draft tab carries a directory.
  const draftWorkspace = () => {
    const current = route()
    const conn = home.server.focused()
    const ctx = home.server.focusedContext()
    if (current.type !== "draft" || !conn || !ctx) return undefined
    const server = ServerConnection.key(conn)
    const tab = tabs.store.find((item) => item.type === "draft" && item.draftID === current.draftID)
    if (tab?.type !== "draft" || tab.server !== server) return undefined
    return { ctx, server, directory: tab.directory }
  }

  // Remounts the switch when the workspace changes, so each starts from its own saved choice.
  const workspaceKey = createMemo(() => {
    const workspace = draftWorkspace()
    return workspace ? workspace.server + "\n" + workspace.directory : undefined
  })

  const open = (id: string) => {
    const conn = home.server.focused()
    const record = records().find((item) => item.session.id === id)
    if (conn && record) home.project.openProjectSession(conn, record.project.worktree, record.session)
  }

  const status = (id: string) => {
    const conn = home.server.focused()
    const record = records().find((item) => item.session.id === id)
    if (!conn || !record) return undefined
    const key = ServerConnection.key(conn)
    return (
      <HomeSessionStatusController
        server={key}
        record={record}
        isOpenTab={(item) => sessionHasOpenTab(tabs.store, key, item.session)}
        render={(state) => (
          <span data-kete="sidebar-busy" data-busy={state.loading() ? "" : undefined} aria-hidden="true" />
        )}
      />
    )
  }

  return (
    <KeteSidebarView
      total={records().length}
      sessions={recent().items.map(row)}
      more={recent().more}
      projects={groups().map((group) => ({
        name: group.name,
        count: group.count,
        sessions: group.sessions.map(row),
      }))}
      currentId={currentId()}
      now={now()}
      onSearch={() => command.trigger("sessions.search")}
      onNewSession={() => props.newSession()}
      onSettings={() => settings.open()}
      onOpen={open}
      onMore={() => navigate("/?view=sessions")}
      status={status}
      mode={
        <Show when={workspaceKey()} keyed>
          {(_key) => {
            const workspace = draftWorkspace()
            return workspace ? <KeteModeSwitchConnector {...workspace} /> : undefined
          }}
        </Show>
      }
      footer={<KeteSidebarAccount ctx={home.server.focusedContext()} />}
    />
  )
}
