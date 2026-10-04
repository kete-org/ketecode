// State the chat panel's header, empty state, CLI hint and composer read, independent of Solid's
// component tree so both panel.tsx and vscode-host.tsx (the VS Code bridge, commit 3) can update it.
// Browser defaults show nothing extra: no tip (an editor keybinding), no CLI hint, no notices (D4);
// the VS Code host posts its own `kete.panel` message to fill these in.

import { createSignal } from "solid-js"

export type Platform = "mac" | "other"
export type Host = "browser" | "vscode"
export type PermissionMode = "default" | "ask"

export type Notice = {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly isNew?: boolean
}

export type PanelState = {
  readonly host: Host
  readonly platform: Platform
  readonly notices: readonly Notice[]
  readonly cliHint: boolean
  readonly defaultMode: PermissionMode
}

/** The chat's "select code, press ..." tip: ⌥K on macOS (matching the extension's `kete.addToChat`
 *  keybinding), spelled out as Alt K elsewhere. */
export function tipKeys(platform: Platform): readonly [string, string] {
  return platform === "mac" ? ["⌥", "K"] : ["Alt", "K"]
}

export type Segment = { readonly type: "text" | "code"; readonly value: string }

/**
 * Splits `text` on backtick pairs into text/code segments for rendering as `<code>` spans — never
 * `innerHTML`, so HTML-looking notice text (from the extension or, eventually, a server) can never
 * become markup. An odd number of backticks is ambiguous (an unterminated span), so the whole string
 * renders as plain text rather than guessing which backtick was meant to close.
 */
export function segments(text: string): Segment[] {
  if (text === "") return []
  const parts = text.split("`")
  if (parts.length % 2 === 0) return [{ type: "text", value: text }]
  return parts
    .map((value, index): Segment => ({ type: index % 2 === 1 ? "code" : "text", value }))
    .filter((segment) => segment.value !== "")
}

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other"
  return /mac/i.test(navigator.platform || navigator.userAgent) ? "mac" : "other"
}

const [panelState, setPanelStateSignal] = createSignal<PanelState>({
  host: "browser",
  platform: detectPlatform(),
  notices: [],
  cliHint: false,
  defaultMode: "default",
})

export { panelState }

/** Merges a partial update (e.g. the VS Code bridge's `kete.panel` message) into the panel state. */
export function updatePanelState(patch: Partial<PanelState>) {
  setPanelStateSignal((current) => ({ ...current, ...patch }))
}

/** ⌥K/Alt K is an editor keybinding, so the tip only makes sense inside the VS Code host (D4). */
export function tipVisible(state: PanelState): boolean {
  return state.host === "vscode"
}

export function dismissNoticeLocally(id: string) {
  setPanelStateSignal((current) => ({ ...current, notices: current.notices.filter((notice) => notice.id !== id) }))
}

export function dismissCliHintLocally() {
  setPanelStateSignal((current) => ({ ...current, cliHint: false }))
}
