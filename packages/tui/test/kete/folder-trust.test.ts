// Folder trust in the TUI (src/kete/folder-trust.ts): a project's .kete/plugins load only when the
// server says the folder is trusted; anything else (an error, a timeout, an older runtime, a malformed
// answer) keeps them out, and the global plugin directory always loads.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import { allowed, becameTrusted, eventType, isProjectDirectory, trusted } from "../../src/kete/folder-trust"

type Rpc = Pick<OpenCodeClient, "rpc">
const client = (call: (...args: unknown[]) => Promise<unknown>) => ({ rpc: { call } }) as unknown as Rpc

const globalPlugins = path.join(path.sep, "home", "u", ".config", "kete", "plugins")
const projectPlugins = path.join(path.sep, "work", "repo", ".kete", "plugins")

describe("TUI folder trust", () => {
  test("project plugin directories load only once trusted; the global one always", async () => {
    expect(isProjectDirectory(projectPlugins)).toBe(true)
    expect(isProjectDirectory(globalPlugins)).toBe(false)
    const full = async () => true
    expect(await allowed([globalPlugins, projectPlugins], async () => false, full)).toEqual([globalPlugins])
    expect(await allowed([globalPlugins, projectPlugins], async () => true, full)).toEqual([globalPlugins, projectPlugins])
    expect(await allowed([globalPlugins, projectPlugins], () => Promise.reject(new Error("down")), full)).toEqual([globalPlugins])
    // An unreadable project plugin directory counts as having something (fail closed).
    expect(await allowed([globalPlugins, projectPlugins], async () => false, () => Promise.reject(new Error("EACCES")))).toEqual([globalPlugins])
    // An empty or missing project plugin directory: nothing to load, nothing to ask.
    let asked = false
    const ask = async () => {
      asked = true
      return true
    }
    expect(await allowed([globalPlugins, projectPlugins], ask, async () => false)).toEqual([globalPlugins])
    expect(asked).toBe(false)
    expect(await allowed([globalPlugins], ask)).toEqual([globalPlugins])
    expect(asked).toBe(false)
  })

  test("the RPC: only a clear yes is trusted (fail closed)", async () => {
    const calls: unknown[] = []
    const yes = client(async (input) => {
      calls.push(input)
      return { output: { trusted: true } }
    })
    expect(await trusted(yes, { directory: "/work/repo" } as never)).toBe(true)
    expect(calls).toEqual([{ rpcID: "kete.folder.trust", method: "status", input: {}, location: { directory: "/work/repo" } }])
    expect(await trusted(client(async () => ({ output: { trusted: false } })), undefined)).toBe(false)
    expect(await trusted(client(async () => ({ output: { trusted: "yes" } })), undefined)).toBe(false)
    expect(await trusted(client(async () => ({ output: undefined })), undefined)).toBe(false)
    expect(await trusted(client(() => Promise.reject(new Error("no such rpc"))), undefined)).toBe(false)
  })

  test("the changed event reloads only when it says trusted", () => {
    expect(becameTrusted({ type: eventType, data: { trusted: true } })).toBe(true)
    expect(becameTrusted({ type: eventType, data: { trusted: false } })).toBe(false)
    expect(becameTrusted({ type: "rpc.kete.other.changed", data: { trusted: true } })).toBe(false)
    expect(becameTrusted(undefined)).toBe(false)
  })
})
