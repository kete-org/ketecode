// The chat panel's "what's new" notices and CLI hint: what the extension knows that the web UI
// (packages/app/src/kete/panel.tsx) doesn't — the host platform, the server's default permission
// mode, and this workspace's dismissals. No `vscode` import, so it's unit-testable with Bun;
// extension.ts owns the actual `context.globalState` reads/writes and posts the result as the
// `kete.panel` message (packages/app/src/kete/vscode-messages.ts validates it on the other side).

export type Platform = "mac" | "other"
export type PermissionMode = "default" | "ask"

export type Notice = {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly isNew?: boolean
}

// D5: content the user approved. `body` may use backtick spans (`AGENTS.md`); the web UI renders
// them as `<code>`, never as HTML.
export const NOTICES: readonly Notice[] = [
  {
    id: "portal-agents",
    title: "Agents from your portal",
    body: "Agents you set up in the Kete Code Portal sync here automatically. Pick one with `/agent`.",
    isNew: true,
  },
  {
    id: "agents-md",
    title: "Kete reads your AGENTS.md",
    body: "Project conventions in `AGENTS.md` load at the start of every session.",
  },
]

export const DISMISSED_NOTICES_KEY = "kete.panel.dismissedNotices"
export const CLI_HINT_DISMISSED_KEY = "kete.panel.cliHintDismissed"
const MAX_DISMISSED = 50

/** The subset of `vscode.Memento` (`context.globalState`) this needs; a plain object satisfies it in
 *  tests, so this file never imports `vscode`. */
export interface Store {
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): unknown
}

/** Adds `id` to `dismissed`, only if it names a real notice, deduped and capped. Unknown ids
 *  (an older or newer extension's) are ignored rather than growing the list forever. */
export function dismiss(dismissed: readonly string[], id: string): string[] {
  if (!NOTICES.some((notice) => notice.id === id) || dismissed.includes(id)) return [...dismissed]
  return [...dismissed, id].slice(-MAX_DISMISSED)
}

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
