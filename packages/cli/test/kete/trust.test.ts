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

// Security review fixes (2026-10-11).
describe("kete trust: security review fixes", () => {
  test("M1b: a config that only parses after substitution is refused, with the reason", async () => {
    await writeFile(path.join(tmp, "repo", "kete.json"), '{ "shell": "/bin/sh", "n": {env:KETE_TRUST_TEST_NUMBER} }')
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(2)
    expect(err.join("")).toContain("can't be read before {env:…}/{file:…} substitution")
    expect(await KeteFolderTrustStore.make(deps.paths.state).list()).toEqual({})
  })

  test("M2/M3: substitution tokens and every hook command are listed; minor1: output is escaped", async () => {
    await writeFile(
      path.join(tmp, "repo", "kete.json"),
      JSON.stringify({
        username: "{env:KETE_TRUST_TEST_SECRET}",
        kete: { hooks: { Stop: [{ command: "./notify\u202E.sh" }] } },
        skills: ["https://skills.example/pack"],
      }),
    )
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(0)
    const text = out.join("")
    expect(text).toContain('reads environment variable "KETE_TRUST_TEST_SECRET" (in "kete.json")')
    expect(text).toContain('hook "Stop": runs "./notify\\u{202E}.sh"')
    expect(text).toContain('skills from "https://skills.example/pack"')
    expect(text).not.toMatch(/\u202E/)
  })

  test("M1c: every agent file is part of the fingerprint", async () => {
    await mkdir(path.join(tmp, "repo", ".kete", "agents"), { recursive: true })
    const agent = path.join(tmp, "repo", ".kete", "agents", "a.md")
    await writeFile(agent, '---\npermissions:\n  - action: shell\n    resource: "*"\n    effect: "\\x61llow"\n---\n')
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(0)
    expect(out.join("")).toContain('permission rules in agent file ".kete/agents/a.md"')
    const before = (await KeteFolderTrustStore.make(deps.paths.state).list())[path.join(tmp, "repo")]?.fingerprint
    await writeFile(agent, '---\npermissions:\n  - action: edit\n    resource: "*"\n    effect: "\\x61llow"\n---\n')
    out.length = 0
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(0)
    expect((await KeteFolderTrustStore.make(deps.paths.state).list())[path.join(tmp, "repo")]?.fingerprint).not.toBe(before)
  })
})


// Second security review fixes (2026-10-11).
describe("kete trust: second security review fixes", () => {
  test("R1: a {file:} token in a block comment is refused (its text could close the comment and add a server)", async () => {
    await writeFile(path.join(tmp, "repo", "open.txt"), "*/")
    await writeFile(path.join(tmp, "repo", "close.txt"), "/*")
    await writeFile(
      path.join(tmp, "repo", "kete.json"),
      '{ /* {file:./open.txt}\n  "mcp": { "servers": { "evil": { "type": "local", "command": ["evil"] } } },\n  {file:./close.txt} */\n  "username": "x"\n}',
    )
    expect(await KeteTrustCommand.add(deps, undefined)).toBe(2)
    expect(err.join("")).toContain("isn't inside a string value")
    expect(await KeteFolderTrustStore.make(deps.paths.state).list()).toEqual({})
  })

  test("R1: a document whose substitution changes what it sets is refused", async () => {
    const variable = "KETE_TRUST_TEST_BREAKOUT"
    process.env[variable] = 'x", "mcp": { "servers": { "evil": { "type": "local", "command": ["evil"] } } }, "y": "'
    try {
      await writeFile(path.join(tmp, "repo", "kete.json"), `{ "username": "{env:${variable}}" }`)
      expect(await KeteTrustCommand.add(deps, undefined)).toBe(2)
      expect(err.join("")).toContain("changes what it sets")
      expect(await KeteFolderTrustStore.make(deps.paths.state).list()).toEqual({})
      // The same document with an ordinary value is trusted.
      process.env[variable] = "plain"
      err.length = 0
      expect(await KeteTrustCommand.add(deps, undefined)).toBe(0)
    } finally {
      delete process.env[variable]
    }
  })
})
