// `kete terminal-setup`: says whether Shift+Enter already inserts a newline in this terminal and what
// to change if not (@opencode/util/kete/terminal-setup). The one change it makes itself is a VS Code
// family keybinding in the person's own keybindings.json, and only after a yes (or --yes): the file is
// read as JSONC, the binding appended once, a backup kept, and the new file written beside it then
// renamed into place. Every side effect is in `Deps`, so tests never touch a real editor's settings.

export * as KeteTerminalSetupFlow from "./terminal-setup-flow"

import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { KeteTerminalSetup } from "@opencode/util/kete/terminal-setup"

export interface Deps {
  readonly env: KeteTerminalSetup.Environment
  readonly platform: string
  readonly home: string
  readonly join: (...parts: string[]) => string
  /** The file's text, `undefined` when it doesn't exist. */
  readonly read: (file: string) => Promise<string | undefined>
  /** Writes `text` to `file` (creating its folder), replacing it in one step. */
  readonly write: (file: string, text: string) => Promise<void>
  readonly copy: (from: string, to: string) => Promise<void>
  readonly now: () => Date
  readonly interactive: boolean
  readonly confirm: (message: string) => Promise<boolean>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export interface Input {
  readonly editor?: KeteTerminalSetup.Editor
  /** Add the keybinding without asking. */
  readonly yes: boolean
  /** Only print the guidance; change nothing. */
  readonly print: boolean
}

type Added = { readonly kind: "added"; readonly backup?: string } | { readonly kind: "present" } | { readonly kind: "declined" } | { readonly kind: "failed"; readonly reason: string }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The keybindings.json text with the binding appended, or why it can't be. */
export function withKeybinding(text: string | undefined): { readonly kind: "ok"; readonly text: string } | { readonly kind: "present" } | { readonly kind: "invalid"; readonly reason: string } {
  const bom = text?.startsWith("﻿") ? "﻿" : ""
  const body = text?.slice(bom.length)
  const source = body === undefined || body.trim() === "" ? "[]" : body
  const errors: ParseError[] = []
  const list: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) return { kind: "invalid", reason: "it isn't valid JSON with comments" }
  if (!Array.isArray(list)) return { kind: "invalid", reason: "it isn't a list of keybindings" }
  if (KeteTerminalSetup.hasKeybinding(list)) return { kind: "present" }
  const edits = modify(source, [list.length], KeteTerminalSetup.KEYBINDING, {
    isArrayInsertion: true,
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: source.includes("\r\n") ? "\r\n" : "\n" },
  })
  return { kind: "ok", text: bom + applyEdits(source, edits) }
}

async function add(deps: Deps, editor: KeteTerminalSetup.Editor, yes: boolean): Promise<Added> {
  const name = KeteTerminalSetup.EDITORS[editor].name
  const file = KeteTerminalSetup.keybindingsPath(editor, deps.platform, deps.env, deps.home, deps.join)
  const current = await deps.read(file).catch((error: unknown) => {
    throw new Error(`Couldn't read ${file}: ${message(error)}`)
  })
  const next = withKeybinding(current)
  if (next.kind === "present") return { kind: "present" }
  if (next.kind === "invalid") return { kind: "failed", reason: `${file} wasn't changed: ${next.reason}. Add the keybinding yourself (above).` }
  if (!yes) {
    if (!deps.interactive) return { kind: "declined" }
    if (!(await deps.confirm(`Add the Shift+Enter keybinding to ${name}'s ${file}?`))) return { kind: "declined" }
  }
  let backup: string | undefined
  if (current !== undefined) {
    backup = `${file}.kete-backup-${deps.now().toISOString().replace(/[:.]/g, "-")}`
    await deps.copy(file, backup)
  }
  await deps.write(file, next.text)
  return { kind: "added", ...(backup ? { backup } : {}) }
}

/** Runs `kete terminal-setup`; returns the exit code. */
export async function run(deps: Deps, input: Input): Promise<number> {
  const detected = KeteTerminalSetup.detect(deps.env, deps.platform)
  const terminal: KeteTerminalSetup.Terminal = input.editor ? { kind: "editor", editor: input.editor } : detected
  const guide = KeteTerminalSetup.guidance(terminal, deps.env)
  for (const line of guide.lines) deps.out(line)
  if (input.print || terminal.kind !== "editor" || !terminal.editor) return 0
  const name = KeteTerminalSetup.EDITORS[terminal.editor].name
  deps.out("")
  if (KeteTerminalSetup.remote(deps.env)) {
    deps.out(`This is a remote session, so ${name} reads its keybindings on your local machine. Nothing changed here: add the keybinding there (above), or run kete terminal-setup in a local ${name} terminal.`)
    return 0
  }
  const result = await add(deps, terminal.editor, input.yes).catch((error: unknown): Added => ({ kind: "failed", reason: message(error) }))
  switch (result.kind) {
    case "present":
      deps.out(`${name} already has the keybinding. Nothing changed.`)
      return 0
    case "declined":
      deps.out(deps.interactive || input.yes ? "Nothing changed." : "Not a terminal, so nothing changed. Run it again with --yes to add the keybinding.")
      return 0
    case "added":
      deps.out(`Added the keybinding to ${name}.${result.backup ? ` The previous file is saved as ${result.backup}.` : ""} It applies in new terminals; reload the window if Shift+Enter still sends.`)
      return 0
    case "failed":
      deps.err(result.reason)
      return 1
  }
}
