// `/context` (and "Show context usage" in the command palette): how much of the session's context window
// each part takes, from the `kete.context` RPC (core/src/kete/context-breakdown.ts). Read-only. Sizes are
// estimates (about 4 characters per token) except the provider's own count for the last step, which is
// shown on its own line. The answer is decoded against the shared schema; one that doesn't match is an
// error row, not trusted.

import { TextAttributes } from "@opentui/core"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { KeteContextRpc } from "@opencode/schema/kete/context"
import { Schema } from "effect"
import { createResource, createSignal, For, Show } from "solid-js"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"
import { useDialog } from "../ui/dialog"

export const COMMAND = "kete.context"
export const SLASH = "context"
export const TITLE = "Context usage"
const TIMEOUT = 15_000
const BAR = 30
/** The rows that show their items when expanded. */
const EXPANDABLE: ReadonlyArray<KeteContextRpc.CategoryID> = ["tools", "codemode", "mcp", "memory"]
const decodeOutput = Schema.decodeUnknownPromise(KeteContextRpc.Output)

export async function fetchContext(
  client: Pick<OpenCodeClient, "rpc">,
  sessionID: string,
  location: LocationRef | undefined,
): Promise<KeteContextRpc.Output> {
  const response = await client.rpc.call(
    { rpcID: KeteContextRpc.ID, method: "get", input: { sessionID }, location },
    { signal: AbortSignal.timeout(TIMEOUT) },
  )
  return decodeOutput(response.output)
}

/** A bar of `width` cells, filled by `part / whole`. At least one cell for a non-empty part. */
export function bar(part: number, whole: number, width = BAR) {
  const filled = whole <= 0 || part <= 0 ? 0 : Math.min(width, Math.max(1, Math.round((part / whole) * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

const number = (value: number) => value.toLocaleString("en-US")

function DialogContext(props: { load: () => Promise<KeteContextRpc.Output> }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const [result] = createResource(() => props.load())
  const [open, setOpen] = createSignal(false)

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "e",
        title: "Expand or collapse",
        group: "Dialog",
        run: () => {
          setOpen((value) => !value)
        },
      },
    ],
  }))

  const body = (output: KeteContextRpc.Output) => {
    if (output.type === "refused") return <text fg={theme.text.muted}>{output.reason}</text>
    const total = output.categories.reduce((sum, category) => sum + category.tokens, 0)
    const rows = output.categories.toSorted((left, right) => right.tokens - left.tokens)
    return (
      <box gap={1}>
        <box>
          <Show when={output.provider}>
            {(provider) => (
              <text fg={theme.text.base}>
                {`Provider count: ${number(provider().tokens)} tokens`}
                {provider().contextLimit !== undefined ? ` of ${number(provider().contextLimit ?? 0)}` : ""}
                {provider().free !== undefined ? `, ${number(provider().free ?? 0)} free` : ""}
              </text>
            )}
          </Show>
          <text fg={theme.text.muted}>{`Estimates (about 4 characters per token): ${number(total)} tokens in all`}</text>
        </box>
        <box>
          <For each={rows}>
            {(category) => (
              <box>
                <text fg={theme.text.base}>
                  <span style={{ fg: theme.text.muted }}>{bar(category.tokens, total)} </span>
                  {`${category.label}  ${number(category.tokens)}`}
                </text>
                <Show when={open() && EXPANDABLE.includes(category.id)}>
                  <For each={category.items.slice(0, 8)}>
                    {(entry) => <text fg={theme.text.muted}>{`    ${entry.name}  ${number(entry.tokens)}`}</text>}
                  </For>
                </Show>
              </box>
            )}
          </For>
        </box>
        <Show when={output.hiddenMcp}>
          {(hidden) => (
            <text fg={theme.text.feedback.warning.base}>
              {`${hidden().count} MCP tools are not sent: ${hidden().reason}`}
            </text>
          )}
        </Show>
      </box>
    )
  }

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
      <Show
        when={!result.loading && result()}
        fallback={<text fg={theme.text.muted}>{result.error ? "Couldn't read the context breakdown." : "Measuring…"}</text>}
      >
        {(output) => body(output())}
      </Show>
      <text fg={theme.text.muted} onMouseUp={() => setOpen((value) => !value)}>
        e Expand or collapse   esc Close
      </text>
      <box paddingBottom={1} />
    </box>
  )
}

function Context(props: { context: Plugin.Context }) {
  const client = useClient()
  const location = useLocation()
  const route = useRoute()
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
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          dialog.replace(() => (
            <DialogContext
              load={async () =>
                sessionID
                  ? fetchContext(client.api, sessionID, props.context.data.session.get(sessionID)?.location ?? location.ref)
                  : { type: "refused" as const, reason: "Open a session to see its context." }
              }
            />
          ))
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "kete.context",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Context context={context} /> })
  },
})
