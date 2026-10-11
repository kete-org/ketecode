// Folder trust in the TUI (src/kete/folder-trust.ts): a project's .kete/plugins load only when the
// server says the folder is trusted; anything else (an error, a timeout, an older runtime, a malformed
// answer) keeps them out, and the global plugin directory always loads.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import type { OpenCodeClient } from "@opencode/client"
import { allowed, becameTrusted, eventType, isProjectDirectory, listed, serverTargets, trusted } from "../../src/kete/folder-trust"
import { discoverPluginTargets, mergePluginTargets } from "../../src/plugin/discovery"

type Rpc = Pick<OpenCodeClient, "rpc">
const client = (call: (...args: unknown[]) => Promise<unknown>) => ({ rpc: { call } }) as unknown as Rpc

const globalPlugins = path.join(path.sep, "home", "u", ".config", "kete", "plugins")
const projectPlugins = path.join(path.sep, "work", "repo", ".kete", "plugins")

describe("TUI folder trust", () => {
  const digests = (entries: Array<[string, string]>) => async () => new Map(entries)
  const local = (value: string | undefined) => async () => value

  test("project plugin directories load only when the server's digest equals the TUI's own; the global one always", async () => {
    expect(isProjectDirectory(projectPlugins)).toBe(true)
    expect(isProjectDirectory(globalPlugins)).toBe(false)
    const full = async () => true
    const both = [globalPlugins, projectPlugins]
    expect(await allowed(both, digests([]), full, local("d1"))).toEqual([globalPlugins])
    expect(await allowed(both, digests([[projectPlugins, "d1"]]), full, local("d1"))).toEqual(both)
    expect(await allowed(both, () => Promise.reject(new Error("down")), full, local("d1"))).toEqual([globalPlugins])
    // Second review fix 2: a plugin file (or its node_modules) changed after the server's answer, or
    // the server's files differ from the TUI's: never imported.
    expect(await allowed(both, digests([[projectPlugins, "d1"]]), full, local("d2"))).toEqual([globalPlugins])
    expect(await allowed(both, digests([[projectPlugins, "d1"]]), full, local(undefined))).toEqual([globalPlugins])
    expect(await allowed(both, digests([[projectPlugins, "d1"]]), full, () => Promise.reject(new Error("EACCES")))).toEqual([globalPlugins])
    // An unreadable project plugin directory counts as having something (fail closed).
    expect(await allowed(both, digests([]), () => Promise.reject(new Error("EACCES")), local("d1"))).toEqual([globalPlugins])
    // An empty or missing project plugin directory: nothing to load, nothing to ask.
    let asked = false
    const ask = async () => {
      asked = true
      return new Map([[projectPlugins, "d1"]])
    }
    expect(await allowed(both, ask, async () => false, local("d1"))).toEqual([globalPlugins])
    expect(asked).toBe(false)
    expect(await allowed([globalPlugins], ask)).toEqual([globalPlugins])
    expect(asked).toBe(false)
  })

  test("the digest the TUI computes is the util one, over every file including node_modules", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kete-tui-trust-"))
    try {
      const plugins = path.join(tmp, ".kete", "plugins")
      await mkdir(path.join(plugins, "p", "node_modules", "dep"), { recursive: true })
      await writeFile(path.join(plugins, "p", "index.ts"), "export default {}")
      await writeFile(path.join(plugins, "p", "node_modules", "dep", "index.js"), "module.exports = 1")
      const before = await KeteFolderTrustRules.pluginDigest(plugins)
      const ask = async () => new Map([[plugins, before!]])
      expect(await allowed([plugins], ask, async () => true)).toEqual([plugins])
      await writeFile(path.join(plugins, "p", "node_modules", "dep", "index.js"), "module.exports = 2")
      expect(await allowed([plugins], ask, async () => true)).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("the RPC: asked about the TUI's own directory; only a clear, well-formed yes counts (fail closed)", async () => {
    const calls: unknown[] = []
    const yes = client(async (input) => {
      calls.push(input)
      return { output: { trusted: true, plugins: [{ directory: projectPlugins, digest: "d1" }, { directory: "/elsewhere/.kete/plugins", digest: "x" }] } }
    })
    expect([...(await trusted(yes, "/work/repo", [projectPlugins]))]).toEqual([[projectPlugins, "d1"]])
    expect(calls).toEqual([
      { rpcID: "kete.folder.trust", method: "status", input: { directories: [projectPlugins] }, location: { directory: "/work/repo" } },
    ])
    const none = async (output: unknown) => (await trusted(client(async () => ({ output })), "/work/repo", [projectPlugins])).size
    expect(await none({ trusted: false, plugins: [{ directory: projectPlugins, digest: "d1" }] })).toBe(0)
    expect(await none({ trusted: true })).toBe(0)
    expect(await none({ trusted: "yes", plugins: [] })).toBe(0)
    expect(await none(undefined)).toBe(0)
    expect((await trusted(client(() => Promise.reject(new Error("no such rpc"))), "/work/repo", [projectPlugins])).size).toBe(0)
  })

  test("the changed event reloads only when it says trusted", () => {
    expect(becameTrusted({ type: eventType, data: { trusted: true } })).toBe(true)
    expect(becameTrusted({ type: eventType, data: { trusted: false } })).toBe(false)
    expect(becameTrusted({ type: "rpc.kete.other.changed", data: { trusted: true } })).toBe(false)
    expect(becameTrusted(undefined)).toBe(false)
  })

  // Third security review fix 1: the server's plugin list can't bring back a project plugin the
  // discovery check refused.
  test("a server-reported local plugin the discovery check refused isn't imported; one the server vouches for with the same digest is", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kete-tui-trust-"))
    try {
      const globalDir = path.join(tmp, "global", "plugins")
      const plugins = path.join(tmp, "repo", ".kete", "plugins")
      const both = path.join(plugins, "both")
      await mkdir(both, { recursive: true })
      await mkdir(path.join(globalDir, "g"), { recursive: true })
      await writeFile(path.join(both, "server.ts"), "export default {}")
      await writeFile(path.join(both, "tui.ts"), "export default {}")
      await writeFile(path.join(globalDir, "g", "server.ts"), "export default {}")
      const trustedDigest = (await KeteFolderTrustRules.targetDigest(both)) as string
      // The folder was trusted with this tui.ts; then it changed. The server no longer vouches for the
      // plugin directory (discovery refuses it) or for the plugin (it isn't listed), but its plugin list
      // still reports it from before.
      await writeFile(path.join(both, "tui.ts"), "export default { changed: true }")
      const server = [
        { source: { type: "local" as const, path: path.join(both, "server.ts") } },
        { source: { type: "local" as const, path: path.join(globalDir, "g", "server.ts") } },
        { source: { type: "package" as const, target: "some-package" } },
      ]
      const directories = [globalDir, plugins]
      const asked: Array<ReadonlyArray<string>> = []
      const refuse = async (local: ReadonlyArray<string>) => {
        asked.push(local)
        return new Map<string, string>()
      }
      const discovered = await allowed(directories, refuse).then(discoverPluginTargets)
      const fromServer = await serverTargets(server, directories, refuse)
      const merged = mergePluginTargets([...discovered, ...fromServer].map((entry) => ({ entry })), tmp).map((item) => item.entry)
      expect(merged).not.toContain(both)
      expect(merged).toContain(path.join(globalDir, "g"))
      expect(merged).toContain("some-package")
      // Only the project plugin was asked about; the global plugin directory and packages aren't.
      expect(asked.at(-1)).toEqual([both])
      // A stale answer (the digest from before the change) doesn't match the TUI's own: dropped.
      expect(await serverTargets(server, directories, async () => new Map([[both, trustedDigest]]))).toEqual([path.join(globalDir, "g"), "some-package"])
      // An error: dropped.
      expect(await serverTargets(server, directories, () => Promise.reject(new Error("down")))).toEqual([path.join(globalDir, "g"), "some-package"])
      // The server vouches for the files as they are now: loaded.
      const now = (await KeteFolderTrustRules.targetDigest(both)) as string
      expect(await serverTargets(server, directories, async () => new Map([[both, now]]))).toEqual([both, path.join(globalDir, "g"), "some-package"])
      // A project-configured local plugin outside .kete/plugins is checked the same way.
      const configured = [{ source: { type: "local" as const, path: path.join(tmp, "repo", "local", "server.ts") } }]
      expect(await serverTargets(configured, directories, refuse)).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("listed: the server's list counts without the folder being trusted (it lists only what may load); only requested paths", async () => {
    const mine = "/home/u/mine"
    const answer = client(async () => ({ output: { trusted: false, plugins: [{ directory: mine, digest: "d" }, { directory: "/x", digest: "y" }] } }))
    expect([...(await listed(answer, "/work/repo", [mine]))]).toEqual([[mine, "d"]])
    expect((await listed(client(async () => ({ output: { trusted: false } })), "/work/repo", [mine])).size).toBe(0)
    expect((await listed(client(() => Promise.reject(new Error("no such rpc"))), "/work/repo", [mine])).size).toBe(0)
  })
})
