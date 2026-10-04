// The chat panel's own parts: the header above the empty state, the empty state itself (hero mark,
// tip, dismissible notices) and the dismissible CLI hint above the composer. Styled by panel.css;
// content (notices, the CLI hint, the tip's platform) comes from panel-state.ts, which the VS Code
// bridge fills in over `kete.panel` — the browser shows none of it (D4). Dismissing hides locally
// right away and tells the extension (vscode-host.tsx), whose next `kete.panel` is authoritative.

import { For, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Brand } from "@opencode/util/kete/brand"
import { KeteMark } from "./mark"
import { KeteWordmark } from "./wordmark"
import {
  dismissCliHintLocally,
  dismissNoticeLocally,
  panelState,
  segments,
  tipKeys,
  tipVisible,
  type Notice,
  type Platform,
} from "./panel-state"
import { dismissCliHint, dismissNotice } from "./vscode-host"
import "./panel.css"

export function KetePanelHeader() {
  return (
    <header data-kete="panel-header">
      <KeteMark class="kete-panel-header-mark" decorative />
      <KeteWordmark class="kete-panel-header-wordmark" />
    </header>
  )
}

export function KeteEmptyState() {
  const state = panelState
  return (
    <div data-kete="empty-state">
      <KeteMark class="kete-hero-mark" decorative />
      <Show when={tipVisible(state())}>
        <p class="kete-tip">
          Select any code and press <TipKeys platform={state().platform} /> to ask Kete about it
        </p>
      </Show>
      <Show when={tipVisible(state()) && state().notices.length > 0}>
        <ul class="kete-notices" aria-label="What's new">
          <For each={state().notices}>{(notice) => <NoticeCard notice={notice} />}</For>
        </ul>
      </Show>
    </div>
  )
}

export function KeteCliHint() {
  const state = panelState
  return (
    <Show when={tipVisible(state()) && state().cliHint}>
      <div data-kete="cli-hint" role="status">
        <Icon name="terminal" />
        <p>
          {Brand.displayName} also runs in your terminal: <code>{Brand.cliName}</code>
        </p>
        <IconButton
          type="button"
          icon={<Icon name="close-small" />}
          variant="ghost-muted"
          size="small"
          aria-label="Dismiss"
          onClick={() => {
            dismissCliHintLocally()
            dismissCliHint()
          }}
        />
      </div>
    </Show>
  )
}

function TipKeys(props: { platform: Platform }) {
  const keys = () => tipKeys(props.platform)
  return (
    <>
      <kbd>{keys()[0]}</kbd>
      <kbd>{keys()[1]}</kbd>
    </>
  )
}

function NoticeCard(props: { notice: Notice }) {
  return (
    <li class="kete-notice" classList={{ "kete-notice-new": !!props.notice.isNew }}>
      <h2>{props.notice.title}</h2>
      <p>
        <Segments text={props.notice.body} />
      </p>
      <IconButton
        type="button"
        icon={<Icon name="close-small" />}
        variant="ghost-muted"
        size="small"
        class="kete-notice-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          dismissNoticeLocally(props.notice.id)
          dismissNotice(props.notice.id)
        }}
      />
    </li>
  )
}

/** Renders backtick spans as `<code>`, everything else as plain text — never `innerHTML`. */
function Segments(props: { text: string }) {
  return (
    <For each={segments(props.text)}>{(segment) => (segment.type === "code" ? <code>{segment.value}</code> : segment.value)}</For>
  )
}
