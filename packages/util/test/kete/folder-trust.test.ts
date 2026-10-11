// Folder trust's shared rules (util/src/kete/folder-trust.ts) and stores (trust-store.ts,
// folder-trust-store.ts): the job list is unchanged, the runtime list, loosening rules, what is shown,
// the trust root (symlinks, prefixes, linked worktrees, forged .git files), never-trusted folders,
// the fingerprint and its caps, run trust, and the store failing closed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteFolderTrustRules as Rules } from "../../src/kete/folder-trust.js"
import { KeteFolderTrustStore } from "../../src/kete/folder-trust-store.js"
import { KeteTrustStore } from "../../src/kete/trust-store.js"

let tmp: string

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "kete-folder-trust-")))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function write(relative: string, content: string) {
  const file = path.join(tmp, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

const match = (input: string, pattern: string) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(input)

// `kete job run`'s list exactly as it was before the move (cli/src/kete/job-project-config.ts).
function previousGuardedKeys(document: unknown): string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  const entries = (value: unknown, prefix: string) => {
    if (!isRecord(value)) return [prefix]
    const names = Object.keys(value)
    return names.length === 0 ? [prefix] : names.map((name) => `${prefix}.${name}`)
  }
  if (!isRecord(document)) return []
  const found: string[] = []
  for (const key of ["providers", "provider", "mcp"]) if (key in document) found.push(...entries(document[key], key))
  for (const key of ["plugins", "plugin", "enterprise"]) if (key in document) found.push(key)
  if ("share" in document && document.share !== "disabled") found.push("share")
  if ("autoshare" in document && document.autoshare !== false) found.push("autoshare")
  const kete = document.kete
  if (isRecord(kete)) for (const key of ["integrations", "platform", "unattended", "hooks"]) if (key in kete) found.push(`kete.${key}`)
  return found
}

const samples: unknown[] = [
  {},
  null,
  [],
  "x",
  { providers: { a: {}, b: {} }, provider: {}, mcp: "x" },
  { plugins: [], plugin: "x", enterprise: {}, share: "disabled", autoshare: false },
  { share: "auto", autoshare: true, kete: { integrations: {}, budget: {} } },
  { kete: "x", formatter: true, shell: "/bin/zsh", worktree: {}, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  { theme: "dark", agents: { a: { permissions: [] } } },
]

describe("job list", () => {
  test("guardedKeys is exactly the previous kete job run list", () => {
    for (const sample of samples) expect(Rules.guardedKeys(sample)).toEqual(previousGuardedKeys(sample))
  })

  test("the job list doesn't include the runtime additions", () => {
    expect(Rules.guardedKeys({ formatter: true, shell: "x", worktree: {}, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).toEqual([])
  })
})

describe("runtime list", () => {
  test("is a superset of the job list", () => {
    for (const sample of samples)
      for (const key of Rules.guardedKeys(sample)) expect(Rules.runtimeGuarded(sample)).toContain(key)
  })

  test("formatter is held back unless it is false (true or an object turns on the built-in formatters)", () => {
    expect(Rules.runtimeGuarded({ formatter: false })).toEqual([])
    expect(Rules.runtimeGuarded({ formatter: true })).toEqual(["formatter"])
    expect(Rules.runtimeGuarded({ formatter: { prettier: { disabled: true } } })).toEqual(["formatter"])
    expect(Rules.runtimeGuarded({ formatter: { x: { command: ["./fmt"] } } })).toEqual(["formatter"])
    expect(Rules.guardedValues({ formatter: false })).toEqual({})
  })

  test("shell and worktree are held back whole", () => {
    expect(Rules.runtimeGuarded({ shell: "/bin/bash", worktree: { directory: "~/x" } })).toEqual(["shell", "worktree"])
  })

  test("permission keys count when they allow something, native and v1", () => {
    expect(Rules.runtimeGuarded({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] })).toEqual([])
    expect(Rules.runtimeGuarded({ permissions: [{ action: "shell", resource: "*", effect: "allow" }] })).toEqual(["permissions"])
    expect(Rules.runtimeGuarded({ permission: "allow" })).toEqual(["permission"])
    expect(Rules.runtimeGuarded({ permission: { bash: { "git *": "allow" } } })).toEqual(["permission"])
    expect(Rules.runtimeGuarded({ tools: { bash: true } })).toEqual(["tools"])
    expect(Rules.runtimeGuarded({ tools: { bash: false } })).toEqual([])
    expect(
      Rules.runtimeGuarded({
        agents: { build: { permissions: [{ action: "edit", resource: "*", effect: "allow" }] } },
        mode: { plan: { tools: { bash: true } } },
      }),
    ).toEqual(["agents.build.permissions", "mode.plan.tools"])
  })

  test("the fingerprint covers whole permission values, deny rules included", () => {
    const deny = [{ action: "shell", resource: "*", effect: "deny" }]
    expect(Rules.guardedValues({ permissions: deny, theme: "x", agents: { a: { permission: "ask", model: "m" } } })).toEqual({
      permissions: deny,
      "agents.a.permission": "ask",
    })
  })
})

describe("loosening", () => {
  const rules = [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "shell", resource: "rm *", effect: "deny" },
    { action: "edit", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "ask" },
  ]

  test("allow is held; deny and ask are kept", () => {
    const split = Rules.loosening(rules, [], match)
    expect(split.held).toEqual([rules[0]])
    expect(split.kept).toEqual([rules[1], rules[2], rules[3]])
  })

  test("an ask overlapping a machine deny is held, in either direction", () => {
    expect(Rules.loosening(rules, [{ action: "edit", resource: "secret/*", effect: "deny" }], match).held).toEqual([rules[0], rules[2]])
    expect(Rules.loosening(rules, [{ action: "web*", resource: "*", effect: "deny" }], match).held).toEqual([rules[0], rules[3]])
    expect(Rules.loosening([{ action: "*", resource: "*", effect: "ask" }], [{ action: "edit", resource: "*", effect: "deny" }], match).held).toHaveLength(1)
  })
})

describe("what is shown", () => {
  test("MCP commands and URLs, provider endpoints and header names, never keys or header values", () => {
    const items = Rules.describe({
      mcp: { servers: { tools: { type: "local", command: ["node", "./mcp.js"] }, remote: { type: "remote", url: "https://mcp.example" } } },
      providers: { x: { settings: { baseURL: "https://evil.example", apiKey: "sk-secret", headers: { Authorization: "Bearer secret" } } } },
      plugins: ["./plugin.ts", { package: "pkg", options: {} }],
      shell: "/bin/zsh",
      worktree: { directory: "~/trees" },
      formatter: { fmt: { command: ["./fmt"] } },
      kete: { hooks: {} },
    })
    const text = items.join("\n")
    expect(text).toContain('MCP server "tools": runs ["node","./mcp.js"]')
    expect(text).toContain('MCP server "remote": connects to "https://mcp.example"')
    expect(text).toContain('provider "x": settings.baseURL "https://evil.example"')
    expect(text).toContain('headers "Authorization"')
    expect(text).toContain('plugin "./plugin.ts"')
    expect(text).toContain('plugin "pkg"')
    expect(text).toContain('shell: "/bin/zsh"')
    expect(text).toContain('worktree directory: "~/trees"')
    expect(text).toContain('formatter "fmt": runs ["./fmt"]')
    expect(text).toContain("kete.hooks")
    expect(text).not.toContain("sk-secret")
    expect(text).not.toContain("Bearer")
  })

  test("legacy MCP shape", () => {
    expect(Rules.describe({ mcp: { x: { type: "local", command: ["x"] } } })).toEqual(['MCP server "x": runs ["x"]'])
  })

  test("agent files: front matter mentioning permission and allow, or tools and true", () => {
    expect(Rules.agentTextLoosens("---\npermissions:\n  - action: shell\n    resource: '*'\n    effect: allow\n---\nbody")).toBe(true)
    expect(Rules.agentTextLoosens("---\ntools:\n  bash: true\n---\nbody")).toBe(true)
    expect(Rules.agentTextLoosens("---\ndescription: x\n---\nallow permission in the body only")).toBe(false)
    expect(Rules.agentTextLoosens("no front matter: permission allow")).toBe(true)
  })
})

describe("fingerprint", () => {
  const input = (documents: Array<{ path: string; document: unknown }>, plugins: string[] = [], agents: string[] = []) => ({
    top: tmp,
    documents,
    plugins,
    agents,
  })

  test("changes with a guarded value, not with anything else", async () => {
    const file = path.join(tmp, "kete.json")
    const base = await Rules.fingerprint(input([{ path: file, document: { mcp: { x: { command: ["a"] } }, theme: "dark" } }]))
    expect(base.kind).toBe("ok")
    expect(await Rules.fingerprint(input([{ path: file, document: { mcp: { x: { command: ["a"] } }, theme: "light" } }]))).toEqual(base)
    expect(await Rules.fingerprint(input([{ path: file, document: { mcp: { x: { command: ["b"] } }, theme: "dark" } }]))).not.toEqual(base)
    // Key order and document order don't matter.
    const other = path.join(tmp, ".kete", "kete.json")
    const a = await Rules.fingerprint(input([{ path: file, document: { shell: "a", mcp: {} } }, { path: other, document: { shell: "b" } }]))
    const b = await Rules.fingerprint(input([{ path: other, document: { shell: "b" } }, { path: file, document: { mcp: {}, shell: "a" } }]))
    expect(a).toEqual(b)
    // A document with nothing guarded isn't part of it.
    expect(await Rules.fingerprint(input([{ path: file, document: { theme: "x" } }]))).toEqual(await Rules.fingerprint(input([])))
  })

  test("covers plugin and agent file contents", async () => {
    await write(".kete/plugins/p.ts", "export default 1")
    const agent = await write(".kete/agents/a.md", "---\npermissions: allow\n---\n")
    const plugins = await Rules.pluginDirectories(path.join(tmp, ".kete"))
    const agents = await Rules.agentPermissionFiles(path.join(tmp, ".kete"))
    expect(plugins).toEqual([path.join(tmp, ".kete", "plugins")])
    expect(agents).toEqual([agent])
    const base = await Rules.fingerprint(input([], plugins, agents))
    await write(".kete/plugins/p.ts", "export default 2")
    const changed = await Rules.fingerprint(input([], plugins, agents))
    expect(changed).not.toEqual(base)
    await write(".kete/agents/a.md", "---\npermissions: allow all\n---\n")
    expect(await Rules.fingerprint(input([], plugins, agents))).not.toEqual(changed)
  })

  test("the same through a symlinked path", async () => {
    await mkdir(path.join(tmp, "repo"))
    await symlink(path.join(tmp, "repo"), path.join(tmp, "link"))
    const document = { shell: "x" }
    const real = await Rules.fingerprint({ top: path.join(tmp, "repo"), documents: [{ path: path.join(tmp, "repo", "kete.json"), document }], plugins: [], agents: [] })
    await writeFile(path.join(tmp, "repo", "kete.json"), "{}")
    const viaLink = await Rules.fingerprint({ top: path.join(tmp, "repo"), documents: [{ path: path.join(tmp, "link", "kete.json"), document }], plugins: [], agents: [] })
    expect(viaLink).toEqual(real)
  })

  test("over a cap there is no fingerprint (fail closed)", async () => {
    const many = Array.from({ length: Rules.MAX_FILES + 1 }, (_, index) => `f${index}.ts`)
    const fs: Rules.Fs = {
      ...Rules.nodeFs,
      realpath: async (file: string) => file,
      readDir: async () => many,
      stat: async () => ({ kind: "file", size: 1 }),
      readBytes: async () => new Uint8Array([1]),
    }
    const result = await Rules.fingerprint({ top: "/r", documents: [], plugins: ["/r/.kete/plugins"], agents: [] }, fs)
    expect(result.kind).toBe("unavailable")
  })
})

describe("security", () => {
  test("a symlink into a repository resolves to the same trust root", async () => {
    await mkdir(path.join(tmp, "repo", ".git"), { recursive: true })
    await mkdir(path.join(tmp, "repo", "src"), { recursive: true })
    await symlink(path.join(tmp, "repo", "src"), path.join(tmp, "elsewhere"))
    const direct = await Rules.trustRoot(path.join(tmp, "repo", "src"))
    const linked = await Rules.trustRoot(path.join(tmp, "elsewhere"))
    expect(direct).toEqual({ kind: "ok", root: path.join(tmp, "repo"), top: path.join(tmp, "repo") })
    expect(linked).toEqual(direct)
  })

  test("a sibling sharing a prefix is a different root; keys compare exactly", async () => {
    await mkdir(path.join(tmp, "repo", ".git"), { recursive: true })
    await mkdir(path.join(tmp, "repo-evil"), { recursive: true })
    const evil = await Rules.trustRoot(path.join(tmp, "repo-evil"))
    expect(evil).toEqual({ kind: "ok", root: path.join(tmp, "repo-evil"), top: path.join(tmp, "repo-evil") })
    const store = KeteFolderTrustStore.make(path.join(tmp, "state"))
    await store.trust(Rules.storeKey(path.join(tmp, "repo")), "a".repeat(64), [])
    expect(await store.trusted(Rules.storeKey(path.join(tmp, "repo-evil")), "a".repeat(64))).toBe(false)
    expect(await store.trusted(Rules.storeKey(path.join(tmp, "repo")), "a".repeat(64))).toBe(true)
  })

  test("the home directory and filesystem roots are never trusted", () => {
    expect(Rules.neverTrusted("/home/u", "/home/u", "linux")).toContain("home directory")
    expect(Rules.neverTrusted("/", "/home/u", "linux")).toContain("root of the file system")
    expect(Rules.neverTrusted("/home/u/project", "/home/u", "linux")).toBeUndefined()
    expect(Rules.neverTrusted("c:\\", "C:\\Users\\u", "win32")).toContain("root of the file system")
    expect(Rules.neverTrusted(Rules.storeKey("C:\\Users\\U", "win32"), "C:\\Users\\u", "win32")).toContain("home directory")
  })

  test("store keys are lowercased on Windows only", () => {
    expect(Rules.storeKey("C:\\Repo", "win32")).toBe("c:\\repo")
    expect(Rules.storeKey("/Users/Me/Repo", "darwin")).toBe("/Users/Me/Repo")
  })

  test("a forged .git file can't borrow another repository's root", async () => {
    await mkdir(path.join(tmp, "victim", ".git", "worktrees", "w"), { recursive: true })
    await writeFile(path.join(tmp, "victim", ".git", "worktrees", "w", "commondir"), "../..")
    await writeFile(path.join(tmp, "victim", ".git", "worktrees", "w", "gitdir"), path.join(tmp, "victim-wt", ".git"))
    await mkdir(path.join(tmp, "attacker"), { recursive: true })
    await writeFile(path.join(tmp, "attacker", ".git"), `gitdir: ${path.join(tmp, "victim", ".git", "worktrees", "w")}\n`)
    expect(await Rules.trustRoot(path.join(tmp, "attacker"))).toEqual({
      kind: "ok",
      root: path.join(tmp, "attacker"),
      top: path.join(tmp, "attacker"),
    })
  })

  test("a real linked worktree shares its main working tree's root", async () => {
    const main = path.join(tmp, "main")
    await mkdir(main)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })
    git("init", "-q")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    git("worktree", "add", "-q", path.join(tmp, "wt"))
    expect(await Rules.trustRoot(path.join(tmp, "wt"))).toEqual({ kind: "ok", root: main, top: path.join(tmp, "wt") })
  })

  test("run trust needs exactly the parent process id", () => {
    expect(Rules.runTrusted({ [Rules.RUN_TRUST_VARIABLE]: "4242" }, 4242)).toBe(true)
    expect(Rules.runTrusted({ [Rules.RUN_TRUST_VARIABLE]: "4242" }, 4243)).toBe(false)
    expect(Rules.runTrusted({ [Rules.RUN_TRUST_VARIABLE]: "1" }, 1)).toBe(false)
    expect(Rules.runTrusted({ [Rules.RUN_TRUST_VARIABLE]: "04242" }, 4242)).toBe(false)
    expect(Rules.runTrusted({}, 4242)).toBe(false)
    // The CLI's own variable is never read here.
    expect(Rules.runTrusted({ OPENCODE_TRUST_PROJECT_CONFIG: "1" }, 4242)).toBe(false)
  })

  test("the store: missing, malformed, unreadable or mismatched means nothing is trusted", async () => {
    const state = path.join(tmp, "state")
    const store = KeteFolderTrustStore.make(state)
    expect(await store.trusted("/r", "a".repeat(64))).toBe(false)
    await mkdir(state, { recursive: true })
    for (const text of ["{", "[]", JSON.stringify({ version: 2, folders: {} }), JSON.stringify({ version: 1, folders: { "/r": { fingerprint: "nothex" } } })]) {
      await writeFile(store.file, text)
      expect(await store.trusted("/r", "a".repeat(64))).toBe(false)
    }
    await rm(store.file)
    await mkdir(store.file)
    expect(await store.trusted("/r", "a".repeat(64))).toBe(false)
  })

  test("the store is written 0600, atomically, capped, and a changed fingerprint isn't trusted", async () => {
    const state = path.join(tmp, "state")
    const store = KeteFolderTrustStore.make(state)
    await store.trust("/r", "a".repeat(64), ["shell"])
    expect(await store.trusted("/r", "a".repeat(64))).toBe(true)
    expect(await store.trusted("/r", "b".repeat(64))).toBe(false)
    if (process.platform !== "win32") expect((await stat(store.file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(store.file, "utf8"))).toMatchObject({ version: 1, folders: { "/r": { held: ["shell"] } } })
    await store.remove("/r")
    expect(await store.trusted("/r", "a".repeat(64))).toBe(false)
    const capped = KeteTrustStore.make({
      stateDirectory: state,
      file: "capped.json",
      collection: "folders",
      entry: KeteFolderTrustStore.Entry,
      max: 3,
    })
    for (let index = 0; index < 5; index++) await capped.set(`/r${index}`, { fingerprint: "a".repeat(64), held: [], trusted: index })
    expect(Object.keys(await capped.list()).sort()).toEqual(["/r2", "/r3", "/r4"])
  })

  test("the hooks store keeps its file and format", async () => {
    const state = path.join(tmp, "state")
    const hooks = KeteTrustStore.hooks(state)
    await hooks.set("/repo", { fingerprint: "c".repeat(64), commands: ["x"], trusted: 1 })
    expect(path.basename(hooks.file)).toBe("hooks-trust.json")
    expect(JSON.parse(await readFile(hooks.file, "utf8"))).toEqual({
      version: 1,
      repositories: { "/repo": { fingerprint: "c".repeat(64), commands: ["x"], trusted: 1 } },
    })
  })
})
