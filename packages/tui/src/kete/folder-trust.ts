// Folder trust in the TUI (docs/folder-trust.md; core/src/kete/folder-trust.ts). The TUI loads TUI
// plugins from `.kete/plugins/` in its own process, so a project's plugin directory loads only when the
// server, asked about the TUI's own directory (not the server's default location), says the folder is
// trusted and lists that directory with a digest of its files equal to the one the TUI computes itself
// just before loading (the `kete.folder.trust` RPC). So a plugin file (or its `node_modules`) changed
// after the folder was trusted, or a server answering about another folder, never gets imported. Fail
// closed: an error, a timeout, a runtime without the RPC, a missing or different digest means no, and
// only the global plugin directory loads. The server's own plugin list goes through the same check
// (`serverTargets`): a local plugin it reports outside the global plugin directory loads only when the
// server lists it with a digest equal to the TUI's, so the list can't bring back a project plugin the
// discovery check refused. plugin/context.tsx reloads when the RPC's `changed` event says the folder
// is now trusted.

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

/** The server's digest for each requested path it says may load now, asked about `directory` (the TUI's
 * own working directory); empty on anything but a well-formed answer. With `requireTrusted`, empty
 * unless the answer also says the folder is trusted. */
async function ask(
  client: Pick<OpenCodeClient, "rpc">,
  directory: string,
  directories: ReadonlyArray<string>,
  requireTrusted: boolean,
): Promise<ReadonlyMap<string, string>> {
  try {
    const response = await client.rpc.call(
      { rpcID: KeteFolderTrustRpc.ID, method: "status", input: { directories: [...directories] }, location: { directory } },
      { signal: AbortSignal.timeout(15_000) },
    )
    const status = decodePlugins(response.output)
    if (status._tag !== "Some" || (requireTrusted && status.value.trusted !== true)) return new Map()
    return new Map(status.value.plugins.filter((item) => directories.includes(item.directory)).map((item) => [item.directory, item.digest]))
  } catch {
    return new Map()
  }
}

/** The server's digest for each requested project plugin directory it trusts, asked about `directory`
 * (the TUI's own working directory); empty on anything but a clear, well-formed yes. */
export function trusted(client: Pick<OpenCodeClient, "rpc">, directory: string, directories: ReadonlyArray<string>) {
  return ask(client, directory, directories, true)
}

/** The server's digest for each requested local plugin directory it says may load now (a trusted
 * project's plugin, still what was trusted; or one the machine-level config names), asked about
 * `directory`. The server lists only what may load, so this doesn't need the folder to be trusted. */
export function listed(client: Pick<OpenCodeClient, "rpc">, directory: string, directories: ReadonlyArray<string>) {
  return ask(client, directory, directories, false)
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

function within(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

type ServerPlugin = {
  readonly source: { readonly type: "package"; readonly target: string } | { readonly type: "local"; readonly path: string }
}

/** The entries to load for the server's TUI plugins: a package by name; a local plugin from the
 * directory of its server entrypoint, only when it sits in the global plugin directory (a non-project
 * one in `directories`, `plugin/` or `plugins/`) or the server lists it (`ask`) with a digest equal to
 * the one computed here (`digest`) just before loading. So a project plugin the discovery check refused
 * (changed since the folder was trusted, or never trusted) isn't imported because the server's list
 * still has it; anything else (an error, no answer, a different digest) drops it. */
export async function serverTargets(
  plugins: ReadonlyArray<ServerPlugin>,
  directories: ReadonlyArray<string>,
  ask: (local: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>,
  digest: (directory: string) => Promise<string | null | undefined> = (directory) => KeteFolderTrustRules.targetDigest(directory),
): Promise<string[]> {
  const roots = directories
    .filter((directory) => !isProjectDirectory(directory))
    .flatMap((directory) => KeteFolderTrustRules.PLUGIN_DIRECTORIES.map((name) => path.join(path.dirname(path.resolve(directory)), name)))
  const entries = plugins.map((plugin) => {
    if (plugin.source.type === "package") return { entry: plugin.source.target, checked: false }
    const entry = path.dirname(plugin.source.path)
    return { entry, checked: !roots.some((root) => within(entry, root)) }
  })
  const asked = [...new Set(entries.filter((item) => item.checked).map((item) => item.entry))]
  const expected = asked.length === 0 ? new Map<string, string>() : await ask(asked).catch(() => new Map<string, string>())
  const verified = new Set<string>()
  for (const directory of asked) {
    const want = expected.get(directory)
    if (want === undefined) continue
    const local = await digest(directory).catch(() => undefined)
    if (typeof local === "string" && local === want) verified.add(directory)
  }
  return entries.filter((item) => !item.checked || verified.has(item.entry)).map((item) => item.entry)
}

/** Whether an event says the folder is now trusted. */
export function becameTrusted(event: { readonly type?: string; readonly data?: unknown } | undefined): boolean {
  if (event?.type !== eventType) return false
  const status = decodeStatus(event.data)
  return status._tag === "Some" && status.value.trusted
}
