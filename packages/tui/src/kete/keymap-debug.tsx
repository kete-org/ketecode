// `/keymap debug` (parity C3, spec P6): while on, every key press shows a toast with the key as the
// TUI parsed it, the raw bytes the terminal sent, and what the keymap did with it (the command it ran,
// a pending sequence, or no binding). Keys keep working as usual, so the result is what really happens
// where the focus is. `/keymap debug` again turns it off. For triaging Alt/Ctrl keys across terminals.

import type { KeyEvent } from "@opentui/core"
import type { KeyAfterReason } from "@opentui/keymap"
import { useKeymap } from "@opentui/keymap/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { Keymap } from "../context/keymap"
import { useToast } from "../ui/toast"

export const COMMAND = "kete.keymap.debug"

/** What the keymap did with a key. */
export type Outcome =
  | { kind: "command"; id: string; title?: string }
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "other"; reason: KeyAfterReason }

/** The key the way bindings are written, e.g. `ctrl+alt+k` (the terminal's Meta/Option is `alt`). */
export function keyName(event: Pick<KeyEvent, "name" | "ctrl" | "meta" | "shift" | "super">) {
  const modifiers = [event.ctrl && "ctrl", event.meta && "alt", event.shift && "shift", event.super && "super"]
  return [...modifiers.filter(Boolean), event.name || "?"].join("+")
}

/** The raw bytes with control characters escaped, e.g. `\x1b.`. */
export function rawText(raw: string) {
  return Array.from(raw, (char) => {
    const code = char.codePointAt(0)!
    return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : char
  }).join("")
}

export function describe(outcome: Outcome) {
  switch (outcome.kind) {
    case "command":
      return `runs ${outcome.id}${outcome.title ? ` (${outcome.title})` : ""}`
    case "pending":
      return "starts a key sequence: waiting for the next key"
    case "none":
      return "no binding: the key goes to the focused input"
    case "other":
      return {
        "intercept-consumed": "handled by the focused component",
        "binding-handled": "handled by a binding",
        "binding-rejected": "a binding matched, but its command is disabled here",
        "no-match": "no binding: the key goes to the focused input",
        "sequence-pending": "starts a key sequence: waiting for the next key",
        "sequence-miss": "no binding continues the sequence",
        "sequence-cleared": "the key sequence was cleared",
      }[outcome.reason]
  }
}

export function outcomeOf(reason: KeyAfterReason, command: { id: string; title?: string } | undefined): Outcome {
  if (reason === "binding-handled" && command) return { kind: "command", ...command }
  if (reason === "sequence-pending") return { kind: "pending" }
  if (reason === "no-match") return { kind: "none" }
  return { kind: "other", reason }
}

export function useKeteKeymapDebug() {
  const keymap = useKeymap()
  const toast = useToast()
  const [on, setOn] = createSignal(false)

  createEffect(() => {
    if (!on()) return
    let ran: { id: string; title?: string } | undefined
    const title = (id: string) => {
      const command = keymap.getCommands({ visibility: "registered" }).find((item) => item.name === id)
      const value = command?.opencode?.title ?? command?.title
      return typeof value === "string" ? value : undefined
    }
    const dispose: Array<() => void> = []
    let disposed = false
    onCleanup(() => {
      disposed = true
      dispose.forEach((item) => item())
    })
    // After the current key: from the command palette the command runs during the Enter key, whose own
    // key:after would otherwise replace the "on" toast.
    queueMicrotask(() => {
      if (disposed) return
      dispose.push(
      keymap.on("dispatch", (event) => {
        if (disposed) return
        if (event.phase !== "binding-execute") return
        const id = typeof event.command === "string" ? event.command : undefined
        const desc = event.binding?.attrs?.desc
        ran = id ? { id, title: title(id) } : { id: "an inline binding", title: typeof desc === "string" ? desc : undefined }
      }),
      keymap.intercept("key:after", (context) => {
        // The keymap runs the hooks it had when the key arrived, so a just-removed one can still run once.
        if (disposed) return
        const event = context.event as KeyEvent
        const outcome = outcomeOf(context.reason, ran)
        ran = undefined
        toast.show({
          title: `Key: ${keyName(event)}`,
          message: `${describe(outcome)}\nraw: ${rawText(event.raw ?? event.sequence ?? "")}`,
          variant: "info",
          duration: 4000,
        })
      }),
      )
    })
  })

  const run = (input?: string) => {
    const argument = input?.trim() ?? ""
    if (argument !== "" && argument !== "debug") {
      toast.show({ title: "Keymap", message: "Usage: /keymap debug", variant: "info" })
      return
    }
    const next = !on()
    setOn(next)
    toast.show({
      title: next ? "Key debugging on" : "Key debugging off",
      message: next ? "Each key shows what it does. Run /keymap debug again to stop." : "Keys no longer show toasts.",
      variant: "info",
    })
  }

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        group: "System",
        title: "Debug key presses",
        bind: false,
        palette: true as const,
        slash: { name: "keymap", arguments: true as const },
        run,
      },
    ],
  }))
}
