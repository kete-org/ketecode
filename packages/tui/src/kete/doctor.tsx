// `/doctor` (and "Check setup" in the command palette): the same checks as `kete doctor`
// (@opencode/util/kete/doctor) in a dialog: config files, folder trust, models, MCP servers, the OS
// sandbox and the terminal, with r Run again, c Copy and esc Close. Read-only: it asks the runtime and
// reads whether an account is signed in (./feedback-deps.ts), and changes nothing.

import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { KeteDoctorRpc } from "@opencode/schema/kete/doctor"
import { KeteBugReport } from "@opencode/util/kete/bug-report"
import { KeteDoctor } from "@opencode/util/kete/doctor"
import { KeteOffline } from "@opencode/util/kete/offline"
import { Schema } from "effect"
import { createResource, createSignal, For, Show } from "solid-js"
import { useClient } from "../context/client"
import { useClipboard } from "../context/clipboard"
import { Keymap } from "../context/keymap"
import { useLocation } from "../context/location"
import { useTuiApp, useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import * as FeedbackDeps from "./feedback-deps"
import { fetchSandboxStatus } from "./sandbox-status"

export const COMMAND = "kete.doctor"
export const SLASH = "doctor"
export const TITLE = "Check setup"
const TIMEOUT = 10_000
const decodeReport = Schema.decodeUnknownPromise(KeteDoctorRpc.Report)

/** The facts `/doctor` can find out; the TUI is a terminal UI, so `interactive` is left out. */
export async function collect(input: {
  readonly api: Pick<OpenCodeClient, "provider" | "model" | "mcp" | "rpc">
  readonly location: LocationRef | undefined
  readonly version: string
  readonly channel: string
  readonly home: string
  readonly signedIn: () => Promise<boolean>
}): Promise<KeteDoctor.Facts> {
  const { api, location } = input
  const signal = () => AbortSignal.timeout(TIMEOUT)
  const [signedIn, providers, defaultModel, mcp, sandbox, report] = await Promise.all([
    input.signedIn().then(
      (value) => (value ? ("yes" as const) : ("no" as const)),
      () => "unknown" as const,
    ),
    api.provider
      .list({ location }, { signal: signal() })
      .then((response) => KeteBugReport.providerIds(response.data))
      .catch(() => undefined),
    api.model
      .default({ location }, { signal: signal() })
      .then((response) => (response.data ? { provider: response.data.providerID, model: response.data.modelID } : null))
      .catch(() => undefined),
    api.mcp
      .list({ location }, { signal: signal() })
      .then((response) => KeteBugReport.mcpStates(response.data))
      .catch(() => undefined),
    fetchSandboxStatus(api, location).catch(() => undefined),
    api.rpc
      .call({ rpcID: KeteDoctorRpc.ID, method: "check", input: {}, location }, { signal: signal() })
      .then((response) => decodeReport(response.output))
      .catch(() => undefined),
  ])
  const answers = [providers, defaultModel, mcp, sandbox, report]
  return {
    version: input.version,
    channel: input.channel,
    platform: process.platform,
    env: process.env,
    offline: KeteOffline.enabled(),
    signedIn,
    runtime: answers.some((value) => value !== undefined),
    providers,
    defaultModel,
    mcp,
    sandbox,
    report,
    home: input.home,
  }
}

function DialogDoctor(props: { run: () => Promise<KeteDoctor.Check[]> }) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const [round, setRound] = createSignal(0)
  const [checks] = createResource(round, () => props.run())
  const [status, setStatus] = createSignal<string>()
  let scroll: ScrollBoxRenderable | undefined
  const height = () => Math.max(3, Math.floor((dimensions().height * 3) / 4) - 10)

  const colour = (value: KeteDoctor.Status) =>
    value === "ok"
      ? theme.text.feedback.success.base
      : value === "warn"
        ? theme.text.feedback.warning.base
        : value === "fail"
          ? theme.text.feedback.error.base
          : theme.text.muted

  const again = () => {
    setStatus(undefined)
    setRound((value) => value + 1)
  }
  const copy = () => {
    const current = checks()
    if (!current) return
    void clipboard
      .write(KeteDoctor.render(current))
      .then(() => setStatus("Copied to the clipboard."))
      .catch((error: unknown) => setStatus(`Couldn't copy: ${error instanceof Error ? error.message : String(error)}`))
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "r", title: "Run again", group: "Dialog", run: again },
      { bind: "c", title: "Copy", group: "Dialog", run: copy },
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
      <Show when={!checks.loading && checks()} fallback={<text fg={theme.text.muted}>{checks.error ? "Couldn't run the checks." : "Checking…"}</text>}>
        {(current) => (
          <box gap={1}>
            <scrollbox maxHeight={height()} scrollbarOptions={{ visible: false }} ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}>
              <For each={KeteDoctor.GROUPS.filter((group) => current().some((check) => check.group === group))}>
                {(group) => (
                  <box paddingBottom={1}>
                    <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                      {group}
                    </text>
                    <For each={current().filter((check) => check.group === group)}>
                      {(check) => (
                        <box>
                          <text fg={theme.text.base}>
                            <span style={{ fg: colour(check.status) }}>{KeteDoctor.SYMBOL[check.status]} </span>
                            {check.title}
                          </text>
                          <For each={check.details ?? []}>{(detail) => <text fg={theme.text.muted}>{`    ${detail}`}</text>}</For>
                          <Show when={check.fix}>{(fix) => <text fg={theme.text.muted}>{`    → ${fix()}`}</text>}</Show>
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </scrollbox>
            <text fg={theme.text.base}>{KeteDoctor.summary(current())}</text>
          </box>
        )}
      </Show>
      <box flexDirection="row" gap={3} flexWrap="wrap">
        {action("r", "Run again", again)}
        {action("c", "Copy", copy)}
        {action("esc", "Close", () => dialog.clear())}
      </box>
      <Show when={status()}>{(text) => <text fg={theme.text.base}>{text()}</text>}</Show>
      <box paddingBottom={1} />
    </box>
  )
}

function Doctor(props: { context: Plugin.Context }) {
  const app = useTuiApp()
  const paths = useTuiPaths()
  const client = useClient()
  const location = useLocation()
  const dialog = useDialog()

  const run = async () =>
    KeteDoctor.checks(
      await collect({
        api: client.api,
        location: location.ref,
        version: app.version,
        channel: app.channel,
        home: paths.home,
        signedIn: FeedbackDeps.signedIn,
      }),
    )

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        title: TITLE,
        group: "System",
        slash: { name: SLASH },
        palette: true,
        run: () => dialog.replace(() => <DialogDoctor run={run} />),
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "kete.doctor",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Doctor context={context} /> })
  },
})
