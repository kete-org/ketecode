// `/share` and `/unshare` (docs/sharing.md): ask the runtime's `kete.share` RPC what a share would send
// (nothing is uploaded), show it in a dialog, and upload only when the person presses Enter. Then the
// link is shown in a toast and copied to the clipboard. `/unshare` asks first, then deletes. A refusal
// (job mode, offline, signed out, policy) comes back from the runtime with its reason, shown as a toast.
// Text from the platform is shown without control characters; `share` gets the preview's digest, so a
// session that changed after the preview is refused instead of uploaded unseen.

import { TextAttributes } from "@opentui/core"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { KeteShareRpc } from "@opencode/schema/kete/share"
import { KeteShareClient } from "@opencode/util/kete/share"
import { Schema } from "effect"
import { createSignal, For, Show } from "solid-js"
import type { ClipboardService } from "../context/clipboard"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import type { useToast } from "../ui/toast"

// The runtime builds the snapshot and uploads it (15 s): allow a little more.
const TIMEOUT = 30_000

const decodePreview = Schema.decodeUnknownPromise(KeteShareRpc.PreviewOutput)
const decodeShare = Schema.decodeUnknownPromise(KeteShareRpc.ShareOutput)
const decodeUnshare = Schema.decodeUnknownPromise(KeteShareRpc.UnshareOutput)

export type Deps = {
  readonly dialog: ReturnType<typeof useDialog>
  readonly api: Pick<OpenCodeClient, "rpc">
  readonly location: LocationRef | undefined
  readonly toast: ReturnType<typeof useToast>
  readonly clipboard: Pick<ClipboardService, "write">
  readonly sessionID: string
}

const call = (deps: Deps, method: "preview" | "share" | "unshare", input: Record<string, string>) =>
  deps.api.rpc
    .call({ rpcID: KeteShareRpc.ID, method, input, location: deps.location }, { signal: AbortSignal.timeout(TIMEOUT) })
    .then((response) => response.output)

const clean = KeteShareClient.printable

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/** What the dialog says; separate from the dialog so it can be tested without a terminal. */
export function previewLines(preview: KeteShareRpc.PreviewOutput, visibility: KeteShareRpc.Visibility): string[] {
  const { counts } = preview
  return [
    visibility === "link" ? "Anyone with the link can read this session." : "Members of your organization can read this session.",
    `${counts.messages} messages, ${counts.tools} tool calls, ${counts.diffs} changed files (${size(preview.bytes)})`,
    `Secrets removed: ${preview.redactions}`,
    ...(preview.truncated ? ["Large parts were left out to fit the size limit."] : []),
    "Not sent: reasoning, system prompts, attached file contents, skills, memory.",
    `The share expires in ${preview.maxDays} days.`,
    ...(preview.existing ? ["This session is already shared: Enter updates the same share (link and expiry stay)."] : []),
  ]
}

/** Opens the preview dialog for the session, or shows why it can't be shared. */
export async function share(deps: Deps) {
  try {
    const preview = await decodePreview(await call(deps, "preview", { sessionID: deps.sessionID }))
    if (preview.refusal) {
      deps.toast.show({ title: "Can't share", message: clean(preview.refusal.message), variant: "error", duration: 8000 })
      deps.dialog.clear()
      return
    }
    deps.dialog.replace(() => <DialogShare deps={deps} preview={preview} />)
  } catch (error) {
    deps.toast.error(error)
    deps.dialog.clear()
  }
}

/** Asks first, then deletes the session's share. */
export function unshare(deps: Deps) {
  deps.dialog.replace(() => (
    <DialogConfirm
      title="Unshare session"
      message="Delete this session's shared copy from the Kete portal? The link stops working."
      label={{ confirm: "Unshare" }}
      onConfirm={() => {
        void call(deps, "unshare", { sessionID: deps.sessionID })
          .then((output) => decodeUnshare(output))
          .then((result) => {
            if (result.refusal)
              return deps.toast.show({ title: "Can't unshare", message: clean(result.refusal.message), variant: "error", duration: 8000 })
            deps.toast.show({
              message: result.removed ? "Share deleted." : "This session isn't shared.",
              variant: result.removed ? "success" : "info",
            })
          })
          .catch((error) => deps.toast.error(error))
      }}
    />
  ))
}

function DialogShare(props: { deps: Deps; preview: KeteShareRpc.PreviewOutput }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const [visibility, setVisibility] = createSignal<KeteShareRpc.Visibility>(props.preview.visibility)
  let busy = false
  // An existing share keeps its visibility; link is offered only when the organization allows it.
  const canChoose = !props.preview.existing && props.preview.linkAllowed

  const toggle = () => {
    if (canChoose && !busy) setVisibility((value) => (value === "org" ? "link" : "org"))
  }
  const submit = () => {
    if (busy) return
    busy = true
    void call(props.deps, "share", {
      sessionID: props.deps.sessionID,
      visibility: visibility(),
      ...(props.preview.digest ? { digest: props.preview.digest } : {}),
    })
      .then((output) => decodeShare(output))
      .then(async (result) => {
        if (result.refusal || !result.record) {
          props.deps.toast.show({
            title: "Not shared",
            message: clean(result.refusal?.message ?? "The runtime shared nothing."),
            variant: "error",
            duration: 8000,
          })
          return
        }
        const url = clean(result.record.url)
        const copied = await props.deps.clipboard.write(url).then(
          () => true,
          () => false,
        )
        props.deps.toast.show({
          title: "Session shared",
          message: `${url}${copied ? "\n(copied to the clipboard)" : ""}`,
          variant: "success",
          duration: 15000,
        })
      })
      .catch((error) => props.deps.toast.error(error))
      .finally(() => dialog.clear())
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Share", group: "Dialog", run: submit },
      ...(canChoose ? [{ bind: "v", title: "Change who can read it", group: "Dialog", run: toggle }] : []),
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          Share session
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box>
        <For each={previewLines(props.preview, visibility())}>{(line) => <text fg={theme.text.base}>{line}</text>}</For>
      </box>
      <box flexDirection="row" gap={3} flexWrap="wrap" paddingBottom={1}>
        <text fg={theme.text.base} onMouseUp={submit}>
          <span style={{ fg: theme.text.muted }}>enter </span>
          {props.preview.existing ? "Update" : "Share"}
        </text>
        <Show when={canChoose}>
          <text fg={theme.text.base} onMouseUp={toggle}>
            <span style={{ fg: theme.text.muted }}>v </span>
            {visibility() === "org" ? "Anyone with the link instead" : "Organization only instead"}
          </text>
        </Show>
        <text fg={theme.text.base} onMouseUp={() => dialog.clear()}>
          <span style={{ fg: theme.text.muted }}>esc </span>
          Cancel
        </text>
      </box>
    </box>
  )
}
