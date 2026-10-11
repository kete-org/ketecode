// Folder trust in the TUI (docs/folder-trust.md; core/src/kete/folder-trust.ts). The TUI loads TUI
// plugins from `.kete/plugins/` in its own process, so a project's plugin directory loads only when the
// server, asked about the TUI's own directory (not the server's default location), says the folder is
// trusted and lists that directory with a digest of its files equal to the one the TUI computes itself
// just before loading (the `kete.folder.trust` RPC). So a plugin file (or its `node_modules`) changed
// after the folder was trusted, or a server answering about another folder, never gets imported. Fail
// closed: an error, a timeout, a runtime without the RPC, a missing or different digest means no, and
// only the global plugin directory loads. plugin/context.tsx reloads when the RPC's `changed` event
// says the folder is now trusted.

import { readdir } from "node:fs/promises"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import { KeteFolderTrustRpc } from "@opencode/schema/kete/folder-trust"
import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { Schema } from "effect"

const decodeStatus = Schema.decodeUnknownOption(KeteFolderTrustRpc.Status)
const decodePlugins = Schema.decodeUnknownOption(KeteFolderTrustRpc.Plugins)
export const eventType = `rpc.${KeteFolderTrustRpc.ID}.changed`

/** Whether a plugin directory belongs to a project (`<folder>/.kete/plugins`), not the global config. */
export function isProjectDirectory(directory: string): boolean {
  return path.basename(path.dirname(path.resolve(directory))) === Brand.projectDirectory
}

/** The server's digest for each requested project plugin directory it trusts, asked about `directory`
 * (the TUI's own working directory); empty on anything but a clear, well-formed yes. */
export async function trusted(
  client: Pick<OpenCodeClient, "rpc">,
  directory: string,
  directories: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  try {
    const response = await client.rpc.call(
      { rpcID: KeteFolderTrustRpc.ID, method: "status", input: { directories: [...directories] }, location: { directory } },
      { signal: AbortSignal.timeout(15_000) },
    )
    const status = decodePlugins(response.output)
    if (status._tag !== "Some" || status.value.trusted !== true) return new Map()
    return new Map(status.value.plugins.filter((item) => directories.includes(item.directory)).map((item) => [item.directory, item.digest]))
  } catch {
    return new Map()
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

/** The plugin directories that may load: the global one always; a project's only when the server
 * trusts it and its digest (`ask`) equals the one computed here (`digest`). The server is asked only
 * when a project plugin directory has something in it. */
export async function allowed(
  directories: ReadonlyArray<string>,
  ask: (project: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>,
  hasEntries: (directory: string) => Promise<boolean> = occupied,
  digest: (directory: string) => Promise<string | undefined> = (directory) => KeteFolderTrustRules.pluginDigest(directory),
): Promise<string[]> {
  const project = directories.filter(isProjectDirectory)
  const used = await Promise.all(project.map((directory) => hasEntries(directory).catch(() => true)))
  const asked = project.filter((_, index) => used[index])
  if (asked.length === 0) return directories.filter((directory) => !isProjectDirectory(directory))
  const trustedDigests = await ask(asked).catch(() => new Map<string, string>())
  const verified = new Set<string>()
  for (const directory of asked) {
    const expected = trustedDigests.get(directory)
    if (expected === undefined) continue
    const local = await digest(directory).catch(() => undefined)
    if (local !== undefined && local === expected) verified.add(directory)
  }
  return directories.filter((directory) => !isProjectDirectory(directory) || verified.has(directory))
}

/** Whether an event says the folder is now trusted. */
export function becameTrusted(event: { readonly type?: string; readonly data?: unknown } | undefined): boolean {
  if (event?.type !== eventType) return false
  const status = decodeStatus(event.data)
  return status._tag === "Some" && status.value.trusted
}
