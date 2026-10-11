// `kete trust list|add|remove` (cli/src/kete/trust.ts, AC11): on real files in a temporary state
// directory; home and the filesystem root are refused; a subdirectory trusts its repository; remove
// also forgets the repository's project hooks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteFolderTrustStore } from "@opencode/util/kete/folder-trust-store"
import { KeteTrustStore } from "@opencode/util/kete/trust-store"
import { KeteTrustCommand } from "../../src/kete/trust"

let tmp: string
let out: string[]
let err: string[]
let deps: KeteTrustCommand.Deps

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "kete-trust-")))
  out = []
  err = []
  deps = {
    paths: { config: path.join(tmp, "global"), state: path.join(tmp, "state"), home: path.join(tmp, "home") },
    cwd: path.join(tmp, "repo"),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  }
  await mkdir(path.join(tmp, "global"), { recursive: true })
  await mkdir(path.join(tmp, "home"), { recursive: true })
  await mkdir(path.join(tmp, "repo", ".git"), { recursive: true })
  await mkdir(path.join(tmp, "repo", "src"), { recursive: true })
  await writeFile(path.join(tmp, "repo", "kete.json"), JSON.stringify({ shell: "/bin/sh", mcp: { x: { type: "local", command: ["x"] } } }))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe("kete trust", () => {
  test("list: empty, then the trusted folder (text and JSON)", async () => {
    expect(await KeteTrustCommand.list(deps, "default")).toBe(0)
    expect(out.join("")).toContain("No trusted folders")
    out.length = 0
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(0)
    out.length = 0
    expect(await KeteTrustCommand.list(deps, "default")).toBe(0)
    expect(out.join("")).toContain(path.join(tmp, "repo"))
    expect(out.join("")).toContain('shell: "/bin/sh"')
    out.length = 0
    expect(await KeteTrustCommand.list(deps, "json")).toBe(0)
    const listed = JSON.parse(out.join(""))
    expect(listed).toHaveLength(1)
    expect(listed[0].folder).toBe(path.join(tmp, "repo"))
  })

  test("add: a subdirectory trusts its repository root, with the current fingerprint", async () => {
    expect(await KeteTrustCommand.add({ ...deps, cwd: path.join(tmp, "repo", "src") }, undefined)).toBe(0)
    const stored = await KeteFolderTrustStore.make(deps.paths.state).list()
    expect(Object.keys(stored)).toEqual([path.join(tmp, "repo")])
    expect(stored[path.join(tmp, "repo")]?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(stored[path.join(tmp, "repo")]?.held.join("\n")).toContain('MCP server "x"')
  })

  test("add: refuses the home directory and the filesystem root", async () => {
    expect(await KeteTrustCommand.add(deps, path.join(tmp, "home"))).toBe(2)
    expect(err.join("")).toContain("home directory")
    err.length = 0
    expect(await KeteTrustCommand.add(deps, path.parse(tmp).root)).toBe(2)
    expect(err.join("")).toContain("root of the file system")
    expect(await KeteFolderTrustStore.make(deps.paths.state).list()).toEqual({})
  })

  test("add: a path that doesn't exist is refused", async () => {
    expect(await KeteTrustCommand.add(deps, path.join(tmp, "missing"))).toBe(2)
  })

  test("remove: forgets the folder and its project hooks", async () => {
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(0)
    await KeteTrustStore.hooks(deps.paths.state).set(path.join(tmp, "repo"), { fingerprint: "a".repeat(64), commands: ["x"], trusted: 1 })
    await KeteTrustStore.hooks(deps.paths.state).set("/elsewhere", { fingerprint: "b".repeat(64), commands: ["y"], trusted: 2 })
    out.length = 0
    expect(await KeteTrustCommand.remove(deps, undefined)).toBe(0)
    expect(out.join("")).toContain("no longer trusted")
    expect(await KeteFolderTrustStore.make(deps.paths.state).list()).toEqual({})
    const hooks = JSON.parse(await readFile(path.join(deps.paths.state, "hooks-trust.json"), "utf8"))
    expect(Object.keys(hooks.repositories)).toEqual(["/elsewhere"])
    out.length = 0
    expect(await KeteTrustCommand.remove(deps, undefined)).toBe(0)
    expect(out.join("")).toContain("wasn't trusted")
  })
})
