// `--permission-mode <mode>` and `--auto` for `kete` and `kete run`. The mode is a session's
// `kete.permissionMode` metadata, enforced by the runtime (core/src/kete/permission-mode.ts).
// `--auto` is the `auto` mode — edits and commands run without asking, high-risk commands still ask.
// `--dangerously-skip-permissions` (and its hidden alias `--yolo`) is the separate, explicit
// bypass: the client approves every request that isn't denied, including high-risk ones.

import type { OpenCodeClient } from "@opencode/client/promise"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"
import { Option } from "effect"

export type Mode = KetePermissionModes.Mode
export const modes = KetePermissionModes.modes

export class ConflictError extends Error {}

/** The mode the flags ask for, or undefined to keep the session's (or the runtime's) own. */
export function fromFlags(input: { readonly auto: boolean; readonly permissionMode: Option.Option<Mode> }): Mode | undefined {
  const explicit = Option.getOrUndefined(input.permissionMode)
  if (input.auto && explicit !== undefined && explicit !== "auto")
    throw new ConflictError(`--auto selects the "auto" permission mode; it can't be combined with --permission-mode ${explicit}`)
  return input.auto ? "auto" : explicit
}

/** Whether the client should approve every request itself (the explicit bypass flags). */
export function skipsPermissions(input: { readonly yolo: boolean; readonly dangerouslySkipPermissions: boolean }) {
  return input.yolo || input.dangerouslySkipPermissions
}

type Sessions = Pick<OpenCodeClient["session"], "get" | "update">

/**
 * Sets `mode` on a session, keeping its other metadata: the server replaces metadata whole, so it is
 * read first (the same GET-merge-PATCH the editor clients use). Called before the first prompt, so
 * no tool call runs under the old mode. Reads the result back and fails if the runtime didn't keep it.
 */
export async function apply(sessions: Sessions, sessionID: string, mode: Mode) {
  const session = await sessions.get({ sessionID })
  const metadata = session.metadata ?? {}
  if (metadata[KetePermissionModes.metadataKey] === mode) return
  await sessions.update({ sessionID, metadata: { ...metadata, [KetePermissionModes.metadataKey]: mode } })
  const stored = (await sessions.get({ sessionID })).metadata?.[KetePermissionModes.metadataKey]
  if (stored !== mode) throw new Error(`the runtime didn't keep permission mode "${mode}" for session ${sessionID}`)
}
