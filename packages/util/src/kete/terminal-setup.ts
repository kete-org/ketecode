// `kete terminal-setup` (packages/cli/src/kete/terminal-setup.ts) and `/terminal-setup`
// (packages/tui/src/kete/terminal-setup.tsx): which terminal this is, whether Shift+Enter already
// inserts a newline in the prompt, and what to change when it doesn't. The terminal UI binds newline
// to Shift+Enter, Ctrl+Enter, Alt+Enter and Ctrl+J (tui/src/config/keybind.ts `input.newline`) and
// asks for the kitty keyboard protocol, so Shift+Enter works wherever the terminal reports it. Plain
// functions, no I/O: the CLI reads the environment, and writes the one change it can make (a VS Code
// family keybinding) only after the person agrees.

export * as KeteTerminalSetup from "./terminal-setup.js"

import { Brand } from "./brand.js"

export type Environment = Readonly<Record<string, string | undefined>>

const product = Brand.displayName
const cli = Brand.cliName

/** The VS Code family: editors whose integrated terminal needs a keybinding, and where it goes. */
export const EDITORS = {
  code: { name: "VS Code", folder: "Code" },
  insiders: { name: "VS Code Insiders", folder: "Code - Insiders" },
  cursor: { name: "Cursor", folder: "Cursor" },
  windsurf: { name: "Windsurf", folder: "Windsurf" },
  vscodium: { name: "VSCodium", folder: "VSCodium" },
} as const
export type Editor = keyof typeof EDITORS

export type Terminal =
  | { readonly kind: "native"; readonly name: string }
  | { readonly kind: "editor"; readonly editor: Editor | undefined }
  | { readonly kind: "iterm" }
  | { readonly kind: "apple" }
  | { readonly kind: "windows-terminal" }
  | { readonly kind: "unknown"; readonly name?: string }

/** Which editor of the VS Code family runs this terminal, from what each puts in the environment. */
export function editorOf(env: Environment): Editor | undefined {
  if (env.CURSOR_TRACE_ID) return "cursor"
  const hints = [env.__CFBundleIdentifier, env.VSCODE_GIT_ASKPASS_MAIN, env.VSCODE_GIT_ASKPASS_NODE, env.TERM_PROGRAM_VERSION]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
  if (/cursor|todesktop/.test(hints)) return "cursor"
  if (/windsurf|exafunction/.test(hints)) return "windsurf"
  if (/vscodium/.test(hints)) return "vscodium"
  if (/insider/.test(hints)) return "insiders"
  if (/vscode|visual studio code|microsoft/.test(hints) || env.TERM_PROGRAM === "vscode") return "code"
  return undefined
}

/** The terminal this runs in. A multiplexer is reported separately (`multiplexer`). */
export function detect(env: Environment, platform: string): Terminal {
  const program = env.TERM_PROGRAM
  if (program === "vscode") return { kind: "editor", editor: editorOf(env) }
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return { kind: "native", name: "kitty" }
  if (program === "WezTerm" || env.WEZTERM_PANE) return { kind: "native", name: "WezTerm" }
  if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return { kind: "native", name: "Ghostty" }
  if (env.ALACRITTY_WINDOW_ID || env.TERM === "alacritty") return { kind: "native", name: "Alacritty" }
  if (env.TERM === "foot" || env.TERM?.startsWith("foot-")) return { kind: "native", name: "foot" }
  if (program === "iTerm.app") return { kind: "iterm" }
  if (program === "Apple_Terminal") return { kind: "apple" }
  if (platform === "win32" && env.WT_SESSION) return { kind: "windows-terminal" }
  return { kind: "unknown", ...(program ? { name: program } : {}) }
}

export function multiplexer(env: Environment): "tmux" | "screen" | undefined {
  if (env.TMUX) return "tmux"
  if (env.STY) return "screen"
  return undefined
}

/** The keybinding that makes Shift+Enter send Alt+Enter (ESC, CR), which the prompt reads as newline. */
export const KEYBINDING = {
  key: "shift+enter",
  command: "workbench.action.terminal.sendSequence",
  args: { text: "\u001b\r" },
  when: "terminalFocus",
} as const

/** Where an editor keeps the person's keybindings (`User/keybindings.json` in its settings folder). */
export function keybindingsPath(editor: Editor, platform: string, env: Environment, home: string, join: (...parts: string[]) => string) {
  const folder = EDITORS[editor].folder
  if (platform === "darwin") return join(home, "Library", "Application Support", folder, "User", "keybindings.json")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), folder, "User", "keybindings.json")
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), folder, "User", "keybindings.json")
}

/** Whether a keybindings list already makes Shift+Enter send ESC CR in the terminal. */
export function hasKeybinding(list: unknown): boolean {
  if (!Array.isArray(list)) return false
  return list.some((item) => {
    if (typeof item !== "object" || item === null) return false
    const record = item as Record<string, unknown>
    const args = record.args as Record<string, unknown> | undefined
    return (
      typeof record.key === "string" &&
      record.key.toLowerCase().replaceAll(" ", "") === "shift+enter" &&
      record.command === KEYBINDING.command &&
      args?.text === KEYBINDING.args.text
    )
  })
}

export const CTRL_J = "Ctrl+J inserts a newline in every terminal, with no setup."

const TMUX = [
  `In tmux, add these lines to ~/.tmux.conf so Shift+Enter reaches ${product}, then run \`tmux source-file ~/.tmux.conf\`:`,
  "    set -s extended-keys on",
  "    set -as terminal-features 'xterm*:extkeys'",
]

/** What to tell the person, line by line. `applicable`: the CLI can make the change itself. */
export function guidance(terminal: Terminal, env: Environment): { readonly lines: string[]; readonly applicable: boolean } {
  const lines: string[] = []
  let applicable = false
  switch (terminal.kind) {
    case "native":
      lines.push(`${terminal.name} reports Shift+Enter to ${product}, so it already inserts a newline. Nothing to set up.`)
      break
    case "editor": {
      const name = terminal.editor ? EDITORS[terminal.editor].name : "This editor"
      lines.push(
        `${name}'s terminal sends a plain Enter for Shift+Enter. One keybinding fixes it: Shift+Enter then sends Alt+Enter, which ${product} reads as a newline.`,
      )
      if (terminal.editor) {
        lines.push(`Run \`${cli} terminal-setup\` to add it to ${name}'s keybindings.json (it asks first and keeps a backup).`)
        applicable = true
      } else lines.push(`Run \`${cli} terminal-setup --editor <code|insiders|cursor|windsurf|vscodium>\` to add it.`)
      lines.push(`Or add it yourself (Preferences: Open Keyboard Shortcuts (JSON)):`, `    ${JSON.stringify(KEYBINDING)}`)
      break
    }
    case "iterm":
      lines.push(
        "iTerm2: Settings → Profiles → Keys → General, turn on \"Report keys using CSI u\" (iTerm2 3.5 or later). Shift+Enter then inserts a newline.",
        `Or in Settings → Profiles → Keys → Key Mappings, add Shift+Return with the action "Send Hex Code" and the value \`0x1b 0x0d\` (Esc, Return); ${product} reads it as Alt+Enter, a newline.`,
      )
      break
    case "apple":
      lines.push(
        "Apple Terminal can't report Shift+Enter. Use Option+Enter instead: Settings → Profiles → Keyboard, turn on \"Use Option as Meta key\".",
      )
      break
    case "windows-terminal":
      lines.push(
        `Windows Terminal: Settings → Open JSON file, and add this to "actions" (Shift+Enter then sends Alt+Enter, which ${product} reads as a newline):`,
        `    { "command": { "action": "sendInput", "input": "\\u001b\\r" }, "keys": "shift+enter" }`,
      )
      break
    case "unknown":
      lines.push(
        `${terminal.name ? `${product} doesn't know ${terminal.name}` : `${product} couldn't tell which terminal this is`}. If Shift+Enter sends the message instead of a newline, use Alt+Enter, or turn on the kitty keyboard protocol or "CSI u" reporting in the terminal's settings if it has one.`,
      )
      break
  }
  if (multiplexer(env) === "tmux") lines.push(...TMUX)
  if (multiplexer(env) === "screen") lines.push("GNU screen doesn't pass Shift+Enter on; use Ctrl+J or Alt+Enter.")
  lines.push(CTRL_J)
  return { lines, applicable }
}
