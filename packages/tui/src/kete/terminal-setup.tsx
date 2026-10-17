// `/terminal-setup` (and "Set up Shift+Enter" in the command palette): whether Shift+Enter already
// inserts a newline in this terminal, and what to change if not (@opencode/util/kete/terminal-setup).
// It changes nothing: the one automatic change, a VS Code family keybinding, is `kete terminal-setup`,
// which asks first.

import { TextAttributes } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { KeteTerminalSetup } from "@opencode/util/kete/terminal-setup"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

export const COMMAND = "kete.terminal-setup"
export const SLASH = "terminal-setup"
export const TITLE = "Set up Shift+Enter"

function DialogTerminalSetup(props: { lines: readonly string[] }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          {TITLE}
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <For each={props.lines}>{(line) => <text fg={theme.text.base}>{line}</text>}</For>
      <box paddingBottom={1} />
    </box>
  )
}

function TerminalSetup(props: { context: Plugin.Context }) {
  const dialog = useDialog()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        title: TITLE,
        group: "System",
        slash: { name: SLASH },
        palette: true,
        run: () => {
          const guide = KeteTerminalSetup.guidance(KeteTerminalSetup.detect(process.env, process.platform), process.env)
          dialog.replace(() => <DialogTerminalSetup lines={guide.lines} />)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "kete.terminal-setup",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <TerminalSetup context={context} /> })
  },
})
