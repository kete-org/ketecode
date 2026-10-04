// AC1, AC2, AC6, AC7: the kete.local-models plugin: status of the local servers, the insecure-host
// warning, models without tools, the Ollama context warning, and rediscovery.
import { Config } from "@opencode/core/config"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { KeteLocalModels } from "@opencode/core/kete/local-models"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make as makeOllama } from "@opencode/core/plugin/provider/ollama"
import { Provider } from "@opencode/core/provider"
import { Rpc } from "@opencode/core/rpc"
import type { Plugin as PluginApi } from "@opencode/plugin/effect"
import { Document, type Entry, Info } from "@opencode/schema/config"
import type { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)

const document = (value: unknown): Entry => new Document({ type: "document", info: decode(value) })
/** Answers every request with 503: for tests that must not reach a real host. */
const unavailable = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }))),
)

const settings = (provider: string, value: Record<string, string>): Entry =>
  document({ providers: { [provider]: { settings: value } } })

const details = { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_K_M" }
const summary = (model: string) => ({
  name: model,
  model,
  modified_at: "2026-01-01T00:00:00Z",
  size: 1,
  digest: `${model}-digest`,
  details,
})

type Fake = { readonly url: string; readonly requests: Array<{ path: string; authorization: string | null }>; stop: () => void }

/** A fake Ollama with three completion models (and one embedding model) of different context windows. */
function fakeOllama(models: () => string[] = () => ["big", "small-ctx", "fits", "embed"]): Fake {
  const requests: Fake["requests"] = []
  const shows: Record<string, unknown> = {
    big: { capabilities: ["completion", "tools"], details, model_info: { "llama.context_length": 131_072 } },
    "small-ctx": {
      capabilities: ["completion"],
      details,
      parameters: "num_ctx 4096\ntemperature 0.7",
      model_info: { "llama.context_length": 32_768 },
    },
    fits: { capabilities: ["completion", "tools"], details, model_info: { "llama.context_length": 4096 } },
    embed: { capabilities: ["embedding"], details, model_info: { "bert.context_length": 512 } },
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push({ path, authorization: request.headers.get("authorization") })
      if (path === "/api/tags") return Response.json({ models: models().map(summary) })
      if (path === "/api/ps") return Response.json({ models: [] })
      if (path === "/api/show") {
        const body: unknown = await request.json()
        const name = typeof body === "object" && body !== null && "model" in body ? String(body.model) : ""
        return shows[name] ? Response.json(shows[name]) : new Response("not found", { status: 404 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => void server.stop(true) }
}

/** A port nothing listens on. */
function closedPort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = server.port
  void server.stop(true)
  return port
}

type Handlers = {
  status: (input: Record<string, never>, context: never) => Effect.Effect<KeteLocalModelsRpc.Status>
  rediscover: (input: { provider?: KeteLocalModelsRpc.ProviderID }, context: never) => Effect.Effect<void>
}

/** Runs the plugin on a stub host that records its RPC handlers, emitted events and hooks. */
const startMock = (
  options: Parameters<typeof KeteLocalModels.make>[0] = {},
  models: Array<{ providerID: string; id: string; tools: boolean }> = [],
) =>
  Effect.gen(function* () {
    const captured: { handlers?: Handlers } = {}
    const emitted: Array<{ name: string; data: unknown }> = []
    const hooks = new Map<string, Array<(event: never) => Effect.Effect<void>>>()
    const transforms: Array<(editor: never) => void> = []
    const ctx = host({
      rpc: Object.assign(
        () => {
          throw new Error("unused rpc.client")
        },
        {
          register: (_definition: unknown, handlers: Handlers) =>
            Effect.sync(() => {
              captured.handlers = handlers
              return {
                dispose: Effect.void,
                events: { emit: (name: string, data: unknown) => Effect.sync(() => void emitted.push({ name, data })) },
              }
            }),
        },
      ) as unknown as PluginApi.Context["rpc"],
      model: {
        list: () => Effect.die("unused model.list"),
        default: () => Effect.die("unused model.default"),
        reload: () => Effect.die("unused model.reload"),
        transform: (callback: (editor: never) => void) =>
          Effect.sync(() => {
            transforms.push(callback)
            callback({
              list: () =>
                models.map((model) => ({
                  providerID: model.providerID,
                  id: model.id,
                  capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
                })),
            } as never)
            return { dispose: Effect.void }
          }),
      } as unknown as PluginApi.Context["model"],
      session: {
        hook: ((name: string, callback: (event: never) => Effect.Effect<void>) =>
          Effect.sync(() => {
            hooks.set(name, [...(hooks.get(name) ?? []), callback])
            return { dispose: Effect.void }
          })) as unknown as PluginApi.Context["session"]["hook"],
      },
    })
    yield* KeteLocalModels.make(options).effect(ctx)
    const status = () => (captured.handlers ? captured.handlers.status({}, undefined as never) : Effect.die("no handlers"))
    const run = (name: string, event: unknown) =>
      Effect.forEach(hooks.get(name) ?? [], (callback) => (callback as (event: unknown) => Effect.Effect<void>)(event), {
        discard: true,
      })
    return { handlers: captured, status, emitted, run, hooks }
  })

const logs = () => {
  const output: string[] = []
  const logger = Logger.make((entry) => {
    output.push(Array.isArray(entry.message) ? entry.message.map(String).join(" ") : String(entry.message))
  })
  return { output, layer: Logger.layer([logger], { mergeWithExisting: false }) }
}

const find = (status: KeteLocalModelsRpc.Status, id: KeteLocalModelsRpc.ProviderID) => {
  const found = status.providers.find((provider) => provider.id === id)
  if (!found) throw new Error(`no status for ${id}`)
  return found
}

describe("KeteLocalModels status", () => {
  it.live("reports a reachable Ollama from OLLAMA_HOST, with its usable models", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => fakeOllama()),
      (server) =>
        Effect.gen(function* () {
          const mock = yield* startMock({
            environment: { OLLAMA_HOST: server.url.replace("http://", "") },
            defaultOrigins: { lmstudio: `http://127.0.0.1:${closedPort()}`, vllm: `http://127.0.0.1:${closedPort()}` },
          })
          const status = yield* mock.status()
          expect(status.offline).toBe(false)
          expect(status.providers.map((provider) => provider.id)).toEqual(["ollama", "lmstudio", "vllm"])
          const ollama = find(status, "ollama")
          expect(ollama).toMatchObject({
            state: "reachable",
            url: `${server.url}/v1`,
            source: "env",
            models: 3,
            insecure: false,
          })
          expect(ollama.hint).toContain("ollama serve")
          expect(ollama.error).toBeUndefined()
        }),
      (server) => Effect.sync(server.stop),
    ),
  )

  it.live("nothing listening on a default port is not_configured; on an explicit host it is unreachable with the URL and error", () =>
    Effect.gen(function* () {
      const port = closedPort()
      const mock = yield* startMock({
        environment: { OPENCODE_VLLM_HOST: `127.0.0.1:${port}` },
        defaultOrigins: { ollama: `http://127.0.0.1:${closedPort()}`, lmstudio: `http://127.0.0.1:${closedPort()}` },
      })
      const status = yield* mock.status()
      expect(find(status, "ollama")).toMatchObject({ state: "not_configured", source: "default" })
      expect(find(status, "ollama").error).toBeUndefined()
      expect(find(status, "lmstudio")).toMatchObject({ state: "not_configured" })
      const vllm = find(status, "vllm")
      expect(vllm).toMatchObject({ state: "unreachable", source: "env", url: `http://127.0.0.1:${port}/v1` })
      expect(vllm.error).toBeTruthy()
      expect(vllm.error!.length).toBeLessThanOrEqual(300)
      expect(vllm.hint).toContain("vllm serve")
    }),
  )

  it.live("config baseURL wins; the API key is sent but never returned; URL credentials never shown", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => fakeOllama()),
      (server) =>
        Effect.gen(function* () {
          const key = "s3cret-key-value"
          const config = yield* Config.Test
          yield* config.setEntries([settings("ollama", { baseURL: `${server.url}/v1`, apiKey: key })])
          const mock = yield* startMock({ environment: { OLLAMA_HOST: `127.0.0.1:${closedPort()}` }, timeout: "300 millis" })
          const status = yield* mock.status()
          expect(find(status, "ollama")).toMatchObject({ state: "reachable", source: "config", url: `${server.url}/v1` })
          expect(server.requests.length).toBeGreaterThan(0)
          expect(server.requests.every((request) => request.authorization === `Bearer ${key}`)).toBe(true)
          expect(JSON.stringify(status)).not.toContain(key)

          // Credentials embedded in a URL never reach the status, in the URL or the error.
          yield* config.setEntries([settings("vllm", { baseURL: `http://user:hunter2@127.0.0.1:${closedPort()}/v1` })])
          const credentialed = find(yield* mock.status(), "vllm")
          expect(credentialed.state).toBe("unreachable")
          expect(JSON.stringify(credentialed)).not.toContain("hunter2")
        }),
      (server) => Effect.sync(server.stop),
    ),
  )

  it.live("an invalid configured base URL is unreachable with a clear error", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([settings("ollama", { baseURL: "ftp://nowhere" })])
      const mock = yield* startMock()
      const ollama = find(yield* mock.status(), "ollama")
      expect(ollama.state).toBe("unreachable")
      expect(ollama.error).toContain("isn't a valid http(s) URL")
    }),
  )

  it.live("reads LM Studio's and vLLM's model lists", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) => {
            const path = new URL(request.url).pathname
            if (path === "/api/v1/models")
              return Response.json({ models: [{ type: "llm", key: "a" }, { type: "llm", key: "b" }, { type: "embedding", key: "e" }] })
            if (path === "/health") return new Response("")
            if (path === "/v1/models")
              return Response.json({ data: [{ id: "m1", owned_by: "vllm" }, { id: "other", owned_by: "someone" }] })
            return new Response("no", { status: 404 })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const config = yield* Config.Test
          const origin = `http://127.0.0.1:${server.port}`
          yield* config.setEntries([settings("lmstudio", { baseURL: `${origin}/v1` }), settings("vllm", { baseURL: `${origin}/v1` })])
          const mock = yield* startMock({ defaultOrigins: { ollama: `http://127.0.0.1:${closedPort()}` } })
          const status = yield* mock.status()
          expect(find(status, "lmstudio")).toMatchObject({ state: "reachable", models: 2, source: "config" })
          expect(find(status, "vllm")).toMatchObject({ state: "reachable", models: 1, source: "config" })
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("offline mode is reported", () =>
    Effect.gen(function* () {
      const mock = yield* startMock({
        environment: { OPENCODE_OFFLINE: "1" },
        defaultOrigins: {
          ollama: `http://127.0.0.1:${closedPort()}`,
          lmstudio: `http://127.0.0.1:${closedPort()}`,
          vllm: `http://127.0.0.1:${closedPort()}`,
        },
      })
      expect((yield* mock.status()).offline).toBe(true)
    }),
  )

  it.live("a plain-http host that isn't this machine is flagged and warned about once; https and loopback aren't", () =>
    Effect.gen(function* () {
      const captured = logs()
      yield* Effect.gen(function* () {
        const config = yield* Config.Test
        yield* config.setEntries([
          settings("ollama", { baseURL: "http://192.0.2.10:11434/v1" }),
          settings("lmstudio", { baseURL: "https://192.0.2.11/v1" }),
          settings("vllm", { baseURL: "http://127.0.0.1:1/v1" }),
        ])
        // The hosts are only classified; a stub client answers so nothing leaves this machine.
        const mock = yield* startMock({ timeout: "150 millis" }).pipe(Effect.provideService(HttpClient.HttpClient, unavailable))
        const first = yield* mock.status()
        yield* mock.status()
        expect(find(first, "ollama").insecure).toBe(true)
        expect(find(first, "lmstudio").insecure).toBe(false)
        expect(find(first, "vllm").insecure).toBe(false)
      }).pipe(Effect.provide(captured.layer))
      const warnings = captured.output.filter((line) => line.includes("crosses the network unencrypted"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("http://192.0.2.10:11434/v1")
    }),
  )

  it.live("an invalid host variable is logged and ignored", () =>
    Effect.gen(function* () {
      const captured = logs()
      yield* startMock({ environment: { OPENCODE_OLLAMA_HOST: "ftp://nope" } }).pipe(Effect.provide(captured.layer))
      expect(captured.output.some((line) => line.includes("Ignoring OPENCODE_OLLAMA_HOST"))).toBe(true)
    }),
  )
})

describe("KeteLocalModels context", () => {
  const cases = (model: string) => ({ model })

  test("a served window smaller than the advertised one warns, naming the fix", () => {
    const message = KeteLocalModels.contextWarning({ ...cases("m"), discovered: 131_072, numCtx: 4096 })
    expect(message).toContain("131072")
    expect(message).toContain("serves 4096 tokens")
    expect(message).toContain("OLLAMA_CONTEXT_LENGTH")
    expect(message).toContain("num_ctx")
  })

  test("the loaded window wins over the parameter", () => {
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 32_768, numCtx: 32_768, loaded: 8192 })).toContain(
      "serves 8192 tokens",
    )
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 32_768, numCtx: 4096, loaded: 32_768 })).toBeUndefined()
  })

  test("a served window that covers the advertised one doesn't warn", () => {
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 8192, numCtx: 8192 })).toBeUndefined()
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 8192, numCtx: 16_384 })).toBeUndefined()
  })

  test("with the served window unknown, only a large advertised window warns", () => {
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 131_072 })).toContain("may serve only its default window")
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 8193 })).toContain("may serve only")
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 8192 })).toBeUndefined()
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: 4096 })).toBeUndefined()
    expect(KeteLocalModels.contextWarning({ ...cases("m"), discovered: undefined })).toBeUndefined()
  })

  it.live("status returns the warnings for reachable Ollama models and logs each once", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => fakeOllama()),
      (server) =>
        Effect.gen(function* () {
          const captured = logs()
          const status = yield* Effect.gen(function* () {
            const mock = yield* startMock({
              environment: { OLLAMA_HOST: server.url.replace("http://", "") },
              defaultOrigins: { lmstudio: `http://127.0.0.1:${closedPort()}`, vllm: `http://127.0.0.1:${closedPort()}` },
            })
            yield* mock.status()
            return yield* mock.status()
          }).pipe(Effect.provide(captured.layer))
          const warnings = find(status, "ollama").contextWarnings ?? []
          expect(warnings.map((warning) => warning.model)).toEqual(["big", "small-ctx"])
          expect(warnings[0]!.message).toContain("may serve only")
          expect(warnings[1]!.message).toContain("serves 4096 tokens")
          for (const model of ["big", "small-ctx"])
            expect(captured.output.filter((line) => line.startsWith(`${model} advertises`))).toHaveLength(1)
        }),
      (server) => Effect.sync(server.stop),
    ),
  )
})

describe("KeteLocalModels tools", () => {
  const toolsEvent = (providerID: string, id: string) => ({
    model: { providerID, id },
    system: [{ type: "text" as const, text: "base" }],
    tools: { read: { description: "r", input: {} }, shell: { description: "s", input: {} } },
  })
  const models = [
    { providerID: "vllm", id: "no-tools", tools: false },
    { providerID: "ollama", id: "with-tools", tools: true },
  ]

  it.live("a model without tools gets none and an agent notice", () =>
    Effect.gen(function* () {
      const mock = yield* startMock({}, models)
      const event = toolsEvent("vllm", "no-tools")
      yield* mock.run("context", event)
      expect(Object.keys(event.tools)).toEqual([])
      expect(event.system).toHaveLength(2)
      expect(event.system[1]!.text).toBe(KeteLocalModels.noToolsNotice)
      expect(KeteLocalModels.noToolsNotice).toContain("can't call tools")
    }),
  )

  it.live("a model with tools, and a model nobody knows, keep every tool", () =>
    Effect.gen(function* () {
      const mock = yield* startMock({}, models)
      for (const [providerID, id] of [["ollama", "with-tools"], ["cloud", "unknown"]] as const) {
        const event = toolsEvent(providerID, id)
        yield* mock.run("context", event)
        expect(Object.keys(event.tools)).toEqual(["read", "shell"])
        expect(event.system).toHaveLength(1)
      }
    }),
  )

  it.live("compaction and generate lose the tools too, without the notice", () =>
    Effect.gen(function* () {
      const mock = yield* startMock({}, models)
      for (const name of ["compaction", "generate"]) {
        const event = toolsEvent("vllm", "no-tools")
        yield* mock.run(name, event)
        expect(Object.keys(event.tools)).toEqual([])
        expect(event.system).toHaveLength(1)
      }
    }),
  )

  it.live("follows the model list: a config override that reports tools:true (applied before this plugin sees the list) keeps tools", () =>
    Effect.gen(function* () {
      const mock = yield* startMock({}, [{ providerID: "vllm", id: "no-tools", tools: true }])
      const event = toolsEvent("vllm", "no-tools")
      yield* mock.run("context", event)
      expect(Object.keys(event.tools)).toEqual(["read", "shell"])
    }),
  )
})

describe("KeteLocalModels rediscover", () => {
  it.live("the RPC emits the rediscover event for one provider or all", () =>
    Effect.gen(function* () {
      const mock = yield* startMock()
      const handlers = mock.handlers.handlers!
      yield* handlers.rediscover({ provider: "ollama" }, undefined as never)
      expect(mock.emitted).toEqual([{ name: "rediscover", data: { provider: "ollama" } }])
      mock.emitted.length = 0
      yield* handlers.rediscover({}, undefined as never)
      expect(mock.emitted.map((event) => (event.data as { provider: string }).provider)).toEqual(["ollama", "lmstudio", "vllm"])
    }),
  )

  it.live("the Ollama plugin re-fetches its models when the event arrives, before its interval", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { models: ["big"] }
        return { state, server: fakeOllama(() => state.models) }
      }),
      ({ state, server }) =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const modelState = yield* Model.Service
          const rpc = yield* Rpc.Service
          const ollama = Provider.ID.make("ollama")
          const pluginHost = yield* PluginHost.make(plugin)
          yield* makeOllama(server.url, "1 hour").effect(pluginHost)
          yield* KeteLocalModels.make({
            environment: { OLLAMA_HOST: server.url.replace("http://", "") },
          }).effect(pluginHost)
          const wait = (id: string) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3000; attempt++) {
                if ((yield* modelState.get(ollama, Model.ID.make(id))) !== undefined) return true
                yield* Effect.promise(() => Bun.sleep(1))
              }
              return false
            })
          expect(yield* wait("big")).toBe(true)
          state.models = ["big", "fits"]
          expect(yield* modelState.get(ollama, Model.ID.make("fits"))).toBeUndefined()
          yield* rpc.call("kete.local-models", "rediscover", { provider: "ollama" })
          expect(yield* wait("fits")).toBe(true)
        }),
      ({ server }) => Effect.sync(server.stop),
    ),
  )
})
