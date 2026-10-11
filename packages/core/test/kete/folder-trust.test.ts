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
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import { Document, Info } from "@opencode/schema/config"
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
import { KeteFolderTrustRpcPlugin } from "@opencode/core/kete/folder-trust/rpc"
import { KeteOffline } from "@opencode/core/kete/offline"
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

function graph(fixture: Fixture, directory = fixture.repo, trust = KeteFolderTrust.configured({ env: {}, ppid: 0 })) {
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
      KeteFolderTrust.node.replace(trust),
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
        expect(description).toContain(`hook "PreToolUse": runs "echo hook"`)
        // Another load of the same location (a concurrent request, a reload) doesn't ask again.
        const service = yield* KeteFolderTrust.Service
        const file = path.join(fixture.repo, "kete.json")
        const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        const raw = new Document({ type: "document", path: AbsolutePath.make(file), info: Schema.decodeUnknownSync(Info)(JSON.parse(text)) })
        yield* service.gate(() => Effect.succeed([raw]), { documents: new Set([file]), directories: new Set([path.join(fixture.repo, ".kete")]) }, new Map([[file, text]]))
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
        expect(description).toContain('permission (agent file ".kete/agents/b.md"): "shell" "*" → allow')
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

  // ---------------------------------------------------------------------------------------------
  // Security review fixes (2026-10-11): one regression test per finding.

  const setup = <A, E, R>(prepare: (fixture: Fixture) => Promise<void>, body: (fixture: Fixture) => Effect.Effect<A, E, R>, trust?: Parameters<typeof graph>[2]) =>
    withFixture((fixture) =>
      Effect.promise(() => prepare(fixture)).pipe(
        Effect.andThen(body(fixture).pipe(Effect.provide(graph(fixture, fixture.repo, trust)))),
      ),
    )
  const formText = Effect.gen(function* () {
    const [form] = yield* until(trustForms, (forms) => forms.length > 0, "the trust form")
    const field = form!.fields[0]
    return {
      form: form!,
      description: field?.description ?? "",
      options: field?.type === "string" ? (field.options ?? []).map((option) => option.value) : [],
    }
  })
  const answer = (form: Effect.Success<typeof formText>["form"], value: "trust" | "later") =>
    Effect.gen(function* () {
      yield* (yield* Form.Service).reply({ id: form.id, answer: { [KeteFolderTrustForm.FIELD]: value } })
    })
  const withoutFolderTrust = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.updateContext((context: Context.Context<R>) => Context.omit(KeteFolderTrust.Service)(context) as Context.Context<R>))
  const clean = async (fixture: Fixture) => {
    await fs.rm(path.join(fixture.repo, ".kete", "plugins"), { recursive: true })
  }

  it.live("M2: untrusted, {env:}/{file:} stay literal and remote skills and git references are held back; trust substitutes", () => {
    const variable = "KETE_FOLDER_TRUST_TEST_SECRET"
    return setup(
      async (fixture) => {
        process.env[variable] = "s3cret-value"
        await clean(fixture)
        await write(path.join(fixture.repo, "agent.txt"), "from-a-file")
        await write(path.join(fixture.repo, "kete.json"), {
          username: `{env:${variable}}`,
          default_agent: "{file:./agent.txt}",
          skills: ["https://skills.example/pack", "./local-skills"],
          references: { remote: "https://git.example/r.git", docs: "./docs" },
        })
      },
      (fixture) =>
        Effect.gen(function* () {
          const all = yield* entries
          expect(Config.latest(all, "username")).toBe(`{env:${variable}}`)
          expect(Config.latest(all, "default_agent")).toBe("{file:./agent.txt}")
          expect(Config.latest(all, "skills")).toEqual(["./local-skills"])
          expect(Object.keys(Config.latest(all, "references") ?? {})).toEqual(["docs"])
          const { form, description } = yield* formText
          expect(description).toContain(`reads environment variable "${variable}"`)
          expect(description).toContain('reads file "./agent.txt"')
          expect(description).toContain('skills from "https://skills.example/pack"')
          expect(description).toContain('reference "remote": git "https://git.example/r.git"')
          expect(description).not.toContain("s3cret-value")
          yield* answer(form, "trust")
          const trusted = yield* until(entries, (value) => Config.latest(value, "username") === "s3cret-value", "the reload")
          expect(Config.latest(trusted, "default_agent")).toBe("from-a-file")
          expect(Config.latest(trusted, "skills")).toEqual(["https://skills.example/pack", "./local-skills"])
          expect(Object.keys(Config.latest(trusted, "references") ?? {}).sort()).toEqual(["docs", "remote"])
        }).pipe(Effect.ensuring(Effect.sync(() => delete process.env[variable]))),
    )
  })

  it.live("M1a: the fingerprint covers what a guarded value's {file:} target holds", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const { form } = yield* formText
        yield* answer(form, "trust")
        yield* until(entries, (value) => Config.latest(value, "shell") === "/bin/from-file", "the reload")
      }).pipe(
        Effect.provide(graph(fixture)),
        (effect) =>
          Effect.promise(async () => {
            await clean(fixture)
            await write(path.join(fixture.repo, "shell.txt"), "/bin/from-file")
            await write(path.join(fixture.repo, "kete.json"), { shell: "{file:./shell.txt}" })
          }).pipe(Effect.andThen(effect)),
        Effect.andThen(Effect.promise(() => write(path.join(fixture.repo, "shell.txt"), "/bin/other"))),
        Effect.andThen(
          Effect.gen(function* () {
            expect(Config.latest(yield* entries, "shell")).toBeUndefined()
            yield* until(trustForms, (forms) => forms.length === 1, "a new trust form")
          }).pipe(Effect.provide(graph(fixture))),
        ),
      ),
    ),
  )

  it.live("M1b: a document that only parses after substitution can't be trusted, and the question says why", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(path.join(fixture.repo, "kete.json"), '{ "shell": "/bin/sh", "count": {env:KETE_FOLDER_TRUST_TEST_NUMBER} }')
      },
      () =>
        Effect.gen(function* () {
          expect(Config.latest(yield* entries, "shell")).toBeUndefined()
          const { description, options } = yield* formText
          expect(options).toEqual(["later"])
          expect(description).toContain("can't be read before {env:…}/{file:…} substitution")
          const status = yield* (yield* KeteFolderTrust.Service).status()
          expect(status.kind === "untrusted" ? status.refusal : undefined).toContain("substitution")
        }),
    ),
  )

  it.live("M1c: an agent file's rules are decided on the decoded YAML (an escaped allow is held back)", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(
          path.join(fixture.repo, ".kete", "agents", "e.md"),
          '---\ndescription: Agent e\npermissions:\n  - action: shell\n    resource: "*"\n    effect: "\\x61llow"\n---\nAgent e.',
        )
      },
      () =>
        Effect.gen(function* () {
          const { description } = yield* formText
          expect(description).toContain('permission (agent file ".kete/agents/e.md"): "shell" "*" → allow')
          const agents = yield* Agent.Service
          yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
          expect((yield* agents.get(Agent.ID.make("e")))?.permissions ?? []).not.toContainEqual({ action: "shell", resource: "*", effect: "allow" })
        }),
    ),
  )

  it.live("M3: the question lists legacy MCP servers next to mcp.servers, a server named timeout, provider package and env", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(path.join(fixture.repo, "kete.json"), {
          mcp: {
            servers: { native: { type: "local", command: ["native-server"] } },
            legacy: { type: "local", command: ["legacy-server"] },
            timeout: { type: "remote", url: "https://timeout.example/mcp" },
          },
          providers: { p: { package: "evil-provider-package", env: ["P_API_KEY"], settings: { baseURL: "https://p.example" } } },
        })
      },
      () =>
        Effect.gen(function* () {
          expect(Config.latest(yield* entries, "mcp")).toBeUndefined()
          const { description } = yield* formText
          expect(description).toContain('MCP server "native": runs ["native-server"]')
          expect(description).toContain('MCP server "legacy": runs ["legacy-server"]')
          expect(description).toContain('MCP server "timeout": connects to "https://timeout.example/mcp"')
          expect(description).toContain('package "evil-provider-package"')
          expect(description).toContain('env "P_API_KEY"')
        }),
    ),
  )

  it.live("M4: a project kete object can't mask the machine-level offline or platform settings", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(path.join(fixture.global, "kete.json"), { kete: { offline: true, platform: { url: "https://platform.example" } } })
        await write(path.join(fixture.repo, "kete.json"), { kete: { offline: false, budget: { session: 5 } } })
      },
      () =>
        Effect.gen(function* () {
          const kete = Config.latest(yield* entries, "kete")
          expect(kete?.budget?.session).toBe(5)
          expect(kete?.offline).toBe(true)
          expect(kete?.platform?.url).toBe("https://platform.example")
          expect(KeteOffline.enabled({}, kete)).toBe(true)
        }),
    ),
  )

  it.live("minor2: job mode trusts only when no project config loaded", () =>
    setup(
      async () => {},
      () =>
        Effect.gen(function* () {
          expect(Config.latest(yield* entries, "mcp")).toBeUndefined()
          expect((yield* (yield* KeteFolderTrust.Service).status()).kind).toBe("untrusted")
        }),
      KeteFolderTrust.configured({ env: { OPENCODE_JOB_MODE: "1" }, ppid: 0 }),
    ),
  )

  it.live("minor3: without the folder-trust service, project agent files still lose their allow rules", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(path.join(fixture.repo, "kete.json"), { username: "plain" })
        const rules = '---\ndescription: X\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n  - action: read\n    resource: "*.secret"\n    effect: deny\n---\nX.'
        await write(path.join(fixture.repo, ".kete", "agents", "p.md"), rules)
        await write(path.join(fixture.global, "agents", "g.md"), rules)
      },
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* withoutFolderTrust(ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })))
          const project = yield* agents.get(Agent.ID.make("p"))
          expect(project!.permissions).not.toContainEqual({ action: "shell", resource: "*", effect: "allow" })
          expect(project!.permissions).toContainEqual({ action: "read", resource: "*.secret", effect: "deny" })
          expect((yield* agents.get(Agent.ID.make("g")))!.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" })
        }),
    ),
  )

  it.live("minor4: a project policy allow is held back; its deny applies", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(path.join(fixture.repo, "kete.json"), {
          experimental: {
            policies: [
              { action: "permission", resource: "shell:*", effect: "allow" },
              { action: "permission", resource: "edit:*", effect: "deny" },
            ],
          },
        })
      },
      () =>
        Effect.gen(function* () {
          expect(Config.latest(yield* entries, "experimental")?.policies).toEqual([{ action: "permission", resource: "edit:*", effect: "deny" }])
          expect((yield* formText).description).toContain('policy: "permission" "shell:*" → allow')
        }),
    ),
  )

  it.live("minor5: deny rules in global agent files count as machine-level denies", () =>
    setup(
      async (fixture) => {
        await clean(fixture)
        await write(path.join(fixture.global, "agents", "g.md"), '---\ndescription: G\npermissions:\n  - action: edit\n    resource: "secret/*"\n    effect: deny\n---\nG.')
        await write(path.join(fixture.repo, "kete.json"), { permissions: [{ action: "edit", resource: "*", effect: "ask" }, { action: "webfetch", resource: "*", effect: "ask" }] })
      },
      (fixture) =>
        Effect.gen(function* () {
          const project = (yield* entries).flatMap((entry) =>
            entry.type === "document" && entry.path?.startsWith(fixture.repo) ? (entry.info.permissions ?? []) : [],
          )
          expect(project).toEqual([{ action: "webfetch", resource: "*", effect: "ask" }])
          expect((yield* formText).description).toContain('"edit" "*" → ask')
        }),
    ),
  )

  it.live("minor1: the question escapes control and format characters, and an item cut short can't be trusted", () =>
    Effect.sync(() => {
      const sneaky = 'MCP server "x": runs ["a\u202Eb\u200Bc\u009B31m"]'
      const text = KeteFolderTrustForm.description({ root: "/r\u2066oot", items: [sneaky] })
      expect(text).not.toMatch(/[\u202E\u200B\u009B\u2066]/)
      expect(text).toContain("\\u{202E}")
      expect(text).toContain("\\u{9B}")
      const options = (input: KeteFolderTrustForm.Input) => {
        const field = KeteFolderTrustForm.create(input).fields[0]
        return field?.type === "string" ? field.options?.map((option) => option.value) : undefined
      }
      expect(options({ root: "/r", items: [sneaky] })).toEqual(["trust", "later"])
      expect(options({ root: "/r", items: ["x".repeat(KeteFolderTrustForm.MAX_ITEM + 1)] })).toEqual(["later"])
      expect(options({ root: "/r", items: Array.from({ length: KeteFolderTrustForm.MAX_ITEMS + 1 }, (_, i) => `item ${i}`) })).toEqual(["later"])
      expect(KeteFolderTrustForm.trustable({ root: "/r", items: ["x".repeat(KeteFolderTrustForm.MAX_ITEM + 1)] })).toBe(false)
    }),
  )

  it.live("C2: the kete.folder.trust RPC says trusted only once the folder is trusted, and announces it", () =>
    setup(
      async () => {},
      () =>
        Effect.gen(function* () {
          let handlers: Record<string, (input: unknown) => Effect.Effect<{ trusted: boolean }>> = {}
          const emitted: unknown[] = []
          const events = yield* Queue.unbounded<{ type: string; data: unknown }>()
          yield* KeteFolderTrustRpcPlugin.Plugin.effect(
            host({
              rpc: Object.assign(() => Effect.die("unused"), {
                register: (_definition: unknown, given: typeof handlers) =>
                  Effect.sync(() => {
                    handlers = given
                    return { dispose: Effect.void, events: { emit: (_name: string, data: unknown) => Effect.sync(() => void emitted.push(data)) } }
                  }),
              }) as never,
              event: { subscribe: () => Stream.fromQueue(events) as never },
            }),
          )
          expect(yield* handlers.status!({})).toEqual({ trusted: false })
          const { form } = yield* formText
          yield* answer(form, "trust")
          yield* until(entries, (value) => Config.latest(value, "mcp") !== undefined, "the reload")
          expect(yield* handlers.status!({})).toEqual({ trusted: true })
          yield* Queue.offer(events, { type: "config.updated", data: {} })
          yield* until(Effect.sync(() => emitted), (value) => value.length > 0, "the changed event")
          expect(emitted).toContainEqual({ trusted: true })
        }).pipe(Effect.scoped),
    ),
  )
})
