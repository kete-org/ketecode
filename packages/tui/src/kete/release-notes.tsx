// What's new after an update (docs/release.md, root CHANGELOG.md). The build embeds the running
// version's CHANGELOG section as `KETE_RELEASE_NOTES` (packages/cli/script/build.ts), so showing it
// needs no network or file.
//
// - `/release-notes` (and "Release notes" in the command palette) shows the notes any time, or
//   "No release notes for this version".
// - After an upgrade the notes show once: TUI storage `kete-release-notes` keeps the last version
//   whose notes were shown. Only release builds (channel `latest`) do this; the first run ever only
//   records the version (nothing was upgraded), and preview, dev and source builds never auto-show.

import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { KeteChangelog } from "@opencode/util/kete/changelog"
import { Plugin } from "@opencode/plugin/tui"
import { For, onMount } from "solid-js"
import { Keymap } from "../context/keymap"
import { useLog } from "../context/log"
import { useTuiApp } from "../context/runtime"
import { useStorage } from "../context/storage"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

declare const KETE_RELEASE_NOTES: string | undefined

export const STORAGE_KEY = "kete-release-notes"
export const COMMAND = "kete.release-notes"
export const SLASH = "release-notes"
export const EMPTY = "No release notes for this version."
/** The channel of release builds (`kete-v*` tags); every other build is a preview. */
export const RELEASE_CHANNEL = "latest"

/** The notes embedded at build time; empty in a source run or a build without a CHANGELOG section. */
export function embeddedNotes(): string {
  return typeof KETE_RELEASE_NOTES === "string" ? KETE_RELEASE_NOTES.trim() : ""
}

/**
 * Whether to show the notes on startup, and whether to record the running version as seen.
 * `lastSeen` is undefined on the first run ever.
 */
export function autoShow(input: {
  readonly notes: string
  readonly version: string
  readonly channel: string
  readonly lastSeen: string | undefined
}): { show: boolean; record: boolean } {
  if (input.channel !== RELEASE_CHANNEL) return { show: false, record: false }
  if (KeteChangelog.compareVersions(input.version, input.version) === undefined) return { show: false, record: false }
  if (input.lastSeen === undefined) return { show: false, record: true }
  const order = KeteChangelog.compareVersions(input.version, input.lastSeen)
  // A downgrade, the same version or an unreadable stored value: leave it as it is.
  if (order === undefined || order <= 0) return { show: false, record: order === undefined }
  return { show: input.notes !== "", record: true }
}

const BULLET = /^(\s*)[-*] /

/**
 * CHANGELOG markdown as terminal paragraphs: a bullet's hard-wrapped continuation lines are joined
 * (the dialog wraps to its own width), bullets become "•", bold and code markers are dropped.
 */
export function plainLines(notes: string): string[] {
  const lines: string[] = []
  for (const raw of notes.split("\n")) {
    const line = raw.trimEnd()
    const previous = lines.at(-1)
    if (line !== "" && !BULLET.test(line) && previous) lines[lines.length - 1] = `${previous} ${line.trim()}`
    else lines.push(line)
  }
  return lines.map((line) =>
    line
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(BULLET, "$1• "),
  )
}

export function title(version: string) {
  return KeteChangelog.compareVersions(version, version) === undefined ? "What's new" : `What's new in ${version}`
}

function DialogReleaseNotes(props: { version: string; notes: string }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  const height = () => Math.max(3, Math.floor((dimensions().height * 3) / 4) - 9)
  const by = (lines: number) => () => scroll?.scrollBy(lines)

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Close release notes", group: "Dialog", run: () => dialog.clear() },
      { bind: "up", title: "Scroll up", group: "Dialog", run: by(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: by(1) },
      { bind: "pageup", title: "Page up", group: "Dialog", run: () => scroll?.scrollBy(-height()) },
      { bind: "pagedown", title: "Page down", group: "Dialog", run: () => scroll?.scrollBy(height()) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          {title(props.version)}
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <scrollbox
        maxHeight={height()}
        scrollbarOptions={{ visible: false }}
        ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}
      >
        <For each={props.notes ? plainLines(props.notes) : [EMPTY]}>
          {(line) => <text fg={props.notes ? theme.text.base : theme.text.muted}>{line || " "}</text>}
        </For>
      </scrollbox>
      <box paddingBottom={1} />
    </box>
  )
}

function ReleaseNotes(props: { context: Plugin.Context }) {
  const app = useTuiApp()
  const dialog = useDialog()
  const storage = useStorage()
  const log = useLog({ component: "kete.release-notes" })
  const [seen, record] = storage.store<{ version?: unknown }>(STORAGE_KEY, { initial: {} })
  const notes = embeddedNotes()
  const show = () => dialog.replace(() => <DialogReleaseNotes version={app.version} notes={notes} />)

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        title: "Release notes",
        group: "System",
        slash: { name: SLASH },
        palette: true,
        run: show,
      },
    ],
  }))

  onMount(() => {
    const decision = autoShow({
      notes,
      version: app.version,
      channel: app.channel,
      lastSeen: typeof seen.version === "string" ? seen.version : undefined,
    })
    // Another dialog is already open: leave the version unrecorded so the notes show next time.
    const busy = decision.show && dialog.stack.length > 0
    if (decision.record && !busy)
      record((draft) => {
        draft.version = app.version
      }).catch((error) =>
        log.warn("could not record the release notes as seen", {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    if (decision.show && !busy) show()
  })
  return null
}

export default Plugin.define({
  id: "kete.release-notes",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <ReleaseNotes context={context} /> })
  },
})
