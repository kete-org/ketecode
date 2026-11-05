/** @jsxImportSource @opentui/solid */
// Vim mode in the prompt (parity C2, spec P5, docs/vim-mode.md): the per-prompt controller that feeds keys to
// the engine (`vim.ts`) and applies its result to the textarea, and the `/vim` command (a builtin plugin).
//
// The textarea's offsets are display columns from the start of the text (`text-columns.ts`); the engine's are
// string indices. Each change is applied as one replacement through the textarea's own editing calls,
// so attachment marks (files, pasted text) move with the text like any other edit.

import type { CursorStyleOptions, KeyEvent, TextareaRenderable, WidthMethod } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { useConfig } from "../config"
import { Keymap } from "../context/keymap"
import { useToast } from "../ui/toast"
import { columnOf, indexOf } from "./text-columns"
import { diff, initial, label, press, type Buffer, type Key, type State } from "./vim"

export const COMMAND = "kete.vim.toggle"

/** The engine's key from a terminal key event. */
export function keyOf(event: Pick<KeyEvent, "name" | "sequence" | "ctrl" | "meta" | "shift">): Key {
  const printable = event.sequence && [...event.sequence].length === 1 && event.sequence >= " " && event.sequence !== "\x7f"
  const char = event.ctrl || event.meta ? undefined : printable ? event.sequence : event.name.length === 1 ? (event.shift ? event.name.toUpperCase() : event.name) : undefined
  return { name: event.name, ...(char ? { char } : {}), ...(event.ctrl ? { ctrl: true } : {}), ...(event.meta ? { meta: true } : {}) }
}

export function read(textarea: Pick<TextareaRenderable, "plainText" | "cursorOffset">, widthMethod: WidthMethod): Buffer {
  const text = textarea.plainText
  return { text, cursor: indexOf(text, textarea.cursorOffset, widthMethod) }
}

/** Applies `after` to the textarea, which shows `before`, as one replacement plus a cursor move. */
export function write(
  textarea: Pick<TextareaRenderable, "setSelection" | "deleteSelection" | "insertText" | "cursorOffset">,
  before: Buffer,
  after: Buffer,
  widthMethod: WidthMethod,
) {
  const change = diff(before.text, after.text)
  if (change.end > change.start || change.insert) {
    const start = columnOf(before.text, change.start, widthMethod)
    if (change.end > change.start) {
      textarea.setSelection(start, columnOf(before.text, change.end, widthMethod))
      textarea.deleteSelection()
    }
    textarea.cursorOffset = start
    if (change.insert) textarea.insertText(change.insert)
  }
  textarea.cursorOffset = columnOf(after.text, after.cursor, widthMethod)
}

/** One prompt's vim mode. `input` is the prompt's textarea. */
export function useKeteVim(input: () => TextareaRenderable | undefined) {
  const config = useConfig()
  const renderer = useRenderer()
  const keymap = Keymap.use()
  const enabled = () => config.data.vim === true
  const [state, setState] = createSignal<State>(initial("insert"))

  const current = () => {
    const textarea = input()
    return textarea && !textarea.isDestroyed ? read(textarea, renderer.widthMethod) : undefined
  }
  // Turning vim on (or a new prompt) starts in insert mode, so typing works as before.
  createEffect(on(enabled, () => setState(initial("insert", current()))))

  // Before the textarea and the app's bindings; after the selection handler (101), which only acts on a selection.
  const off = keymap.intercept(
    "key",
    ({ event, consume }) => {
      const textarea = input()
      if (!enabled() || !textarea || textarea.isDestroyed || renderer.currentFocusedEditor !== textarea) return
      // While autocomplete is open, Esc and the arrows belong to it.
      if (textarea.traits.capture?.includes("escape") && state().mode === "insert") return
      const before = read(textarea, renderer.widthMethod)
      // The prompt's first insert starts here (the textarea wasn't mounted when the state was made).
      const previous = state()
      const ready = previous.mode === "insert" && !previous.insertStart ? { ...previous, insertStart: before } : previous
      const result = press(ready, before, keyOf(event))
      setState(result.state)
      if (!result.handled) return
      consume()
      write(textarea, before, result.buffer, renderer.widthMethod)
    },
    { priority: 100 },
  )
  onCleanup(off)

  return {
    enabled,
    /** The status line's label, or undefined when vim is off. */
    label: () => (enabled() ? label(state()) : undefined),
    /** A block cursor in normal mode. */
    cursorStyle: (style: CursorStyleOptions): CursorStyleOptions =>
      enabled() && state().mode === "normal" && !state().typing ? { ...style, style: "block" } : style,
    /** After a prompt is sent or cleared: a fresh change history, back in insert mode. */
    reset: () => setState((previous) => ({ ...initial("insert", { text: "", cursor: 0 }), register: previous.register })),
  }
}

function Commands(props: { context: Plugin.Context }) {
  const config = useConfig()
  const toast = useToast()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        title: "Toggle vim keys in the prompt",
        group: "Prompt",
        palette: true,
        slash: { name: "vim" },
        run: () => {
          const next = config.data.vim !== true
          config
            .update((draft) => {
              draft.vim = next
            })
            .then(
              () =>
                toast.show({
                  variant: "info",
                  title: next ? "Vim keys on" : "Vim keys off",
                  message: next ? "Esc for normal mode, i to type. /vim again turns them off." : "The prompt types as usual.",
                }),
              toast.error,
            )
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "kete.vim",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
