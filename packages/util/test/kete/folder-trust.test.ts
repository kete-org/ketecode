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

// Security review fixes (2026-10-11).
describe("security review fixes", () => {
  test("minor1: safe escapes control, format, bidi and zero-width characters", () => {
    const text = Rules.safe("a\u202Eb\u200Bc\u009Bd\u0007e\u2028f\uFEFFg")
    expect(text).not.toMatch(/[\u202E\u200B\u009B\u0007\u2028\uFEFF]/)
    expect(text).toBe("a\\u{202E}b\\u{200B}c\\u{9B}d\\u{7}e\\u{2028}f\\u{FEFF}g")
    expect(Rules.safe(Rules.safe("x\u202E"))).toBe(Rules.safe("x\u202E"))
    expect(Rules.describe({ shell: "/bin/sh\u202E" }).join("")).not.toContain("\u202E")
    // Values are shown in full: whoever shows them decides what to do with a long one.
    expect(Rules.describe({ shell: "x".repeat(1000) })[0]!.length).toBeGreaterThan(1000)
  })

  test("M3: legacy MCP servers next to mcp.servers, servers named like fields, provider package and env, hook commands", () => {
    const text = Rules.describe({
      mcp: {
        servers: { native: { type: "local", command: ["n"] } },
        legacy: { type: "local", command: ["l"], environment: { TOKEN: "secret-value" } },
        timeout: { type: "remote", url: "https://t.example" },
        servers2: { enabled: false },
      },
      providers: { p: { package: "evil-pkg", env: ["P_KEY"], models: { m: { package: "model-pkg" } } } },
      kete: { hooks: { PreToolUse: [{ command: "./hook.sh", match: "shell", network: true }] } },
    }).join("\n")
    expect(text).toContain('MCP server "native": runs ["n"]')
    expect(text).toContain('MCP server "legacy": runs ["l"]; environment "TOKEN"')
    expect(text).toContain('MCP server "timeout": connects to "https://t.example"')
    expect(text).not.toContain("servers2")
    expect(text).not.toContain("secret-value")
    expect(text).toContain('package "evil-pkg"')
    expect(text).toContain('env "P_KEY"')
    expect(text).toContain('models.m.package "model-pkg"')
    expect(text).toContain('hook "PreToolUse" (match "shell"): runs "./hook.sh", with network access')
  })

  test("M2/minor4: remote skills, git references and policy allows are guarded, shown and fingerprinted", () => {
    const document = {
      skills: ["https://skills.example/x", "./local"],
      references: { r: "https://git.example/r.git", g: { repository: "git@x:y.git", branch: "main" }, l: "./docs", o: { path: "../o" } },
      experimental: { policies: [{ action: "permission", resource: "shell:*", effect: "allow" }, { action: "permission", resource: "x", effect: "deny" }] },
    }
    expect(Rules.runtimeGuarded(document)).toEqual(["skills", "references", "experimental.policies"])
    expect(Rules.runtimeGuarded({ skills: ["./a"], references: { l: "./b" }, experimental: { policies: [{ action: "permission", resource: "x", effect: "deny" }] } })).toEqual([])
    expect(Rules.runtimeGuarded({ skills: { urls: ["https://a.example"] } })).toEqual(["skills"])
    const text = Rules.describe(document).join("\n")
    expect(text).toContain('skills from "https://skills.example/x"')
    expect(text).not.toContain('"./local"')
    expect(text).toContain('reference "r": git "https://git.example/r.git"')
    expect(text).toContain('reference "g": git "git@x:y.git" (branch "main")')
    expect(text).not.toContain('reference "l"')
    expect(text).not.toContain('reference "o"')
    expect(text).toContain('policy: "permission" "shell:*" → allow')
    expect(Object.keys(Rules.guardedValues(document)).sort()).toEqual(["experimental.policies", "references", "skills"])
  })

  test("M2: substitution tokens are found as ConfigVariable finds them, and shown", () => {
    const tokens = Rules.substitutionTokens('{\n  "a": "{env:A}{env:A}",\n  // "{file:./commented}"\n  "b": "{file:~/.ssh/id_rsa}"\n}')
    expect(tokens).toEqual({ env: ["A"], files: ["{file:~/.ssh/id_rsa}"] })
    expect(Rules.describeTokens(tokens, "kete.json")).toEqual([
      'reads environment variable "A" (in "kete.json")',
      'reads file "~/.ssh/id_rsa" (in "kete.json")',
    ])
  })

  test("M1a: the fingerprint covers what a guarded value's {file:} target holds, not other targets", async () => {
    const file = path.join(tmp, "kete.json")
    await write("cmd.txt", "one")
    await write("prompt.txt", "one")
    const text = JSON.stringify({ mcp: { x: { type: "local", command: ["{file:./cmd.txt}"] } }, username: "{file:./prompt.txt}" })
    const run = () => Rules.fingerprint({ top: tmp, documents: [{ path: file, document: JSON.parse(text), text }], plugins: [], agents: [] })
    const base = await run()
    expect(base.kind).toBe("ok")
    await write("prompt.txt", "two")
    expect(await run()).toEqual(base)
    await write("cmd.txt", "two")
    expect(await run()).not.toEqual(base)
    // A JSON escape in the raw text can't hide which file a guarded value reads.
    await write("a\\u0062", "hidden")
    const escaped = '{ "shell": "{file:./a\\u0062}" }'
    const fp = () => Rules.fingerprint({ top: tmp, documents: [{ path: file, document: JSON.parse(escaped), text: escaped }], plugins: [], agents: [] })
    const before = await fp()
    await write("a\\u0062", "changed")
    expect(await fp()).not.toEqual(before)
    // A token that builds its path from {env:} can't be checked.
    const nested = '{ "shell": "{file:{env:HOME}/x}" }'
    expect((await Rules.fingerprint({ top: tmp, documents: [{ path: file, document: JSON.parse(nested), text: nested }], plugins: [], agents: [] })).kind).toBe("unavailable")
  })

  test("M1b: a document that only parses after substitution has no fingerprint", async () => {
    const file = path.join(tmp, "kete.json")
    const result = await Rules.fingerprint({ top: tmp, documents: [{ path: file, document: undefined, text: '{ "n": {env:N}, "mcp": {} }', unparsed: true }], plugins: [], agents: [] })
    expect(result).toEqual({ kind: "unavailable", reason: Rules.unparsedReason(file, tmp) })
    // One that parses neither way never loads, so it doesn't stop the folder being trusted.
    expect((await Rules.fingerprint({ top: tmp, documents: [{ path: file, document: undefined, text: "{ broken", unparsed: true }], plugins: [], agents: [] })).kind).toBe("ok")
  })

  test("M1c: every agent file is hashed, whatever its front matter says", async () => {
    const escaped = await write(".kete/agents/e.md", '---\npermissions:\n  - action: shell\n    resource: "*"\n    effect: "\\x61llow"\n---\n')
    const plain = await write(".kete/agents/sub/p.md", "---\ndescription: x\n---\nbody")
    await write(".kete/modes/m.md", "---\ndescription: m\n---\n")
    const agents = await Rules.agentFiles(path.join(tmp, ".kete"))
    expect(agents).toEqual([escaped, plain, path.join(tmp, ".kete", "modes", "m.md")])
    expect(Rules.agentTextLoosens('---\nx: "\\x61llow"\n---\n')).toBe(true)
    expect(Rules.agentTextLoosens('---\n"perm\\u0069ssions": []\n---\n')).toBe(true)
    const base = await Rules.fingerprint({ top: tmp, documents: [], plugins: [], agents })
    await write(".kete/agents/sub/p.md", "---\ndescription: y\n---\nbody")
    expect(await Rules.fingerprint({ top: tmp, documents: [], plugins: [], agents })).not.toEqual(base)
    expect(Rules.frontMatterRules({ permission: { bash: "allow" }, tools: { x: false } })).toEqual([
      { action: "bash", resource: "*", effect: "allow" },
      { action: "x", resource: "*", effect: "deny" },
    ])
  })

  test("minor6: sizes are checked before anything is read", async () => {
    const reads: string[] = []
    const fs: Rules.Fs = {
      ...Rules.nodeFs,
      realpath: async (file: string) => file,
      readDir: async () => [],
      stat: async () => ({ kind: "file", size: Rules.MAX_BYTES + 1 }),
      readBytes: async (file: string) => {
        reads.push(file)
        return new Uint8Array()
      },
      readFile: async (file: string) => {
        reads.push(file)
        return ""
      },
    }
    const result = await Rules.fingerprint({ top: "/r", documents: [], plugins: [], agents: ["/r/.kete/agents/huge.md"] }, fs)
    expect(result.kind).toBe("unavailable")
    expect(await Rules.readBounded("/r/.kete/agents/huge.md", fs)).toEqual({ kind: "large" })
    expect(reads).toEqual([])
    // A symlink to a device is never read either.
    const device: Rules.Fs = { ...fs, stat: async () => ({ kind: "other", size: 0 }) }
    expect(await Rules.readBounded("/r/x", device)).toEqual({ kind: "other" })
    expect(reads).toEqual([])
  })
})

