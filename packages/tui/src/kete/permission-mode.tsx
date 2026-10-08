// Kete Code permission modes in the TUI (core/src/kete/permission-mode.ts enforces them):
// - `useKetePermissionMode()`: the current session's mode, for the prompt's status row, and the
//   metadata a new session is created with (`kete --permission-mode <mode>` or `--auto`).
// - `useKetePermissionModeCommands()` (called once from app.tsx): the "Cycle permission mode" command
//   (`<leader>p`, `/mode`), and applying `--permission-mode` to the session `--continue`/`--session`
//   resumes. Both change the session's `kete.permissionMode` metadata with a GET-merge-PATCH, as the
//   editor clients do, so every client shows the same mode.

import type { OpenCodeClient } from "@opencode/client/promise"
import { createEffect, createMemo } from "solid-js"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"
import { useArgs } from "../context/args"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"

export type Mode = KetePermissionModes.Mode

export const COMMAND = "permission.mode.cycle"

/** The mode stored in a session's metadata, if any. */
export function modeOf(metadata: Record<string, unknown> | undefined): Mode | undefined {
  return KetePermissionModes.parse(metadata?.[KetePermissionModes.metadataKey])
}

/** The text the prompt's status row shows: nothing for Default (or no mode), otherwise the mode's label. */
export function statusText(mode: Mode | undefined): string | undefined {
  if (mode === undefined || mode === "default") return undefined
  return KetePermissionModes.label[mode].toLowerCase()
}

type SessionAPI = Pick<OpenCodeClient["session"], "get" | "update">

/** Sets `mode` on a session, keeping its other metadata (the server replaces metadata whole). */
export async function applyMode(api: SessionAPI, sessionID: string, mode: Mode) {
  const session = await api.get({ sessionID })
  if (modeOf(session.metadata) === mode) return
  await api.update({ sessionID, metadata: { ...session.metadata, [KetePermissionModes.metadataKey]: mode } })
}

export function useKetePermissionMode() {
  const args = useArgs()
  const data = useData()
  const route = useRoute()
  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const current = createMemo<Mode | undefined>(() => {
    const id = sessionID()
    const stored = id ? modeOf(data.session.get(id)?.metadata) : undefined
    return stored ?? args.permissionMode
  })
  return {
    sessionID,
    current,
    /** `session.create`'s metadata: the mode from `--permission-mode`/`--auto`, so it's in force before the first tool call. */
    createMetadata: () =>
      args.permissionMode === undefined ? undefined : { [KetePermissionModes.metadataKey]: args.permissionMode },
  }
}

export function useKetePermissionModeCommands() {
  const args = useArgs()
  const client = useClient()
  const toast = useToast()
  const mode = useKetePermissionMode()
  // Read on each use: the client's API object is replaced when it reconnects.
  const api = (): SessionAPI => client.api.session

  const cycle = () => {
    const id = mode.sessionID()
    if (!id) {
      toast.show({
        title: "Permission mode",
        message: `Start a session first. New sessions use ${KetePermissionModes.label[args.permissionMode ?? "default"]} (set with --permission-mode).`,
        variant: "info",
      })
      return
    }
    const target = KetePermissionModes.next(mode.current() ?? "default")
    applyMode(api(), id, target).then(
      () =>
        toast.show({
          title: `Permission mode: ${KetePermissionModes.label[target]}`,
          message: KetePermissionModes.description[target],
          variant: "info",
        }),
      (error) => toast.error(error),
    )
  }

  // `kete --continue --permission-mode plan`: the resumed session gets the mode once, at startup.
  let resumed = !(args.continue || args.sessionID) || args.permissionMode === undefined
  createEffect(() => {
    const id = mode.sessionID()
    const wanted = args.permissionMode
    if (resumed || !id || wanted === undefined) return
    resumed = true
    applyMode(api(), id, wanted).catch((error) => toast.error(error))
  })

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        group: "Agent",
        title: "Cycle permission mode",
        bind: false,
        palette: true as const,
        slash: { name: "mode" },
        run: cycle,
      },
    ],
  }))
  Keymap.createLayer(() => ({ bindings: [COMMAND] }))
}
