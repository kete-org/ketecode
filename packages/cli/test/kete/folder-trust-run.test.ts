// `kete run` and folder trust (cli/src/kete/folder-trust.ts, AC7): --trust-project-config forces a
// private server that trusts only as the parent of that server, `--server` is refused for `kete run`
// (noted for `kete job run`), the warning names what was held back, the trust form is left alone, and
// the warning is printed only while the folder is untrusted.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteFolderTrustCli } from "../../src/kete/folder-trust"
import { KeteTrustCommand } from "../../src/kete/trust"

let tmp: string
let paths: KeteFolderTrustCli.Paths

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "kete-folder-trust-run-")))
  paths = { config: path.join(tmp, "global"), state: path.join(tmp, "state"), home: path.join(tmp, "home") }
  await mkdir(paths.config, { recursive: true })
  await mkdir(paths.home, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function write(relative: string, value: unknown) {
  const file = path.join(tmp, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value))
  return file
}

describe("connection", () => {
  test("not trusted: unchanged", () => {
    const env: Record<string, string | undefined> = {}
    expect(KeteFolderTrustCli.connection({ standalone: false }, false, "run", env, 4242)).toEqual({ ok: true, args: { standalone: false } })
    expect(env).toEqual({})
  })

  test("trusted: a private server, trusting only as its parent", () => {
    const env: Record<string, string | undefined> = {}
    const result = KeteFolderTrustCli.connection({ standalone: false }, true, "run", env, 4242)
    expect(result).toEqual({ ok: true, args: { standalone: true } })
    expect(env[KeteFolderTrustRules.RUN_TRUST_VARIABLE]).toBe("4242")
    // The private server (child of 4242) is run-trusted; a process it starts, or a background
    // service that inherited the variable, is not.
    expect(KeteFolderTrustRules.runTrusted(env, 4242)).toBe(true)
    expect(KeteFolderTrustRules.runTrusted(env, 5555)).toBe(false)
  })

  test("kete run refuses --server with it; kete job run keeps --server with a note", () => {
    const env: Record<string, string | undefined> = {}
    const run = KeteFolderTrustCli.connection({ server: "http://localhost:1", standalone: false }, true, "run", env, 4242)
    expect(run.ok).toBe(false)
    if (!run.ok) expect(run.message).toContain("--server")
    const job = KeteFolderTrustCli.connection({ server: "http://localhost:1", standalone: false }, true, "job", env, 4242)
    expect(job.ok).toBe(true)
    if (job.ok) {
      expect(job.args.server).toBe("http://localhost:1")
      expect(job.note).toContain("its own folder trust")
    }
    expect(env).toEqual({})
  })
})

describe("warning", () => {
  test("names what was held back, bounded, and says how to trust", () => {
    const text = KeteFolderTrustCli.warning({ held: ['MCP server "tools": runs ["node","./mcp.js"]', 'plugin code in ".kete/plugins"'] })
    expect(text).toContain('MCP server "tools"')
    expect(text).toContain("plugin code")
    expect(text).toContain("kete trust add")
    expect(text).toContain("--trust-project-config")
    const many = KeteFolderTrustCli.warning({ held: Array.from({ length: 30 }, (_, index) => `setting-${index}-${"x".repeat(20)}`) })
    expect(many).toMatch(/and \d+ more/)
    expect(many.length).toBeLessThan(500)
  })

  test("printed while untrusted, not once trusted", async () => {
    await mkdir(path.join(tmp, "repo", ".git"), { recursive: true })
    await write("repo/kete.json", { mcp: { servers: { tools: { type: "local", command: ["node", "./mcp.js"] } } }, username: "x" })
    await write("repo/.kete/plugins/p.ts", "export default {}")
    const printed: string[] = []
    await KeteFolderTrustCli.warnIfHeld(path.join(tmp, "repo"), paths, (text) => printed.push(text))
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain('MCP server "tools": runs ["node","./mcp.js"]')
    expect(printed[0]).toContain('plugin code in ".kete/plugins"')
    const out: string[] = []
    expect(await KeteTrustCommand.add({ paths, cwd: path.join(tmp, "repo"), out: (text) => out.push(text), err: (text) => out.push(text) }, undefined)).toBe(0)
    printed.length = 0
    await KeteFolderTrustCli.warnIfHeld(path.join(tmp, "repo"), paths, (text) => printed.push(text))
    expect(printed).toEqual([])
  })

  test("nothing guarded: no warning", async () => {
    await write("plain/kete.json", { username: "x", formatter: false })
    const printed: string[] = []
    await KeteFolderTrustCli.warnIfHeld(path.join(tmp, "plain"), paths, (text) => printed.push(text))
    expect(printed).toEqual([])
  })
})

describe("trust form", () => {
  test("kete run leaves the folder-trust question alone", () => {
    expect(KeteFolderTrustCli.isTrustForm({ metadata: { kind: "kete.folder.trust" } })).toBe(true)
    expect(KeteFolderTrustCli.isTrustForm({ metadata: { kind: "kete.hooks.trust" } })).toBe(false)
    expect(KeteFolderTrustCli.isTrustForm({})).toBe(false)
  })
})

describe("discovery", () => {
  test("walks to the filesystem root and skips the global config directory", async () => {
    await write("kete.json", { shell: "/bin/sh" })
    await write("repo/.kete/kete.jsonc", "{ /* c */ \"mcp\": {}, }")
    await write("global/kete.json", { shell: "/bin/zsh" })
    const found = await KeteFolderTrustCli.discover(path.join(tmp, "repo"), paths)
    expect(found.files).toContain(path.join(tmp, "kete.json"))
    expect(found.files).toContain(path.join(tmp, "repo", ".kete", "kete.jsonc"))
    expect(found.files).not.toContain(path.join(tmp, "global", "kete.json"))
    expect(found.directories).toEqual([path.join(tmp, "repo", ".kete")])
    expect((await KeteFolderTrustCli.discover(paths.config, paths)).files).toEqual([])
  })
})
