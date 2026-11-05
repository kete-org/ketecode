/** @jsxImportSource @opentui/solid */
// Transcript search (parity C1, spec P4, docs/transcript-search.md): `<leader>/` or `/find` opens a bar above
// the prompt that searches the open session's rendered text (every loaded message, as shown: collapsed tool
// output and hidden thinking aren't searched). The newest match is selected and scrolled into view; ↑/↓ (and
// n/N after Enter) walk older and newer matches. The match is highlighted with the renderer's text selection.
// Esc closes the bar and clears the highlight.

import { TextBufferRenderable, type InputRenderable, type Renderable, type ScrollBoxRenderable, type WidthMethod } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { useConfig } from "../config"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { stringWidth } from "../util/string-width"
import { columnOf } from "./text-columns"

export const COMMAND = "session.search"

/** Each case-insensitive, non-overlapping occurrence of `query` in `text`, as offsets into `text` itself. */
export function findOffsets(text: string, query: string): { start: number; end: number }[] {
  if (query === "") return []
  // A regex, not lower-cased copies: lower-casing changes some characters' length ("İ"), which would shift offsets.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length }))
}

type Laid = { readonly plainText: string; readonly lineInfo: { lineStartCols: number[] } }

/** The cell (column, visual row) inside a laid-out text of the character at `offset`. */
function cell(node: Laid, offset: number, widthMethod: WidthMethod) {
  // `lineStartCols` are display columns from the start of the text (kete/text-columns.ts).
  const col = columnOf(node.plainText, offset, widthMethod)
  const starts = node.lineInfo.lineStartCols
  let row = 0
  while (row + 1 < starts.length && starts[row + 1]! <= col) row++
  return { col: col - (starts[row] ?? 0), row }
}

/** Where a selection of `[start, end)` begins and ends (both inclusive cells), relative to the text's origin. */
export function selectionCells(node: Laid, start: number, end: number, widthMethod: WidthMethod) {
  return { anchor: cell(node, start, widthMethod), focus: cell(node, Math.max(start, end - 1), widthMethod) }
}

export type Hit = { readonly node: TextBufferRenderable; readonly start: number; readonly end: number }

/** Every match under `root`, top to bottom (depth-first, children in order). */
export function collect(root: Renderable, query: string, widthMethod: WidthMethod): Hit[] {
  const hits: Hit[] = []
  const visit = (node: Renderable) => {
    if (!node.visible || node.isDestroyed) return
    if (node instanceof TextBufferRenderable) {
      for (const { start, end } of findOffsets(node.plainText, query)) {
        // Rows clipped away by the node's height (a collapsed tool input) aren't shown, so aren't matches.
        if (selectionCells(node, start, end, widthMethod).anchor.row >= Math.max(1, node.height)) continue
        hits.push({ node, start, end })
      }
      return
    }
    for (const child of node.getChildren()) visit(child as Renderable)
  }
  visit(root)
  return hits
}

export type KeteTranscriptSearch = {
  readonly active: Accessor<boolean>
  readonly query: Accessor<string>
  /** 1-based position of the selected match, and the number of matches. */
  readonly position: Accessor<{ readonly index: number; readonly total: number }>
  /** After Enter: n/N walk matches instead of typing. */
  readonly navigating: Accessor<boolean>
  open(): void
  close(): void
  search(query: string): void
  /** -1 is older (up), +1 newer (down); wraps around. */
  move(direction: -1 | 1): void
  setNavigating(value: boolean): void
}

export function createKeteTranscriptSearch(input: {
  readonly scroll: () => ScrollBoxRenderable | undefined
  /** Mounts every loaded row (the transcript mounts its newest rows first), then runs the continuation. */
  readonly ensureAllRows: (continuation: () => void) => void
  readonly afterLayout: (continuation: () => void) => void
  readonly onClose: () => void
}): KeteTranscriptSearch {
  const renderer = useRenderer()
  const [active, setActive] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [position, setPosition] = createSignal({ index: 0, total: 0 })
  const [navigating, setNavigating] = createSignal(false)
  let index = -1
  // Each step's highlight waits for layout; only the latest step's may apply.
  let generation = 0

  const highlight = (hit: Hit) => {
    renderer.clearSelection()
    const { anchor, focus } = selectionCells(hit.node, hit.start, hit.end, renderer.widthMethod)
    renderer.startSelection(hit.node, hit.node.x + anchor.col, hit.node.y + anchor.row)
    // Finished, not a drag in progress: otherwise the next mouse-up would copy the match (copy on select).
    renderer.updateSelection(hit.node, hit.node.x + focus.col, hit.node.y + focus.row, { finishDragging: true })
  }

  // Matches are found again on every step: streaming replies and re-renders replace text nodes.
  const show = (pick: (total: number) => number) => {
    const current = ++generation
    input.ensureAllRows(() => {
      if (current !== generation) return
      const scroll = input.scroll()
      if (!scroll || scroll.isDestroyed || !active()) return
      const hits = collect(scroll, query(), renderer.widthMethod)
      if (hits.length === 0) {
        index = -1
        setPosition({ index: 0, total: 0 })
        renderer.clearSelection()
        return
      }
      index = pick(hits.length)
      setPosition({ index: index + 1, total: hits.length })
      const hit = hits[index]!
      const row = hit.node.y + selectionCells(hit.node, hit.start, hit.end, renderer.widthMethod).anchor.row
      const top = scroll.viewport.y
      if (row < top || row >= top + scroll.viewport.height) {
        scroll.stickyScroll = false
        scroll.scrollTo(Math.max(0, scroll.scrollTop + row - top - Math.floor(scroll.viewport.height / 3)))
      }
      input.afterLayout(() => {
        if (current === generation && !hit.node.isDestroyed && active()) highlight(hit)
      })
    })
  }

  const close = () => {
    if (!active()) return
    setActive(false)
    setQuery("")
    setNavigating(false)
    setPosition({ index: 0, total: 0 })
    index = -1
    generation++
    renderer.clearSelection()
    input.onClose()
  }
  onCleanup(() => {
    if (active()) renderer.clearSelection()
  })

  return {
    active,
    query,
    position,
    navigating,
    open() {
      setActive(true)
    },
    close,
    search(value) {
      setQuery(value)
      setNavigating(false)
      show((total) => total - 1)
    },
    move(direction) {
      if (position().total === 0) return
      show((total) => (((index === -1 ? total : index) + direction) % total + total) % total)
    },
    setNavigating(value) {
      if (value && position().total === 0) return
      setNavigating(value)
      // The app's selection handler clears the highlight on this key; show the same match again.
      if (position().total > 0) show((total) => Math.min(Math.max(index, 0), total - 1))
    },
  }
}

const LABEL = "find: "
const PLACEHOLDER = "search this session"

/** The search row above the prompt. */
export function KeteTranscriptSearchBar(props: { readonly search: KeteTranscriptSearch }) {
  const theme = useTheme()
  const config = useConfig().data
  const [target, setTarget] = createSignal<InputRenderable | undefined>()
  const navigating = () => props.search.navigating()
  const renderer = useRenderer()
  const keymap = Keymap.use()

  // Esc and Ctrl+C must close the bar in one press: the app's selection handler (priority 101) would otherwise
  // take them to clear (or, with manual copying, copy) the highlight first.
  const offEscape = keymap.intercept(
    "key",
    ({ event, consume }) => {
      const close = event.name === "escape" || (event.ctrl && event.name === "c")
      if (!close || !props.search.active() || renderer.currentFocusedEditor !== target()) return
      consume()
      props.search.close()
    },
    { priority: 102 },
  )
  onCleanup(offEscape)

  Keymap.createLayer(() => ({
    priority: 2,
    target,
    enabled: target() !== undefined && props.search.active(),
    commands: [
      { bind: "up", title: "Older match", group: "Session", run: () => props.search.move(-1) },
      { bind: "down", title: "Newer match", group: "Session", run: () => props.search.move(1) },
      {
        bind: "return",
        title: "Walk matches with n and N",
        group: "Session",
        run: () => (navigating() ? props.search.move(-1) : props.search.setNavigating(true)),
      },
      // After Enter, these walk matches instead of typing; `/` goes back to editing the query.
      { bind: "n", title: "Older match", group: "Session", enabled: navigating, run: () => props.search.move(-1) },
      { bind: "shift+n", title: "Newer match", group: "Session", enabled: navigating, run: () => props.search.move(1) },
      { bind: "/", title: "Edit search", group: "Session", enabled: navigating, run: () => props.search.setNavigating(false) },
    ],
  }))

  const status = () => {
    const { index, total } = props.search.position()
    if (!props.search.query()) return ""
    if (total === 0) return "no matches"
    return `${index}/${total}`
  }
  const hint = () =>
    navigating() ? "n older · N newer · / edit · Esc close" : "↑ older · ↓ newer · Enter then n/N · Esc close"

  return (
    <box flexDirection="row" flexShrink={0} width="100%" paddingLeft={2} paddingRight={2}>
      <text fg={theme.text.muted} wrapMode="none">
        {LABEL}
      </text>
      <input
        width={Math.min(30, Math.max(stringWidth(PLACEHOLDER) + 1, stringWidth(props.search.query()) + 2))}
        onInput={(value: string) => props.search.search(value)}
        focusedBackgroundColor={theme.background.formfield.focused}
        cursorColor={theme.text.formfield.focused}
        cursorStyle={config.cursor}
        focusedTextColor={theme.text.formfield.focused}
        placeholder={PLACEHOLDER}
        placeholderColor={theme.text.muted}
        ref={(r: InputRenderable) => {
          r.traits = { status: "FIND" }
          setTarget(r)
          r.focus()
        }}
      />
      <box flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={1} flexDirection="row">
        <Show when={status()}>
          <text fg={props.search.position().total === 0 ? theme.text.muted : theme.hue.accent[500]} wrapMode="none">
            {status() + "  "}
          </text>
        </Show>
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {hint()}
        </text>
      </box>
    </box>
  )
}

/** The `session.search` command (`<leader>/`, `/find`) for one session view. */
export function useKeteTranscriptSearchCommand(search: KeteTranscriptSearch, enabled: () => boolean) {
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: enabled(),
    commands: [
      {
        id: COMMAND,
        title: "Search this session",
        group: "Session",
        palette: true as const,
        slash: { name: "find" },
        run: () => search.open(),
      },
    ],
  }))
}
