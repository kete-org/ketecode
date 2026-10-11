// New-session notices shared by the VS Code chat panel (packages/kete-vscode/src/panel.ts) and the
// TUI home screen (packages/tui/src/kete/home-notices.tsx), so their wording can't drift. Only the
// slash command that picks an agent differs: the web UI's is `/agent`, the TUI's is `/agents`.
// Plain data and pure functions: no Node imports, so the extension bundle stays clean.

import { displayName } from "./brand.js"

export type NoticeID = "portal-agents" | "agents-md"

export type Notice = {
  readonly id: NoticeID
  readonly title: string
  readonly body: string
  readonly isNew?: boolean
}

export const IDS: readonly NoticeID[] = ["portal-agents", "agents-md"]

const MAX_DISMISSED = 50

/** The notices in display order. `body` may use backtick spans (`AGENTS.md`); clients render them
 *  as code, never as markup. `agentCommand` is the client's own command for picking an agent. */
export function list(input: { agentCommand: string }): readonly Notice[] {
  return [
    {
      id: "portal-agents",
      title: "Agents from your portal",
      body: `Agents you set up in the ${displayName} Portal sync here automatically. Pick one with \`${input.agentCommand}\`.`,
      isNew: true,
    },
    {
      id: "agents-md",
      title: "Kete reads your AGENTS.md",
      body: "Project conventions in `AGENTS.md` load at the start of every session.",
    },
  ]
}

function known(id: string): id is NoticeID {
  return (IDS as readonly string[]).includes(id)
}

/** Adds `id` to `dismissed`, only if it names a real notice, deduped and capped. Unknown ids
 *  (an older or newer client's) are ignored rather than growing the list forever. */
export function dismiss(dismissed: readonly string[], id: string): string[] {
  if (!known(id) || dismissed.includes(id)) return [...dismissed]
  return [...dismissed, id].slice(-MAX_DISMISSED)
}

export type Segment = { readonly type: "text" | "code"; readonly value: string }

/** Splits a notice body into plain text and backtick code spans. An unmatched backtick stays text. */
export function segments(body: string): Segment[] {
  const result: Segment[] = []
  let rest = body
  while (rest.length > 0) {
    const open = rest.indexOf("`")
    const close = open === -1 ? -1 : rest.indexOf("`", open + 1)
    if (open === -1 || close === -1) {
      result.push({ type: "text", value: rest })
      break
    }
    if (open > 0) result.push({ type: "text", value: rest.slice(0, open) })
    if (close > open + 1) result.push({ type: "code", value: rest.slice(open + 1, close) })
    rest = rest.slice(close + 1)
  }
  return result
}

export * as KeteNotices from "./notices.js"
