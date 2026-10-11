/** @jsxImportSource @opentui/solid */
// Prompt history search (Ctrl+R, docs/history-search.md): the per-prompt controller and the one-line bar
// the prompt shows above its textarea while searching. The pure search lives in `history-search.ts`.
//
// The textarea is never changed while searching, so closing the bar (Esc, Ctrl+C) leaves the draft exactly
// as it was. Only Enter on a match puts that entry in the prompt, without sending it.

import type { InputRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { useConfig } from "../config"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import type { PromptInfo } from "../prompt/history"
import { stringWidth } from "../util/string-width"
import { excerpt, find, type Match } from "./history-search"

export type KeteHistorySearch = {
  readonly active: Accessor<boolean>
  readonly query: Accessor<string>
  readonly match: Accessor<Match | undefined>
  /** True after Ctrl+R found no older match; the bar says so until the query changes. */
  readonly exhausted: Accessor<boolean>
  open(): void
  close(): void
  search(query: string): void
  older(): void
  accept(): void
}

/** One controller per prompt instance (no global state). */
export function createKeteHistorySearch(input: {
  readonly entries: () => readonly PromptInfo[]
  readonly disabled: () => boolean
  readonly onAccept: (entry: PromptInfo) => void
}): KeteHistorySearch {
  const [active, setActive] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [match, setMatch] = createSignal<Match | undefined>()
  const [exhausted, setExhausted] = createSignal(false)
  // Texts this search has shown, so walking older never shows the same text twice.
  let shown = new Set<string>()

  const reset = (value: string) => {
    shown = new Set()
    setQuery(value)
    setExhausted(false)
    const found = find(input.entries(), value)
    if (found) shown.add(found.entry.text)
    setMatch(found)
  }

  const close = () => {
    if (!active()) return
    setActive(false)
    reset("")
  }

  // A permission or question prompt disables the prompt; the search goes away with it.
  createEffect(() => {
    if (input.disabled()) close()
  })
  onCleanup(close)

  return {
    active,
    query,
    match,
    exhausted,
    open() {
      if (input.disabled()) return
      reset("")
      setActive(true)
    },
    close,
    search: reset,
    older() {
      const current = match()
      if (!current) return
      const found = find(input.entries(), query(), current.index, shown)
      if (!found) {
        setExhausted(true)
        return
      }
      shown.add(found.entry.text)
      setExhausted(false)
      setMatch(found)
    },
    accept() {
      const found = match()
      close()
      if (found) input.onAccept(found.entry)
    },
  }
}

const LABEL = "history search: "
const PLACEHOLDER = "type to search"

/** The search row: label, the query input, and the newest match (its matched span highlighted). */
export function KeteHistorySearchBar(props: { readonly search: KeteHistorySearch }) {
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const [target, setTarget] = createSignal<InputRenderable | undefined>()

  Keymap.createLayer(() => ({
    // Above the prompt's own layers (priority 1), which are targeted at the textarea anyway.
    priority: 2,
    target,
    enabled: target() !== undefined && props.search.active(),
    commands: [
      // The configured `prompt.history.search` keys (Ctrl+R) walk to the next older match.
      { id: "prompt.history.search", title: "Older history match", group: "Prompt", run: () => props.search.older() },
      { bind: "return", title: "Use history match", group: "Prompt", run: () => props.search.accept() },
      { bind: "escape", title: "Cancel history search", group: "Prompt", run: () => props.search.close() },
      { bind: "ctrl+c", title: "Cancel history search", group: "Prompt", run: () => props.search.close() },
    ],
  }))

  const inputWidth = createMemo(() =>
    Math.min(30, Math.max(stringWidth(PLACEHOLDER) + 1, stringWidth(props.search.query()) + 2)),
  )
  // The prompt box's border and padding take a few columns; keep a safe margin.
  const room = createMemo(() => Math.max(8, dimensions().width - stringWidth(LABEL) - inputWidth() - 10))
  const line = createMemo(() => {
    const found = props.search.match()
    if (!found) return undefined
    return excerpt(found.entry.text, found.start, found.end, room())
  })

  return (
    <box flexDirection="row" flexShrink={0} width="100%">
      <text fg={theme.text.muted} wrapMode="none">
        {LABEL}
      </text>
      <input
        width={inputWidth()}
        onInput={(value: string) => props.search.search(value)}
        focusedBackgroundColor={theme.background.formfield.focused}
        cursorColor={theme.text.formfield.focused}
        cursorStyle={config.cursor}
        focusedTextColor={theme.text.formfield.focused}
        placeholder={PLACEHOLDER}
        placeholderColor={theme.text.muted}
        ref={(r: InputRenderable) => {
          r.traits = { status: "HISTORY SEARCH" }
          setTarget(r)
          r.focus()
        }}
      />
      <box flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={1}>
        <Show
          when={line()}
          fallback={
            <text fg={theme.text.muted} wrapMode="none">
              {props.search.query() ? "no match" : ""}
            </text>
          }
        >
          {(value) => (
            <text wrapMode="none" truncate>
              <span style={{ fg: theme.text.base }}>{value().before}</span>
              <span style={{ fg: theme.hue.accent[500] }}>{value().match}</span>
              <span style={{ fg: theme.text.base }}>{value().after}</span>
              <Show when={props.search.exhausted()}>
                <span style={{ fg: theme.text.muted }}> (no older match)</span>
              </Show>
            </text>
          )}
        </Show>
      </box>
    </box>
  )
}
