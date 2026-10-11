// The configurable status line (docs/statusline.md): one row under the prompt that shows the items the
// user chose in `statusline.items` (config `cli.json`). The prompt renders `KeteStatusLineRow`; the
// `/statusline` command and the unknown-item warning are the builtin plugin at the bottom.
//
// - `fit` and `StatusLineView` are pure (testable without the app's contexts).
// - Items drop from the end when the row is too narrow. The sandbox warning is pinned: it shows
//   whenever it applies, even if it is not in the list, and is dropped last (CLAUDE.md section 9).

import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { LocationRef } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"
import { KeteOffline } from "@opencode/util/kete/offline"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { useConfig } from "../config"
import { useClient } from "../context/client"
import { locationKey, useData } from "../context/data"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useLog } from "../context/log"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { abbreviateHome } from "../runtime"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { truncateFilePath } from "../ui/file-path"
import { useToast } from "../ui/toast"
import type { useWorkingDirectoryActions } from "../ui/working-directory-actions"
import { contextUsage } from "../util/session"
import { stringWidth } from "../util/string-width"
import { account, balanceText } from "./balance"
import { KeteLocalPicker, offlineFrom } from "./local-models"
import { useKetePermissionMode } from "./permission-mode"
import { fetchSandboxStatus, label as sandboxLabel } from "./sandbox-status"
import { footerLabel, useTodos } from "./todo"
import {
  descriptions,
  ITEMS,
  labels,
  move,
  parse,
  reset,
  save,
  toggle,
  type ItemID,
} from "./statusline-config"

export type Tone = "muted" | "accent" | "warning" | "error"

export type Entry = {
  id: ItemID
  text: string
  tone: Tone
  /** A leading glyph that keeps the warning colour even when colours are off. */
  glyph?: string
}

export type Palette = { base: RGBA; muted: RGBA; accent: RGBA; warning: RGBA; error: RGBA }

type DirectoryActions = Pick<
  ReturnType<typeof useWorkingDirectoryActions>,
  "hovered" | "onMouseOver" | "onMouseOut" | "onMouseUp"
>

const SEPARATOR = " · "

const widthOf = (entry: Entry) => stringWidth(entry.text) + (entry.glyph ? stringWidth(entry.glyph) + 1 : 0)

const totalWidth = (entries: ReadonlyArray<Entry>) =>
  entries.reduce((sum, entry, index) => sum + widthOf(entry) + (index > 0 ? stringWidth(SEPARATOR) : 0), 0)

/** The narrowest the directory gets before other items are dropped. */
export const DIRECTORY_MIN = 12

/**
 * The entries that fit in `width` columns on one line: the directory shortens first (down to
 * DIRECTORY_MIN), then items drop from the end, the directory last. The sandbox warning is never dropped.
 */
export function fit(entries: ReadonlyArray<Entry>, width: number): Entry[] {
  const kept = [...entries]
  const shorten = () => {
    const index = kept.findIndex((entry) => entry.id === "directory")
    const entry = kept[index]
    if (!entry) return false
    const over = totalWidth(kept) - width
    const target = Math.max(DIRECTORY_MIN, widthOf(entry) - over)
    if (target >= widthOf(entry)) return false
    kept[index] = { ...entry, text: truncateFilePath(entry.text, target) }
    return true
  }
  while (totalWidth(kept) > width) {
    if (shorten()) continue
    const other = kept.findLastIndex((entry) => entry.id !== "sandbox" && entry.id !== "directory")
    // The directory goes last, once it can't shorten further and nothing else is left to drop.
    const index = other >= 0 ? other : kept.findIndex((entry) => entry.id === "directory")
    if (index < 0) break
    kept.splice(index, 1)
  }
  return kept
}

/** The warning shown when `statusline.items` has IDs that are not items. */
export function unknownMessage(unknown: ReadonlyArray<string>) {
  return `Unknown status line item${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Valid items: ${ITEMS.join(", ")}.`
}

export function StatusLineView(props: {
  entries: ReadonlyArray<Entry>
  colors: boolean
  palette: Palette
  directory?: DirectoryActions
}) {
  const color = (entry: Entry) => {
    if (entry.id === "directory" && props.directory?.hovered()) return props.palette.base
    if (!props.colors || entry.tone === "muted") return props.palette.muted
    return props.palette[entry.tone]
  }
  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
      <For each={props.entries}>
        {(entry, index) => (
          <>
            <Show when={index() > 0}>
              <text fg={props.palette.muted} wrapMode="none" flexShrink={0}>
                {SEPARATOR}
              </text>
            </Show>
            <text
              id={`statusline.${entry.id}`}
              fg={color(entry)}
              wrapMode="none"
              truncate
              flexShrink={entry.id === "directory" ? 1 : 0}
              onMouseOver={entry.id === "directory" ? props.directory?.onMouseOver : undefined}
              onMouseOut={entry.id === "directory" ? props.directory?.onMouseOut : undefined}
              onMouseUp={entry.id === "directory" ? props.directory?.onMouseUp : undefined}
            >
              <Show when={entry.glyph}>
                <span style={{ fg: props.palette.warning }}>{entry.glyph} </span>
              </Show>
              {entry.text}
            </text>
          </>
        )}
      </For>
    </box>
  )
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function contextEntry(left: number | undefined): Entry | undefined {
  if (left === undefined) return
  const clamped = Math.min(100, Math.max(0, left))
  return {
    id: "context",
    text: `${clamped}% left`,
    tone: clamped <= 5 ? "error" : clamped <= 20 ? "warning" : "muted",
  }
}

export type SandboxState = { kind: "status"; status: KeteSandboxRpc.Status } | { kind: "unknown" }

/** The sandbox warning: the status label, or "Sandbox status unknown" when the status call failed. */
export function sandboxText(state: SandboxState | undefined): string | undefined {
  if (!state) return undefined
  if (state.kind === "unknown") return "Sandbox status unknown"
  return sandboxLabel(state.status)
}

export function modeEntry(mode: KetePermissionModes.Mode | undefined): Entry {
  const current = mode ?? "default"
  return {
    id: "mode",
    text: KetePermissionModes.label[current],
    tone: current === "plan" || current === "ask" ? "warning" : current === "auto" ? "accent" : "muted",
  }
}

export function KeteStatusLineRow(props: {
  sessionID?: string
  /** Where the prompt will work. Absent while a turn runs, which hides the directory and branch. */
  location?: LocationRef
  actions?: DirectoryActions
}) {
  const config = useConfig()
  const data = useData()
  const client = useClient()
  const currentLocation = useLocation()
  const local = useLocal()
  const theme = useTheme()
  const paths = useTuiPaths()
  const mode = useKetePermissionMode()
  const dimensions = useTerminalDimensions()
  const log = useLog({ component: "kete.statusline" })
  // Half the terminal until the row measures itself, so the first frame can't overflow.
  const [width, setWidth] = createSignal(Math.floor(dimensions().width / 2))

  const parsed = createMemo(() => parse(config.data.statusline))
  const sessionLocation = createMemo(
    () => (props.sessionID ? data.session.get(props.sessionID)?.location : undefined) ?? currentLocation.ref,
  )
  const todos = useTodos(
    {
      // Read on each use: the client's API object is replaced when it reconnects.
      get client() {
        return client.api
      },
      data,
      get location() {
        return currentLocation.ref
      },
    },
    () => (parsed().items.includes("todo") ? props.sessionID : undefined),
  )
  // A signal, not a resource: reading a pending resource would suspend the prompt (and the screen around it)
  // until the RPC answers. Fetched once per location (keyed by locationKey, not object identity); a stale
  // answer for an earlier location is dropped. A failed call is shown as "unknown", never as sandboxed.
  const [sandbox, setSandbox] = createSignal<SandboxState>()
  const sandboxKey = createMemo(() => {
    const location = sessionLocation()
    return location ? locationKey(location) : ""
  })
  createEffect(
    on(sandboxKey, () => {
      let current = true
      onCleanup(() => (current = false))
      fetchSandboxStatus(client.api, untrack(sessionLocation))
        .then((status) => current && setSandbox({ kind: "status", status }))
        .catch((error: unknown) => {
          if (!current) return
          log.warn("sandbox status unavailable", { error: error instanceof Error ? error.message : String(error) })
          setSandbox({ kind: "unknown" })
        })
    }),
  )

  const memo = (fn: () => Entry | undefined): Accessor<Entry | undefined> => createMemo(fn)
  const item: Record<ItemID, Accessor<Entry | undefined>> = {
    directory: memo(() => {
      if (!props.location) return
      // Full path here; fit() shortens it to the room the other items leave.
      return { id: "directory", text: abbreviateHome(props.location.directory, paths.home), tone: "muted" }
    }),
    branch: memo(() => {
      if (!props.location) return
      const branch = data.location.vcs.info(props.location)?.branch.current
      return branch ? { id: "branch", text: branch, tone: "accent" } : undefined
    }),
    mode: memo(() => modeEntry(mode.current())),
    context: memo(() => {
      if (!props.sessionID) return
      const session = data.session.get(props.sessionID)
      if (!session) return
      const usage = contextUsage(
        data.session.message.list(props.sessionID),
        data.location.model.list(session.location),
        session.revert?.messageID,
      )
      return usage?.percent === undefined ? undefined : contextEntry(100 - usage.percent)
    }),
    model: memo(() => {
      if (!local.model.current()) return
      const variant = local.model.variant.current()
      const name = local.model.parsed().model
      return { id: "model", text: variant ? `${name} ${variant}` : name, tone: "muted" }
    }),
    sandbox: memo(() => {
      const text = sandboxText(sandbox())
      return text ? { id: "sandbox", text, tone: "warning", glyph: "⚠" } : undefined
    }),
    balance: memo(() => {
      const metadata = data.location.integration.list(sessionLocation())?.find((entry) => entry.id === "kete")?.metadata
      const text = balanceText(metadata)
      const value = account(metadata)
      if (!text || !value) return
      return { id: "balance", text, tone: value.micros <= 0 ? "error" : "muted" }
    }),
    todo: memo(() => {
      const text = footerLabel(todos())
      return text ? { id: "todo", text, tone: "muted" } : undefined
    }),
    "local-model": memo(() =>
      offlineFrom(KeteOffline.enabled(), data.location.config.list(currentLocation.ref))
        ? { id: "local-model", text: KeteLocalPicker.offlineLabel, tone: "muted" }
        : undefined,
    ),
    cost: memo(() => {
      if (!props.sessionID) return
      const cost = data.session.cost(props.sessionID)
      return cost > 0 ? { id: "cost", text: money.format(cost), tone: "muted" } : undefined
    }),
  }

  const entries = createMemo(() => {
    const ids: ItemID[] = [...parsed().items]
    // The sandbox warning is never hidden by configuration.
    if (!ids.includes("sandbox")) ids.push("sandbox")
    return ids.map((id) => item[id]()).filter((entry): entry is Entry => entry !== undefined)
  })
  const visible = createMemo(() => fit(entries(), width()))

  return (
    <box
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      onSizeChange={function (this: BoxRenderable) {
        const next = this.width
        queueMicrotask(() => setWidth(next))
      }}
    >
      <StatusLineView
        entries={visible()}
        colors={parsed().colors}
        directory={props.actions}
        palette={{
          base: theme.text.base,
          muted: theme.text.muted,
          accent: theme.hue.accent[500],
          warning: theme.text.feedback.warning.base,
          error: theme.text.feedback.error.base,
        }}
      />
    </box>
  )
}

function Picker() {
  const config = useConfig()
  const dialog = useDialog()
  const toast = useToast()
  const parsed = createMemo(() => parse(config.data.statusline))
  const apply = (items: ReadonlyArray<ItemID>, colors: boolean) =>
    void config.update(save(items, colors)).catch(toast.error)

  const itemMenu = (id: ItemID) =>
    dialog.replace(() => (
      <DialogSelect
        title={labels[id]}
        renderFilter={false}
        options={[
          { title: "Hide", value: "hide" },
          { title: "Move earlier", value: "earlier" },
          { title: "Move later", value: "later" },
        ]}
        onSelect={(option) => {
          const { items, colors } = parsed()
          if (option.value === "hide") apply(toggle(items, id), colors)
          else apply(move(items, id, option.value === "earlier" ? -1 : 1), colors)
          dialog.replace(() => <Picker />)
        }}
      />
    ))

  const options = createMemo(() => [
    ...ITEMS.map((id) => {
      const position = parsed().items.indexOf(id)
      return {
        title: labels[id],
        description: descriptions[id],
        footer: position < 0 ? "off" : `on · ${position + 1}`,
        value: id as ItemID | "colors" | "reset",
      }
    }),
    { title: `Colours: ${parsed().colors ? "on" : "off"}`, footer: undefined, description: undefined, value: "colors" as const },
    { title: "Reset to default", footer: undefined, description: undefined, value: "reset" as const },
  ])

  return (
    <DialogSelect
      title="Status line"
      options={options()}
      renderFilter={false}
      preserveSelection
      onSelect={(option) => {
        const { items, colors } = parsed()
        if (option.value === "colors") return apply(items, !colors)
        if (option.value === "reset") return apply(reset(), colors)
        if (items.includes(option.value)) return itemMenu(option.value)
        apply(toggle(items, option.value), colors)
      }}
    />
  )
}

function Commands(props: { context: Plugin.Context }) {
  const config = useConfig()
  const dialog = useDialog()
  const toast = useToast()

  let warned = ""
  createEffect(() => {
    const unknown = parse(config.data.statusline).unknown
    const key = unknown.join("\n")
    if (key === warned) return
    warned = key
    if (unknown.length > 0) toast.show({ variant: "warning", title: "Status line", message: unknownMessage(unknown), duration: 10_000 })
  })

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "statusline.configure",
        title: "Configure status line",
        group: "System",
        slash: { name: "statusline" },
        palette: true,
        run() {
          dialog.replace(() => <Picker />)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "kete.statusline",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
