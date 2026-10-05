// AC5: offline mode (--offline / KETE_OFFLINE / kete.offline). The plugin removes non-local models,
// disables remote MCP servers and takes the web tools away (and refuses them if called anyway); the
// runner check refuses a non-local model; the "model unavailable" error explains.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteOffline } from "@opencode/core/kete/offline"
import { KeteRunChecks } from "@opencode/core/kete/run-checks"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import type { ModelResolver } from "@opencode/core/model-resolver"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import type { Plugin } from "@opencode/plugin/effect"
import { Document, type Entry, Info } from "@opencode/schema/config"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"
import { registries } from "./sync-fixture"

type ModelEditor = Parameters<Parameters<Plugin.Context["model"]["transform"]>[0]>[0]
type ModelRecord = { providerID: string; id: string; settings?: Record<string, unknown> }
type Callback = (event: never) => Effect.Effect<void, unknown>

const decodeInfo = Schema.decodeUnknownSync(Info)
const offlineConfig = (): Entry => new Document({ type: "document", info: decodeInfo({ kete: { offline: true } }) })

function modelRegistry(initial: ModelRecord[], providerSettings: Record<string, Record<string, unknown>>) {
  const key = (providerID: string, id: string) => `${providerID}/${id}`
  const models = new Map<string, ModelRecord>()
  const transforms: Array<(editor: ModelEditor) => void> = []
  const editor = {
    list: (providerID?: string) => [...models.values()].filter((model) => providerID === undefined || model.providerID === providerID),
    get: (providerID: string, id: string) => models.get(key(providerID, id)),
    update: () => {},
    remove: (providerID: string, id: string) => void models.delete(key(providerID, id)),
    default: { get: () => undefined, set: () => {} },
    provider: {
      list: () => [],
      get: (providerID: string) =>
        providerSettings[providerID] ? { provider: { settings: providerSettings[providerID] }, models: new Map() } : undefined,
    },
  } as unknown as ModelEditor
  const rebuild = () => {
    models.clear()
    for (const model of initial) models.set(key(model.providerID, model.id), { ...model })
    for (const transform of transforms) transform(editor)
  }
  return {
    models,
    host: {
      list: () => Effect.die("unused model.list"),
      default: () => Effect.die("unused model.default"),
      transform: (callback: (editor: ModelEditor) => void) =>
        Effect.sync(() => {
          transforms.push(callback)
          rebuild()
          return { dispose: Effect.void }
        }),
      reload: () => Effect.sync(rebuild),
    } as unknown as Plugin.Context["model"],
  }
}

function hookRegistry() {
  const session = new Map<string, Callback[]>()
  const tool = new Map<string, Callback[]>()
  const register = (into: Map<string, Callback[]>) =>
    ((name: string, callback: Callback) =>
      Effect.sync(() => {
        into.set(name, [...(into.get(name) ?? []), callback])
        return { dispose: Effect.void }
      })) as unknown
  return {
    session: { hook: register(session) as Plugin.Context["session"]["hook"] },
    tool: {
      transform: () => Effect.die("unused tool.transform"),
      reload: () => Effect.die("unused tool.reload"),
      list: () => Effect.die("unused tool.list"),
      hook: register(tool) as Plugin.Context["tool"]["hook"],
    } as Plugin.Context["tool"],
    runSession: (name: string, event: unknown) =>
      Effect.forEach(session.get(name) ?? [], (callback) => (callback as (event: unknown) => Effect.Effect<void, unknown>)(event), { discard: true }),
    runTool: (name: string, event: unknown) =>
      Effect.forEach(tool.get(name) ?? [], (callback) => (callback as (event: unknown) => Effect.Effect<void, unknown>)(event), { discard: true }),
    sessionNames: () => [...session.keys()],
  }
}

const initialModels: ModelRecord[] = [
  { providerID: "ollama", id: "llama3" },
  { providerID: "lmstudio", id: "qwen" },
  { providerID: "vllm", id: "mistral" },
  { providerID: "lan", id: "gpu-model" },
  { providerID: "cloud", id: "gpt" },
  { providerID: "anthropic", id: "sonnet" },
  { providerID: "kete", id: "sonnet", settings: { baseURL: "https://gateway.example/anthropic/v1" } },
  { providerID: "lan", id: "rerouted", settings: { baseURL: "https://elsewhere.example/v1" } },
]
const providerSettings = {
  lan: { baseURL: "http://192.168.1.5:8000/v1" },
  cloud: { baseURL: "https://api.example.com/v1" },
  kete: { apiKey: "secret" },
}

const setup = () => {
  const mcp = registries({
    servers: {
      remote: { type: "remote", url: "https://mcp.example.com" } as never,
      synced: { type: "remote", url: "https://synced.example.com" } as never,
      stdio: { type: "local", command: ["server"] } as never,
    },
  })
  const models = modelRegistry(initialModels, providerSettings)
  const hooks = hookRegistry()
  Effect.runSync(mcp.host.mcp.reload())
  Effect.runSync(models.host.reload())
  return {
    mcp,
    models,
    hooks,
    ctx: host({ mcp: mcp.host.mcp, model: models.host, session: hooks.session, tool: hooks.tool }),
  }
}

const start = (entries: Entry[] = []) => {
  const world = setup()
  return Effect.runPromise(
    Effect.scoped(KeteOffline.Plugin.effect(world.ctx).pipe(Effect.provide(Config.testLayer(entries)))),
  ).then(() => world)
}

const previous = process.env.OPENCODE_OFFLINE
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_OFFLINE
  else process.env.OPENCODE_OFFLINE = previous
})

const toolsEvent = () => ({
  tools: {
    read: { description: "read", input: {} },
    webfetch: { description: "fetch", input: {} },
    websearch: { description: "search", input: {} },
    shell: { description: "shell", input: {} },
  },
})

describe("KeteOffline.Plugin", () => {
  test("offline: only local models stay (local providers, private-network base URLs)", async () => {
    process.env.OPENCODE_OFFLINE = "1"
    const { models } = await start()
    expect([...models.models.keys()].sort()).toEqual(["lan/gpu-model", "lmstudio/qwen", "ollama/llama3", "vllm/mistral"])
  })

  test("offline: remote MCP servers (synced ones too) are disabled, stdio servers are left alone", async () => {
    process.env.OPENCODE_OFFLINE = "1"
    const { mcp } = await start()
    expect(mcp.servers.get("remote")).toMatchObject({ disabled: true })
    expect(mcp.servers.get("synced")).toMatchObject({ disabled: true })
    expect(mcp.servers.get("stdio")?.disabled).not.toBe(true)
  })

  test("offline: webfetch and websearch leave every request's tools", async () => {
    process.env.OPENCODE_OFFLINE = "1"
    const { hooks } = await start()
    expect(hooks.sessionNames().sort()).toEqual(["compaction", "context", "generate"])
    for (const name of ["context", "compaction", "generate"]) {
      const event = toolsEvent()
      await Effect.runPromise(hooks.runSession(name, event))
      expect(Object.keys(event.tools).sort()).toEqual(["read", "shell"])
    }
  })

  test("offline: a call to webfetch or websearch is refused with an explanation, other tools aren't", async () => {
    process.env.OPENCODE_OFFLINE = "1"
    const { hooks } = await start()
    for (const tool of ["webfetch", "websearch"]) {
      const failure = await Effect.runPromise(hooks.runTool("execute.before", { tool, input: {} }).pipe(Effect.flip))
      expect(failure).toMatchObject({ message: KeteOffline.webRefusal })
      expect(KeteOffline.webRefusal).toContain("Offline mode")
    }
    await Effect.runPromise(hooks.runTool("execute.before", { tool: "read", input: {} }))
  })

  test("not offline: nothing changes", async () => {
    delete process.env.OPENCODE_OFFLINE
    const { models, mcp, hooks } = await start()
    expect(models.models.size).toBe(initialModels.length)
    expect(mcp.servers.get("remote")?.disabled).not.toBe(true)
    const event = toolsEvent()
    await Effect.runPromise(hooks.runSession("context", event))
    expect(Object.keys(event.tools)).toHaveLength(4)
    await Effect.runPromise(hooks.runTool("execute.before", { tool: "webfetch", input: {} }))
  })

  test("kete.offline in config turns it on without the flag", async () => {
    delete process.env.OPENCODE_OFFLINE
    const { models, mcp } = await start([offlineConfig()])
    expect([...models.models.keys()].sort()).toEqual(["lan/gpu-model", "lmstudio/qwen", "ollama/llama3", "vllm/mistral"])
    expect(mcp.servers.get("remote")).toMatchObject({ disabled: true })
  })

  test("an invalid KETE_OFFLINE value fails closed like \"1\"", async () => {
    process.env.OPENCODE_OFFLINE = "maybe"
    const { models } = await start()
    expect(models.models.has("cloud/gpt")).toBe(false)
    expect(models.models.has("ollama/llama3")).toBe(true)
  })
})

describe("KeteOffline helpers", () => {
  test("enabled reads the flag and the config", () => {
    expect(KeteOffline.enabled({})).toBe(false)
    expect(KeteOffline.enabled({ OPENCODE_OFFLINE: "1" })).toBe(true)
    expect(KeteOffline.enabled({}, { offline: true })).toBe(true)
    expect(KeteOffline.enabled({}, { offline: false })).toBe(false)
    expect(KeteOffline.enabled({ OPENCODE_OFFLINE: "nope" }, {})).toBe(true)
  })

  test("isLocalModel: the address decides; local server providers count only without a known address", () => {
    // An Ollama on a public host would send code over the internet: not local in offline mode.
    expect(KeteOffline.isLocalModel("ollama", "https://203.0.113.9/v1")).toBe(false)
    expect(KeteOffline.isLocalModel("ollama", "http://192.168.1.20:11434/v1")).toBe(true)
    expect(KeteOffline.isLocalModel("ollama", undefined)).toBe(true)
    expect(KeteOffline.isLocalModel("vllm", "")).toBe(true)
    expect(KeteOffline.isLocalModel("cloud", undefined)).toBe(false)
    expect(KeteOffline.isLocalModel("custom", "http://127.0.0.1:8080/v1")).toBe(true)
    expect(KeteOffline.isLocalModel("custom", "http://10.1.2.3/v1")).toBe(true)
    expect(KeteOffline.isLocalModel("custom", "https://api.openai.com/v1")).toBe(false)
    expect(KeteOffline.isLocalModel("custom", "http://gpu.lan/v1")).toBe(false)
    expect(KeteOffline.isLocalModel("anthropic", undefined)).toBe(false)
    expect(KeteOffline.isLocalModel("custom", "${BASE_URL}/v1")).toBe(false)
  })

  test("the model-unavailable error says why when offline", () => {
    const error = new SessionRunnerModel.ModelUnavailableError({
      providerID: Provider.ID.make("openai"),
      modelID: Model.ID.make("gpt"),
    })
    delete process.env.OPENCODE_OFFLINE
    expect(error.message).toBe("Model unavailable: openai/gpt")
    process.env.OPENCODE_OFFLINE = "1"
    expect(error.message).toContain("Model unavailable: openai/gpt")
    expect(error.message).toContain("Offline mode is on")
  })
})

// The runner check refuses a step whose model isn't local, before anything else (kete/run-checks.ts).
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const itRunChecks = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
      Global.node,
      Config.node,
    ]),
    [Location.node.replace(current), Config.node.replace(Config.testLayer([]))],
  ),
)

describe("KeteRunChecks: offline", () => {
  const resolved = (providerID: string, baseURL: string | undefined) =>
    ({
      ref: { providerID: Provider.ID.make(providerID), id: Model.ID.make("m") },
      model: { route: { endpoint: { baseURL } } },
    }) as unknown as Pick<ModelResolver.Resolved, "ref" | "model">

  const session = Session.ID.make("ses_offline")
  const insert = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: session, project_id: Project.ID.global, slug: session, directory: "/project", title: session, version: "test", agent: "rootAgent", metadata: {} })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

  itRunChecks.effect("offline: a cloud model fails the step with a clear error, a local one passes", () =>
    Effect.gen(function* () {
      yield* insert
      process.env.OPENCODE_OFFLINE = "1"
      const checker = yield* KeteRunChecks.make
      const input = { sessionID: session, agent: Agent.ID.make("rootAgent"), cost: 0 }
      const failure = yield* checker({ ...input, model: resolved("openai", "https://api.openai.com/v1") }).pipe(Effect.flip)
      expect(failure.error.type).toBe("offline")
      expect(failure.error.message).toBe(KeteOffline.refusal("openai", "m"))
      expect(failure.error.message).toContain("isn't a local model")
      yield* checker({ ...input, model: resolved("ollama", "http://127.0.0.1:11434/v1") })
      yield* checker({ ...input, model: resolved("custom", "http://192.168.1.5:8000/v1") })
    }),
  )

  itRunChecks.effect("not offline: a cloud model passes the check", () =>
    Effect.gen(function* () {
      yield* insert
      delete process.env.OPENCODE_OFFLINE
      const checker = yield* KeteRunChecks.make
      yield* checker({
        sessionID: session,
        agent: Agent.ID.make("rootAgent"),
        cost: 0,
        model: resolved("openai", "https://api.openai.com/v1"),
      })
    }),
  )
})
