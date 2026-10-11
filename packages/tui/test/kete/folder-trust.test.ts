// Folder trust in the TUI (src/kete/folder-trust.ts): a project's .kete/plugins load only when the
// server says the folder is trusted; anything else (an error, a timeout, an older runtime, a malformed
// answer) keeps them out, and the global plugin directory always loads.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import type { OpenCodeClient } from "@opencode/client"
import { allowed, becameTrusted, eventType, isProjectDirectory, trusted } from "../../src/kete/folder-trust"

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
})
