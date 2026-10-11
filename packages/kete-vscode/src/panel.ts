// The chat panel's "what's new" notices and CLI hint: what the extension knows that the web UI
// (packages/app/src/kete/panel.tsx) doesn't — the host platform, the server's default permission
// mode, and this workspace's dismissals. No `vscode` import, so it's unit-testable with Bun;
// extension.ts owns the actual `context.globalState` reads/writes and posts the result as the
// `kete.panel` message (packages/app/src/kete/vscode-messages.ts validates it on the other side).

import { KeteNotices } from "@opencode/util/kete/notices"

export type Platform = "mac" | "other"
export type PermissionMode = "default" | "ask"

// D5: content the user approved, from the module the TUI home screen shares so the wording can't
// drift. `body` may use backtick spans (`AGENTS.md`); the web UI renders them as `<code>`, never as
// HTML. The panel's agent command is the web UI's `/agent` (the TUI passes its own `/agents`).
export type { Notice } from "@opencode/util/kete/notices"
export const NOTICES = KeteNotices.list({ agentCommand: "/agent" })

export const DISMISSED_NOTICES_KEY = "kete.panel.dismissedNotices"
export const CLI_HINT_DISMISSED_KEY = "kete.panel.cliHintDismissed"

/** The subset of `vscode.Memento` (`context.globalState`) this needs; a plain object satisfies it in
 *  tests, so this file never imports `vscode`. */
export interface Store {
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): unknown
}

/** Adds `id` to `dismissed`, only if it names a real notice, deduped and capped (shared with the TUI). */
export const dismiss = KeteNotices.dismiss

/** The `kete.panel` message body, from a dismissal list, whether the workspace's notice list ever
 *  had a chance to include something a future extension version removed. */
export function panelState(input: {
  dismissed: readonly string[]
  cliHintDismissed: boolean
  platform: Platform
  defaultMode: PermissionMode
}) {
  return {
    platform: input.platform,
    defaultMode: input.defaultMode,
    cliHint: !input.cliHintDismissed,
    notices: NOTICES.filter((notice) => !input.dismissed.includes(notice.id)),
  }
}

/** Reads persisted dismissals from `store` (a fresh read every time, so a reload sees them). */
export function loadPanelState(store: Store, input: { platform: Platform; defaultMode: PermissionMode }) {
  return panelState({
    dismissed: store.get<string[]>(DISMISSED_NOTICES_KEY, []),
    cliHintDismissed: store.get<boolean>(CLI_HINT_DISMISSED_KEY, false),
    platform: input.platform,
    defaultMode: input.defaultMode,
  })
}

export async function dismissNotice(store: Store, id: string) {
  await store.update(DISMISSED_NOTICES_KEY, dismiss(store.get<string[]>(DISMISSED_NOTICES_KEY, []), id))
}

export async function dismissCliHint(store: Store) {
  await store.update(CLI_HINT_DISMISSED_KEY, true)
}
