// Folder trust (core/src/kete/folder-trust.ts) through the real Config, ConfigPluginSource and
// ConfigAgentPlugin on temporary repositories: an untrusted folder's guarded settings and plugin code
// are held back while everything else loads (AC1), one question per folder (AC2), Trust stores the
// fingerprint and reloads (AC3), a changed guarded value asks again (AC4), a folder with nothing
// guarded never asks (AC5), the store (AC6), the extended set (formatter, shell, worktree, loosening
// permission rules, agent files) and hooks trusted with the folder (AC10).
//
// The package's test script run-trusts the suite (script/test.ts); this file builds the service
// without run trust (`configured({ env: {}, ppid: 0 })`).
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Form } from "@opencode/core/form"
import { KeteFolderTrust } from "@opencode/core/kete/folder-trust"
import { KeteFolderTrustForm } from "@opencode/core/kete/folder-trust/form"
import { KeteHooksSettings } from "@opencode/core/kete/hooks/settings"
import { Location } from "@opencode/core/location"
import { PluginSourceDirectory } from "@opencode/core/plugin/source-directory"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteFolderTrustStore } from "@opencode/util/kete/folder-trust-store"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(Layer.empty)

interface Fixture {
  readonly root: string
  readonly repo: string
  readonly global: string
  readonly state: string
  readonly home: string
}

function graph(fixture: Fixture, directory = fixture.repo) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(fixture.repo) }),
    ),
  )
  const built = AppNodeBuilder.build(
    LayerNode.group([Config.node, ConfigPluginSource.node, KeteFolderTrust.node, Form.node, Bus.node, Agent.node, FSUtil.node, Global.node]),
    [
      Location.node.replace(locationLayer),
      Global.node.replace(Global.layerWith({ config: fixture.global, home: fixture.home, state: fixture.state })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
      KeteFolderTrust.node.replace(KeteFolderTrust.configured({ env: {}, ppid: 0 })),
    ],
  )
  return Layer.mergeAll(built, Watcher.testLayer)
}

async function write(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value))
}

const MCP = ["node", "./mcp.js"]

/** The AC1 repository: local MCP, a plugin, a provider endpoint, hooks, a non-guarded key, and the
 * safe parts (AGENTS.md, an agent, a command, a skill). */
async function fixture(): Promise<Fixture & { [Symbol.asyncDispose](): Promise<void> }> {
  const tmp = await tmpdir("kete-folder-trust-")
  const root = await fs.realpath(tmp.path)
  const repo = path.join(root, "repo")
  const global = path.join(root, "global")
  const state = path.join(root, "state")
  const home = path.join(root, "home")
  await fs.mkdir(path.join(repo, ".git"), { recursive: true })
  await fs.mkdir(global, { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await write(path.join(repo, "kete.json"), {
    username: "theme-like",
    mcp: { servers: { tools: { type: "local", command: MCP } } },
    plugins: ["./plugin.ts"],
    providers: { x: { settings: { baseURL: "https://provider.example/v1" } } },
    kete: { hooks: { PreToolUse: [{ command: "echo hook" }] } },
  })
  await write(path.join(repo, ".kete", "plugins", "p.ts"), "export default {}")
  await write(path.join(repo, "AGENTS.md"), "Be careful.")
  await write(path.join(repo, ".kete", "agents", "a.md"), "---\ndescription: An agent\n---\nAgent a.")
  await write(path.join(repo, ".kete", "commands", "c.md"), "---\ndescription: A command\n---\nDo c.")
  await write(path.join(repo, ".kete", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: A skill\n---\nSkill.")
  return { root, repo, global, state, home, [Symbol.asyncDispose]: () => tmp[Symbol.asyncDispose]() }
}

const withFixture = <A, E, R>(body: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireDisposable(Effect.promise(() => fixture())).pipe(Effect.flatMap(body))

const trustForms = Effect.gen(function* () {
  const forms = yield* Form.Service
  return (yield* forms.list()).filter((form) => form.metadata?.kind === KeteFolderTrustRules.FORM_KIND)
})

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* effect
      if (done(value)) return value
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`))
  })

const entries = Effect.gen(function* () {
  return yield* (yield* Config.Service).entries()
})

const pluginTargets = Effect.gen(function* () {
  const source = yield* ConfigPluginSource.Service
  return (yield* source.operations()).flatMap((operation) => (operation.type === "add" ? [operation.target] : []))
})

const projectKeys = (all: ReadonlyArray<{ type: string; path?: string; info?: object }>, repo: string) =>
  all.flatMap((entry) =>
    entry.type === "document" && entry.path?.startsWith(repo) && entry.info ? Object.keys(entry.info).filter((key) => (entry.info as Record<string, unknown>)[key] !== undefined) : [],
  )

describe("folder trust", () => {
  it.live("untrusted: guarded settings and plugin code are held back; the safe parts load", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const all = yield* entries
        expect(Config.latest(all, "mcp")).toBeUndefined()
        expect(Config.latest(all, "providers")).toBeUndefined()
        expect(Config.latest(all, "plugins")).toBeUndefined()
        expect(Config.latest(all, "kete")).toBeUndefined()
        expect(Config.latest(all, "username")).toBe("theme-like")
        expect(projectKeys(all, fixture.repo)).toEqual(["username"])
        // The .kete directory itself still loads (agents, commands, skills come from it).
        expect(all.some((entry) => entry.type === "directory" && entry.path === path.join(fixture.repo, ".kete"))).toBe(true)
        expect((yield* pluginTargets).filter((target) => target.startsWith(fixture.repo))).toEqual([])
        const agents = yield* Agent.Service
        yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
        expect(yield* agents.get(Agent.ID.make("a"))).toMatchObject({ system: "Agent a." })
        const status = yield* (yield* KeteFolderTrust.Service).status()
        expect(status.kind).toBe("untrusted")
      }).pipe(Effect.provide(graph(fixture))),
    ),
  )

  it.live("one form lists the MCP command, the plugin file and the provider endpoint", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        expect(form!.sessionID).toBe("global")
        const description = form!.fields[0]?.description ?? ""
        expect(description).toContain(JSON.stringify(MCP))
        expect(description).toContain('plugin code in ".kete/plugins"')
        expect(description).toContain("https://provider.example/v1")
        expect(description).toContain("kete.hooks")
        // Another load of the same location (a concurrent request, a reload) doesn't ask again.
        const service = yield* KeteFolderTrust.Service
        const before = yield* entries
        yield* service.gate(before, { documents: new Set([path.join(fixture.repo, "kete.json")]), directories: new Set() }, new Map())
        yield* Effect.sleep("50 millis")
        expect(yield* trustForms).toHaveLength(1)
      }).pipe(Effect.provide(graph(fixture))),
    ),
  )

  it.live("trust reloads the location with everything, stores the fingerprint, and isn't asked again", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        const forms = yield* Form.Service
        yield* forms.reply({ id: form!.id, answer: { [KeteFolderTrustForm.FIELD]: "trust" } })
        const all = yield* until(entries, (value) => Config.latest(value, "mcp") !== undefined, "the reload")
        expect(Config.latest(all, "providers")).toBeDefined()
        expect(Config.latest(all, "kete")?.hooks).toBeDefined()
        expect(yield* pluginTargets).toContain(path.join(fixture.repo, ".kete", "plugins", "p.ts"))
        const stored = yield* Effect.promise(() => KeteFolderTrustStore.make(fixture.state).list())
        expect(Object.keys(stored)).toEqual([KeteFolderTrustRules.storeKey(fixture.repo)])
        expect(stored[KeteFolderTrustRules.storeKey(fixture.repo)]?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      }).pipe(
        Effect.provide(graph(fixture)),
        // A restart: a new location graph, same state directory.
        Effect.andThen(
          Effect.gen(function* () {
            expect(Config.latest(yield* entries, "mcp")).toBeDefined()
            yield* Effect.sleep("50 millis")
            expect(yield* trustForms).toEqual([])
            expect((yield* (yield* KeteFolderTrust.Service).status()).kind).toBe("trusted")
          }).pipe(Effect.provide(graph(fixture))),
        ),
      ),
    ),
  )

  it.live("trusting the folder trusts its project hooks too (no second question)", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        yield* (yield* Form.Service).reply({ id: form!.id, answer: { [KeteFolderTrustForm.FIELD]: "trust" } })
        const all = yield* until(entries, (value) => Config.latest(value, "kete") !== undefined, "the reload")
        const expected = yield* Effect.promise(() =>
          KeteHooksSettings.projectHooksTrust(all, { globalConfig: fixture.global, repositoryKey: fixture.repo, cwd: fixture.repo }),
        )
        if (expected.kind !== "ok") throw new Error("expected project hooks")
        const hooks = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(fixture.state, "hooks-trust.json"), "utf8")))
        expect(hooks.repositories[fixture.repo].fingerprint).toBe(expected.fingerprint)
      }).pipe(Effect.provide(graph(fixture))),
    ),
  )

  it.live("not now holds back for this process; a declined folder leaves project hooks out", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        yield* (yield* Form.Service).reply({ id: form!.id, answer: { [KeteFolderTrustForm.FIELD]: "later" } })
        yield* Effect.sleep("200 millis")
        expect(Config.latest(yield* entries, "kete")).toBeUndefined()
        expect(yield* Effect.promise(() => KeteFolderTrustStore.make(fixture.state).list())).toEqual({})
        expect(yield* Effect.promise(() => fs.stat(path.join(fixture.state, "hooks-trust.json")).then(() => true, () => false))).toBe(false)
      }).pipe(Effect.provide(graph(fixture))),
    ),
  )

  it.live("fingerprint: a changed guarded value asks again; a changed non-guarded value doesn't", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        yield* (yield* Form.Service).reply({ id: form!.id, answer: { [KeteFolderTrustForm.FIELD]: "trust" } })
        yield* until(entries, (value) => Config.latest(value, "mcp") !== undefined, "the reload")
      }).pipe(
        Effect.provide(graph(fixture)),
        Effect.andThen(
          Effect.promise(async () => {
            const file = path.join(fixture.repo, "kete.json")
            const config = JSON.parse(await fs.readFile(file, "utf8"))
            await fs.writeFile(file, JSON.stringify({ ...config, username: "changed" }))
          }),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            expect(Config.latest(yield* entries, "mcp")).toBeDefined()
            expect(Config.latest(yield* entries, "username")).toBe("changed")
            yield* Effect.sleep("50 millis")
            expect(yield* trustForms).toEqual([])
          }).pipe(Effect.provide(graph(fixture))),
        ),
        Effect.andThen(
          Effect.promise(async () => {
            const file = path.join(fixture.repo, "kete.json")
            const config = JSON.parse(await fs.readFile(file, "utf8"))
            await fs.writeFile(file, JSON.stringify({ ...config, mcp: { servers: { tools: { type: "local", command: ["node", "./other.js"] } } } }))
          }),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            expect(Config.latest(yield* entries, "mcp")).toBeUndefined()
            yield* until(trustForms, (forms) => forms.length === 1, "a new trust form")
          }).pipe(Effect.provide(graph(fixture))),
        ),
      ),
    ),
  )

  it.live("nothing guarded never asks", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        expect(Config.latest(yield* entries, "username")).toBe("plain")
        yield* Effect.sleep("50 millis")
        expect(yield* trustForms).toEqual([])
        expect((yield* (yield* KeteFolderTrust.Service).status()).kind).toBe("clear")
      }).pipe(
        Effect.provide(graph(fixture)),
        Effect.provide(Layer.empty),
        (effect) =>
          Effect.promise(async () => {
            await fs.rm(path.join(fixture.repo, ".kete", "plugins"), { recursive: true })
            await write(path.join(fixture.repo, "kete.json"), { username: "plain", formatter: false, share: "disabled" })
          }).pipe(Effect.andThen(effect)),
      ),
    ),
  )

  it.live("extended set: formatter, shell, worktree, loosening permission rules and agent files", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const all = yield* entries
        expect(Config.latest(all, "formatter")).toBeUndefined()
        expect(Config.latest(all, "shell")).toBeUndefined()
        expect(Config.latest(all, "worktree")).toBeUndefined()
        const permissions = all.flatMap((entry) => (entry.type === "document" ? (entry.info.permissions ?? []) : []))
        expect(permissions).toContainEqual({ action: "shell", resource: "rm *", effect: "deny" })
        expect(permissions).toContainEqual({ action: "webfetch", resource: "*", effect: "ask" })
        expect(permissions).not.toContainEqual({ action: "shell", resource: "*", effect: "allow" })
        expect(permissions).not.toContainEqual({ action: "edit", resource: "*", effect: "ask" })
        expect(all.flatMap((entry) => (entry.type === "document" ? Object.keys(entry.info.agents ?? {}) : []))).toContain("plan")
        const agents = yield* Agent.Service
        yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
        const b = yield* agents.get(Agent.ID.make("b"))
        expect(b).toBeDefined()
        expect(b!.permissions).not.toContainEqual({ action: "shell", resource: "*", effect: "allow" })
        expect(b!.permissions).toContainEqual({ action: "read", resource: "*.secret", effect: "deny" })
        const plan = yield* agents.get(Agent.ID.make("plan"))
        expect(plan?.permissions ?? []).not.toContainEqual({ action: "edit", resource: "*", effect: "allow" })
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        const description = form!.fields[0]?.description ?? ""
        expect(description).toContain('formatter "fmt": runs ["./fmt"]')
        expect(description).toContain("shell:")
        expect(description).toContain("worktree directory:")
        expect(description).toContain('"shell" "*" → allow')
        expect(description).toContain('"edit" "*" → ask')
        expect(description).toContain('permission rules in agent file ".kete/agents/b.md"')
      }).pipe(
        Effect.provide(graph(fixture)),
        (effect) =>
          Effect.promise(async () => {
            await fs.rm(path.join(fixture.repo, ".kete", "plugins"), { recursive: true })
            await write(path.join(fixture.global, "kete.json"), { permissions: [{ action: "edit", resource: "secret/*", effect: "deny" }] })
            await write(path.join(fixture.repo, "kete.json"), {
              formatter: { fmt: { command: ["./fmt"], extensions: [".x"] } },
              shell: "/bin/sh",
              worktree: { directory: "~/trees" },
              permissions: [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "edit", resource: "*", effect: "ask" },
                { action: "webfetch", resource: "*", effect: "ask" },
                { action: "shell", resource: "rm *", effect: "deny" },
              ],
              agents: { plan: { permissions: [{ action: "edit", resource: "*", effect: "allow" }] } },
            })
            await write(
              path.join(fixture.repo, ".kete", "agents", "b.md"),
              '---\ndescription: Agent b\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n  - action: read\n    resource: "*.secret"\n    effect: deny\n---\nAgent b.',
            )
          }).pipe(Effect.andThen(effect)),
      ),
    ),
  )

  it.live("extended set: formatter false loads and never asks", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        expect(Config.latest(yield* entries, "formatter")).toBe(false)
        yield* Effect.sleep("50 millis")
        expect(yield* trustForms).toEqual([])
      }).pipe(
        Effect.provide(graph(fixture)),
        (effect) =>
          Effect.promise(async () => {
            await fs.rm(path.join(fixture.repo, ".kete", "plugins"), { recursive: true })
            await write(path.join(fixture.repo, "kete.json"), { formatter: false })
          }).pipe(Effect.andThen(effect)),
      ),
    ),
  )

  it.live("store: a malformed or unreadable store trusts nothing", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        expect(Config.latest(yield* entries, "mcp")).toBeUndefined()
        yield* until(trustForms, (forms) => forms.length === 1, "the trust form")
      }).pipe(
        Effect.provide(graph(fixture)),
        (effect) =>
          Effect.promise(async () => {
            await fs.mkdir(fixture.state, { recursive: true })
            await fs.writeFile(path.join(fixture.state, KeteFolderTrustStore.FILE), "{ not json")
          }).pipe(Effect.andThen(effect)),
      ),
    ),
  )

  it.live("store: the home directory is offered Not now only", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
        const field = form!.fields[0]
        expect(field?.type === "string" ? field.options?.map((option) => option.value) : undefined).toEqual(["later"])
        expect(field?.description).toContain("home directory")
      }).pipe(
        Effect.provide(
          graph({ ...fixture, repo: fixture.home, home: fixture.home }, fixture.home),
        ),
        (effect) => Effect.promise(() => write(path.join(fixture.home, "kete.json"), { shell: "/bin/sh" })).pipe(Effect.andThen(effect)),
      ),
    ),
  )

  it.live("plugin directory names match the runtime's", () =>
    Effect.sync(() => expect([...KeteFolderTrustRules.PLUGIN_DIRECTORIES]).toEqual([...PluginSourceDirectory.names])),
  )
})
