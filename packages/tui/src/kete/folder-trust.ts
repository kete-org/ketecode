// Folder trust in the TUI (docs/folder-trust.md; core/src/kete/folder-trust.ts). The TUI loads TUI
// plugins from `.kete/plugins/` in its own process, so a project's plugin directories load only when
// the server says the folder is trusted (the `kete.folder.trust` RPC). Fail closed: an error, a
// timeout or a runtime without the RPC means untrusted, and only the global plugin directory loads.
// plugin/context.tsx reloads when the RPC's `changed` event says the folder is now trusted.

import { readdir } from "node:fs/promises"
import path from "node:path"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { KeteFolderTrustRpc } from "@opencode/schema/kete/folder-trust"
import { Brand } from "@opencode/util/kete/brand"
import { Schema } from "effect"

const decodeStatus = Schema.decodeUnknownOption(KeteFolderTrustRpc.Status)
export const eventType = `rpc.${KeteFolderTrustRpc.ID}.changed`

/** Whether a plugin directory belongs to a project (`<folder>/.kete/plugins`), not the global config. */
export function isProjectDirectory(directory: string): boolean {
  return path.basename(path.dirname(path.resolve(directory))) === Brand.projectDirectory
}

/** Whether the server trusts the location's folder; anything but a clear yes is no. */
export async function trusted(client: Pick<OpenCodeClient, "rpc">, location: LocationRef | undefined): Promise<boolean> {
  try {
    const response = await client.rpc.call(
      { rpcID: KeteFolderTrustRpc.ID, method: "status", input: {}, location },
      { signal: AbortSignal.timeout(15_000) },
    )
    const status = decodeStatus(response.output)
    return status._tag === "Some" && status.value.trusted === true
  } catch {
    return false
  }
}

/** Whether a directory has anything in it (missing or unreadable counts as having something only
 * when it exists: an error other than "missing" fails closed). */
async function occupied(directory: string): Promise<boolean> {
  return readdir(directory).then(
    (names) => names.length > 0,
    (error: NodeJS.ErrnoException) => error?.code !== "ENOENT" && error?.code !== "ENOTDIR",
  )
}

/** The plugin directories that may load: the global one always, a project's only when trusted. The
 * server is asked only when a project plugin directory has something in it. */
export async function allowed(
  directories: ReadonlyArray<string>,
  isTrusted: () => Promise<boolean>,
  hasEntries: (directory: string) => Promise<boolean> = occupied,
): Promise<string[]> {
  const project = directories.filter(isProjectDirectory)
  const used = (await Promise.all(project.map((directory) => hasEntries(directory).catch(() => true)))).some(Boolean)
  if (!used) return directories.filter((directory) => !isProjectDirectory(directory))
  const ok = await isTrusted().catch(() => false)
  return directories.filter((directory) => ok || !isProjectDirectory(directory))
}

/** Whether an event says the folder is now trusted. */
export function becameTrusted(event: { readonly type?: string; readonly data?: unknown } | undefined): boolean {
  if (event?.type !== eventType) return false
  const status = decodeStatus(event.data)
  return status._tag === "Some" && status.value.trusted
}
