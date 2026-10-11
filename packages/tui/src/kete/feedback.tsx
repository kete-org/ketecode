// `/feedback` (also `/bug`, and "Report a problem" in the command palette): the same privacy-safe
// problem report as `kete bug` (@opencode/util/kete/bug-report), shown in a dialog to review, with
// o Open issue (the issue tracker's bug-report form, pre-filled, in the browser), c Copy, s Save
// (a file only its owner can read) and esc Cancel. Opening the form sends the report to GitHub in the
// link; it becomes public only when the person submits the issue (KeteBugReport.LINK_NOTICE). Side effects live in ./feedback-deps.ts.

import os from "node:os"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Plugin } from "@opencode/plugin/tui"
import { KeteBugReport } from "@opencode/util/kete/bug-report"
import { KeteBugReportFile } from "@opencode/util/kete/bug-report-file"
import { KeteOffline } from "@opencode/util/kete/offline"
import { createResource, createSignal, For, Show } from "solid-js"
import { useClient } from "../context/client"
import { useClipboard } from "../context/clipboard"
import { Keymap } from "../context/keymap"
import { useLocation } from "../context/location"
import { useTuiApp, useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import * as FeedbackDeps from "./feedback-deps"
import { useKetePermissionMode } from "./permission-mode"
import { fetchSandboxStatus } from "./sandbox-status"

export const COMMAND = "kete.feedback"
export const SLASH = "feedback"
export const TITLE = "Report a problem"
const TIMEOUT = 10_000

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function DialogFeedback(props: { report: Promise<KeteBugReport.Report>; home: KeteBugReport.Home }) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const [report] = createResource(() => props.report)
  const [status, setStatus] = createSignal<string>()
  const [saved, setSaved] = createSignal<string>()
  let scroll: ScrollBoxRenderable | undefined
  const height = () => Math.max(3, Math.floor((dimensions().height * 3) / 4) - 13)
  const scrub = (text: string) => KeteBugReport.scrub(text, props.home)

  const save = async (current: KeteBugReport.Report) => {
    const existing = saved()
    if (existing) return existing
    const file = await FeedbackDeps.save(current.text)
    setSaved(file)
    return file
  }
  const withReport = (run: (current: KeteBugReport.Report) => Promise<void>) => () => {
    const current = report()
    if (!current) return
    void run(current).catch((error) => setStatus(`Failed: ${scrub(message(error))}`))
  }
  const openIssue = withReport(async (current) => {
    // A report too long for the link is saved first, so the link can point at the file.
    const first = KeteBugReport.issueURL(current, saved())
    const issue = first.complete ? first : KeteBugReport.issueURL(current, await save(current))
    await FeedbackDeps.openURL(issue.url)
    setStatus(
      issue.complete
        ? `Opened the issue form in your browser. ${KeteBugReport.LINK_NOTICE}`
        : `Opened the issue form; the link left out the oldest log lines. Attach ${saved()} to the issue. ${KeteBugReport.LINK_NOTICE}`,
    )
  })
  const copy = withReport(async (current) => {
    await clipboard.write(current.text)
    setStatus("Report copied to the clipboard.")
  })
  const saveReport = withReport(async (current) => {
    setStatus(`Saved to ${await save(current)} (only you can read it).`)
  })

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "o", title: "Open issue", group: "Dialog", run: openIssue },
      { bind: "c", title: "Copy report", group: "Dialog", run: copy },
      { bind: "s", title: "Save report", group: "Dialog", run: saveReport },
      { bind: "up", title: "Scroll up", group: "Dialog", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: "Page up", group: "Dialog", run: () => scroll?.scrollBy(-height()) },
      { bind: "pagedown", title: "Page down", group: "Dialog", run: () => scroll?.scrollBy(height()) },
    ],
  }))

  const action = (key: string, label: string, run: () => void) => (
    <text fg={theme.text.base} onMouseUp={run}>
      <span style={{ fg: theme.text.muted }}>{key} </span>
      {label}
    </text>
  )

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
      <text fg={theme.text.muted}>Review the report. {KeteBugReport.LINK_NOTICE}</text>
      <Show
        when={report()}
        fallback={<text fg={theme.text.muted}>{report.error ? `Couldn't build the report: ${scrub(message(report.error))}` : "Collecting…"}</text>}
      >
        {(current) => (
          <scrollbox
            maxHeight={height()}
            scrollbarOptions={{ visible: false }}
            ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}
          >
            <For each={current().text.split("\n")}>{(line) => <text fg={theme.text.base}>{line || " "}</text>}</For>
          </scrollbox>
        )}
      </Show>
      <box flexDirection="row" gap={3} flexWrap="wrap">
        {action("o", "Open issue", openIssue)}
        {action("c", "Copy", copy)}
        {action("s", "Save", saveReport)}
        {action("esc", "Cancel", () => dialog.clear())}
      </box>
      <Show when={status()}>{(text) => <text fg={theme.text.base}>{text()}</text>}</Show>
      <text fg={theme.text.muted}>{KeteBugReport.SECURITY_NOTICE}</text>
      <box paddingBottom={1} />
    </box>
  )
}

function Feedback(props: { context: Plugin.Context }) {
  const app = useTuiApp()
  const paths = useTuiPaths()
  const client = useClient()
  const location = useLocation()
  const dialog = useDialog()
  const mode = useKetePermissionMode()

  const collect = async (home: KeteBugReport.Home): Promise<KeteBugReport.Report> => {
    const ref = location.ref
    const signal = () => AbortSignal.timeout(TIMEOUT)
    const [signedIn, providers, mcp, sandbox, log] = await Promise.all([
      FeedbackDeps.signedIn().then(
        (value) => (value ? ("yes" as const) : ("no" as const)),
        () => "unknown" as const,
      ),
      client.api.provider
        .list({ location: ref }, { signal: signal() })
        .then((response) => KeteBugReport.providerIds(response.data))
        .catch(() => undefined),
      client.api.mcp
        .list({ location: ref }, { signal: signal() })
        .then((response) => KeteBugReport.mcpStates(response.data))
        .catch(() => undefined),
      fetchSandboxStatus(client.api, ref)
        .then((status) => ({ state: status.state, mechanism: status.mechanism, mode: status.mode, network: status.network }))
        .catch(() => undefined),
      FeedbackDeps.logTail(app.channel).catch(() => undefined),
    ])
    return KeteBugReport.build(
      {
        source: "tui",
        version: app.version,
        channel: app.channel,
        os: { platform: process.platform, release: os.release(), arch: process.arch },
        env: process.env,
        signedIn,
        providers,
        permissionMode: mode.current() ?? "default",
        sandbox,
        offline: KeteOffline.enabled(),
        mcp,
        log,
      },
      home,
    )
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        title: TITLE,
        group: "System",
        slash: { name: SLASH, aliases: ["bug"] },
        palette: true,
        run: () => {
          const home = KeteBugReportFile.homes(paths.home)
          const report = collect(home)
          dialog.replace(() => <DialogFeedback report={report} home={home} />)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "kete.feedback",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Feedback context={context} /> })
  },
})
