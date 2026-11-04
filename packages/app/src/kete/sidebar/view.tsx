// The sidebar body as plain data and callbacks (sidebar.tsx connects it to the app). Kept free of app
// contexts so a story can render it with fixed data for the component tests.

import { createSignal, For, Show, type JSX, type ParentProps } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { relativeTime } from "./records"
import "../tokens.css"
import "./sidebar.css"

export type SidebarSession = { readonly id: string; readonly title: string; readonly time: number }
export type SidebarProjectView = {
  readonly name: string
  /** Every session of the project, not only the ones listed. */
  readonly count: number
  readonly sessions: readonly SidebarSession[]
}

function Section(props: ParentProps<{ title: string; count: number }>) {
  const [open, setOpen] = createSignal(true)
  return (
    <section data-kete="sidebar-section">
      <button type="button" data-kete="sidebar-section-title" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} />
        <span>{props.title}</span>
        <span data-kete="sidebar-count">{props.count}</span>
      </button>
      <Show when={open()}>{props.children}</Show>
    </section>
  )
}

export function KeteSidebarView(props: {
  /** All sessions known, for the count; `sessions` is the part listed. */
  total: number
  sessions: readonly SidebarSession[]
  more: boolean
  projects: readonly SidebarProjectView[]
  currentId?: string
  now: number
  onSearch: () => void
  onNewSession: () => void
  onSettings: () => void
  onOpen: (id: string) => void
  onMore: () => void
  /** Rendered at the start of each session row, e.g. the busy dot. */
  status?: (id: string) => JSX.Element
  footer?: JSX.Element
}) {
  const Row = (row: { session: SidebarSession }) => (
    <button
      type="button"
      data-kete="sidebar-session"
      aria-current={props.currentId === row.session.id ? "page" : undefined}
      onClick={() => props.onOpen(row.session.id)}
    >
      {props.status?.(row.session.id)}
      <span data-kete="sidebar-session-title">{row.session.title}</span>
      <span data-kete="sidebar-session-time">{relativeTime(row.session.time, props.now)}</span>
    </button>
  )

  return (
    <nav data-kete="sidebar" aria-label="Kete Code">
      <div data-kete="sidebar-nav">
        <button type="button" onClick={() => props.onSearch()}>
          <Icon name="magnifying-glass" />
          <span>Search</span>
        </button>
        <button type="button" onClick={() => props.onNewSession()}>
          <Icon name="plus" />
          <span>New session</span>
        </button>
        <button type="button" onClick={() => props.onSettings()}>
          <Icon name="settings-gear" />
          <span>Settings</span>
        </button>
      </div>
      <div data-kete="sidebar-scroll">
        <Section title="Sessions" count={props.total}>
          <For each={props.sessions}>{(session) => <Row session={session} />}</For>
          <Show when={props.more}>
            <button type="button" data-kete="sidebar-more" onClick={() => props.onMore()}>
              View more
            </button>
          </Show>
        </Section>
        <Section title="Projects" count={props.projects.length}>
          <For each={props.projects}>
            {(project) => (
              <div data-kete="sidebar-project">
                <div data-kete="sidebar-project-name">
                  <Icon name="folder" />
                  <span>{project.name}</span>
                  <span data-kete="sidebar-count">{project.count}</span>
                </div>
                <For each={project.sessions}>{(session) => <Row session={session} />}</For>
              </div>
            )}
          </For>
        </Section>
      </div>
      {props.footer}
    </nav>
  )
}
