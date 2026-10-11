// New-session notices and the tip on the home screen (docs/home-notices.md), under the logo
// (routes/home.tsx). The notice text is shared with the VS Code chat panel
// (@opencode/util/kete/notices); the TUI passes its own agent command, `/agents`.
//
// - "Agents from your portal": only while signed in, not offline, with managed agents in the
//   runtime's sync cache (the `kete.sync` `status` RPC).
// - "Kete reads your AGENTS.md": only when the location's directory has an `AGENTS.md` (`fs.list`,
//   so it also works with `kete attach` to another machine's server).
// Both are asked once per home mount and location, with a timeout; an error hides the notice and is
// logged at debug level. Dismissals (✕, or "Dismiss home notices" in the command palette) persist
// in TUI storage `kete-notices`. One tip per launch shows only when no notice is visible; it is off
// with `"tips": false` in cli.json. Under 12 rows nothing shows, so the prompt keeps its space.

import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { KeteSyncRpc } from "@opencode/schema/kete/sync"
import { KeteNotices, type Notice, type Segment } from "@opencode/util/kete/notices"
import { useTerminalDimensions } from "@opentui/solid"
import { Schema } from "effect"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useConfig } from "../config"
import { useClient } from "../context/client"
import { Keymap } from "../context/keymap"
import { useLocation } from "../context/location"
import { useLog } from "../context/log"
import { useStorage } from "../context/storage"
import { useTheme } from "../context/theme"
import { stringWidth } from "../util/string-width"
import { truncateWidth } from "../util/locale"
import { pickTip, TIPS } from "./home-tips"

/** Below this terminal height neither notices nor the tip show. */
export const MIN_ROWS = 12
/** The widest a notice or tip line gets, so long lines stay readable on wide terminals. */
export const MAX_WIDTH = 100
export const AGENT_COMMAND = "/agents"
export const STORAGE_KEY = "kete-notices"
export const DISMISS_COMMAND = "kete.notices.dismiss"
const TIMEOUT = 15_000
/** A notice's rows: the title and the body, plus a blank line above every notice but the first. */
export const NOTICE_ROWS = 2
export const TIP_ROWS = 1

/** How many whole notices fit in `rows`. */
export function fitCount(rows: number) {
  if (rows < NOTICE_ROWS) return 0
  return 1 + Math.floor((rows - NOTICE_ROWS) / (NOTICE_ROWS + 1))
}

export type Conditions = {
  /** Undefined when the status couldn't be read: the portal notice is then hidden. */
  readonly sync: KeteSyncRpc.Status | undefined
  readonly agentsMd: boolean
}

/** Which notices show, in list order. */
export function visibleNotices(input: {
  readonly notices: readonly Notice[]
  readonly conditions: Conditions
  readonly dismissed: readonly string[]
}): Notice[] {
  const { sync, agentsMd } = input.conditions
  return input.notices.filter((notice) => {
    if (input.dismissed.includes(notice.id)) return false
    if (notice.id === "portal-agents") return !!sync && sync.signedIn && !sync.offline && sync.managedAgents > 0
    if (notice.id === "agents-md") return agentsMd
    return false
  })
}

const decodeStatus = Schema.decodeUnknownPromise(KeteSyncRpc.Status)

/** Asks the runtime both conditions. Never rejects: a failed request hides its notice and is reported to `onError`. */
export async function fetchNoticeConditions(
  client: Pick<OpenCodeClient, "rpc" | "file">,
  location: LocationRef | undefined,
  onError: (what: "sync status" | "AGENTS.md", error: unknown) => void,
): Promise<Conditions> {
  const [sync, files] = await Promise.allSettled([
    client.rpc
      .call(
        { rpcID: KeteSyncRpc.ID, method: "status", input: {}, location },
        { signal: AbortSignal.timeout(TIMEOUT) },
      )
      .then((response) => decodeStatus(response.output)),
    client.file.list({ location }, { signal: AbortSignal.timeout(TIMEOUT) }),
  ])
  if (sync.status === "rejected") onError("sync status", sync.reason)
  if (files.status === "rejected") onError("AGENTS.md", files.reason)
  return {
    sync: sync.status === "fulfilled" ? sync.value : undefined,
    agentsMd:
      files.status === "fulfilled" &&
      files.value.data.some((entry) => entry.type === "file" && entry.path === "AGENTS.md"),
  }
}

/** Fits segments into `width` columns, truncating the last one that doesn't fit with an ellipsis. */
export function fitSegments(segments: readonly Segment[], width: number): Segment[] {
  const result: Segment[] = []
  let room = width
  for (const segment of segments) {
    if (room <= 0) break
    const size = stringWidth(segment.value)
    if (size <= room) {
      result.push(segment)
      room -= size
      continue
    }
    result.push({ type: segment.type, value: truncateWidth(segment.value, room) })
    break
  }
  return result
}

/** Dismissed ids from storage, ignoring anything that isn't a list of strings (a hand-edited file). */
function dismissedOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function KeteHomeNotices() {
  const client = useClient()
  const location = useLocation()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const config = useConfig().data
  const log = useLog({ component: "kete.home-notices" })
  const storage = useStorage()
  const [state, update] = storage.store<{ dismissed: string[] }>(STORAGE_KEY, { initial: { dismissed: [] } })
  // Picked once per launch: the memory entry outlives Home remounts and is gone when the TUI exits.
  const [tip] = storage.memory("kete-home-tip", { initial: { index: Math.floor(Math.random() * TIPS.length) } })
  const notices = KeteNotices.list({ agentCommand: AGENT_COMMAND })

  // Read `client.api` on each call: it is replaced on reconnect.
  const [conditions] = createResource(
    () => ({ location: location.ref }),
    (source) =>
      fetchNoticeConditions(client.api, source.location, (what, error) =>
        log.debug(`home notice condition unavailable: ${what}`, {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  )

  const tall = () => dimensions().height >= MIN_ROWS
  const width = () => Math.max(1, Math.min(MAX_WIDTH, dimensions().width - 4))
  const visible = createMemo(() => {
    const current = conditions()
    if (!current) return []
    return visibleNotices({ notices, conditions: current, dismissed: dismissedOf(state.dismissed) })
  })
  // Each notice keeps a fixed slot, so the column's natural height never depends on what fits; the
  // column shrinks before the prompt does, and only the notices whole within its height render.
  const slots = () => (tall() ? visible() : [])
  const [rows, setRows] = createSignal(0)
  const shown = createMemo(() => slots().slice(0, fitCount(rows())))
  // Only once the conditions are known, so a tip never flashes before a notice replaces it.
  const tipText = () => {
    if (!tall() || config.tips === false || conditions() === undefined || visible().length > 0) return undefined
    return pickTip(tip.index)
  }

  const dismiss = (ids: readonly string[]) =>
    update((draft) => {
      draft.dismissed = ids.reduce((list, id) => KeteNotices.dismiss(list, id), dismissedOf(draft.dismissed))
    }).catch((error: unknown) =>
      log.warn("home notice dismissal not saved", { error: error instanceof Error ? error.message : String(error) }),
    )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: shown().length > 0,
    commands: [
      {
        id: DISMISS_COMMAND,
        title: "Dismiss home notices",
        group: "System",
        palette: true,
        run() {
          void dismiss(shown().map((notice) => notice.id))
        },
      },
    ],
  }))

  // One column, centered under the logo as a group.
  return (
    <Show when={slots().length > 0 || tipText()}>
      <box
        flexDirection="column"
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        maxWidth={width()}
        onSizeChange={function () {
          setRows(this.height)
        }}
      >
        <For each={slots()}>
          {(notice, index) => (
            <box
              flexShrink={0}
              flexDirection="column"
              height={NOTICE_ROWS + (index() > 0 ? 1 : 0)}
              paddingTop={index() > 0 ? 1 : 0}
            >
              <Show when={index() < shown().length}>
                <box flexDirection="row" gap={2}>
                  <text fg={theme.text.base} wrapMode="none">
                    <b>{truncateWidth(notice.title, width() - (notice.isNew ? 5 : 0) - 3)}</b>
                    <Show when={notice.isNew}>
                      <span style={{ fg: theme.text.action.primary.selected }}> New</span>
                    </Show>
                  </text>
                  <box flexShrink={0} onMouseUp={() => void dismiss([notice.id])}>
                    <text fg={theme.text.muted}>✕</text>
                  </box>
                </box>
                <text fg={theme.text.muted} wrapMode="none">
                  <For each={fitSegments(KeteNotices.segments(notice.body), width())}>
                    {(segment) =>
                      segment.type === "code" ? (
                        <span style={{ fg: theme.text.action.primary.selected }}>{segment.value}</span>
                      ) : (
                        segment.value
                      )
                    }
                  </For>
                </text>
              </Show>
            </box>
          )}
        </For>
        <Show when={tipText()}>
          {(text) => (
            <box flexShrink={0} height={TIP_ROWS}>
              <Show when={rows() >= TIP_ROWS}>
                <text fg={theme.text.muted} wrapMode="none">
                  {truncateWidth(`Tip: ${text()}`, width())}
                </text>
              </Show>
            </box>
          )}
        </Show>
      </box>
    </Show>
  )
}
