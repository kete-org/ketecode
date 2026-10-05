// AC1: OLLAMA_HOST / KETE_OLLAMA_HOST (and the LM Studio and vLLM variables) pick the server the
// upstream provider plugins discover from; config `baseURL` wins over both.
import { Config } from "@opencode/core/config"
import { KeteLocalHosts } from "@opencode/core/kete/local-hosts"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make } from "@opencode/core/plugin/provider/ollama"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)

describe("KeteLocalHosts.parse", () => {
  test.each([
    ["192.168.1.20:11434", 11434, "http://192.168.1.20:11434"],
    ["gpu-box", 11434, "http://gpu-box:11434"],
    ["gpu-box:9999", 11434, "http://gpu-box:9999"],
    ["[fd00::5]", 11434, "http://[fd00::5]:11434"],
    ["[fd00::5]:8080", 11434, "http://[fd00::5]:8080"],
    ["http://10.0.0.7:1234", 1234, "http://10.0.0.7:1234"],
    ["http://10.0.0.7", 1234, "http://10.0.0.7"],
    ["https://ollama.example.com", 11434, "https://ollama.example.com"],
    ["https://ollama.example.com:8443/proxy/", 11434, "https://ollama.example.com:8443/proxy"],
    ["0.0.0.0:11434", 11434, "http://127.0.0.1:11434"],
    ["0.0.0.0", 11434, "http://127.0.0.1:11434"],
    ["  localhost  ", 8000, "http://localhost:8000"],
  ])("%s", (value, port, expected) => {
    expect(KeteLocalHosts.parse(value, port)).toBe(expected)
  })

  test.each(["", "   ", "ftp://host", "http://user:pass@host", "http://", "::1", "host with spaces"])(
    "rejects %j",
    (value) => {
      expect(KeteLocalHosts.parse(value, 11434)).toBeUndefined()
    },
  )
})

describe("KeteLocalHosts.resolve / origin", () => {
  test("KETE_OLLAMA_HOST (bridged) beats OLLAMA_HOST, which beats the default", () => {
    expect(KeteLocalHosts.origin("ollama", {})).toBe("http://127.0.0.1:11434")
    expect(KeteLocalHosts.origin("ollama", { OLLAMA_HOST: "192.168.1.20:11434" })).toBe("http://192.168.1.20:11434")
    expect(
      KeteLocalHosts.origin("ollama", { OLLAMA_HOST: "192.168.1.20:11434", OPENCODE_OLLAMA_HOST: "gpu:1" }),
    ).toBe("http://gpu:1")
    expect(KeteLocalHosts.resolve("ollama", { OLLAMA_HOST: "a" })).toMatchObject({ source: "env", variable: "OLLAMA_HOST" })
    expect(KeteLocalHosts.resolve("ollama", {})).toMatchObject({ source: "default" })
  })

  test("LM Studio and vLLM read only their KETE_ variables", () => {
    expect(KeteLocalHosts.origin("lmstudio", { OPENCODE_LMSTUDIO_HOST: "10.0.0.2" })).toBe("http://10.0.0.2:1234")
    expect(KeteLocalHosts.origin("vllm", { OPENCODE_VLLM_HOST: "10.0.0.3" })).toBe("http://10.0.0.3:8000")
    expect(KeteLocalHosts.origin("lmstudio", { OLLAMA_HOST: "10.0.0.2" })).toBe("http://127.0.0.1:1234")
    expect(KeteLocalHosts.origin("vllm", {})).toBe("http://127.0.0.1:8000")
  })

  test("an invalid value is reported and the next source is used", () => {
    const resolved = KeteLocalHosts.resolve("ollama", { OPENCODE_OLLAMA_HOST: "ftp://x", OLLAMA_HOST: "10.0.0.9" })
    expect(resolved).toMatchObject({ origin: "http://10.0.0.9:11434", source: "env", variable: "OLLAMA_HOST" })
    expect(resolved.invalid).toEqual(["OPENCODE_OLLAMA_HOST"])
    expect(KeteLocalHosts.resolve("ollama", { OLLAMA_HOST: "ftp://x" })).toMatchObject({
      origin: "http://127.0.0.1:11434",
      source: "default",
      invalid: ["OLLAMA_HOST"],
    })
  })
})

describe("KeteLocalHosts.insecure / display / isRediscover", () => {
  test("only plain http to a host that isn't this machine is insecure", () => {
    expect(KeteLocalHosts.insecure("http://192.168.1.20:11434/v1")).toBe(true)
    expect(KeteLocalHosts.insecure("http://gpu.lan:11434/v1")).toBe(true)
    expect(KeteLocalHosts.insecure("http://127.0.0.1:11434/v1")).toBe(false)
    expect(KeteLocalHosts.insecure("http://localhost:11434/v1")).toBe(false)
    expect(KeteLocalHosts.insecure("http://[::1]:11434/v1")).toBe(false)
    expect(KeteLocalHosts.insecure("https://ollama.example.com/v1")).toBe(false)
    expect(KeteLocalHosts.insecure("not a url")).toBe(false)
  })

  test("display drops credentials, query and fragment", () => {
    expect(KeteLocalHosts.display("http://user:secret@host:1/v1?token=abc#frag")).toBe("http://host:1/v1")
    expect(KeteLocalHosts.display("nope")).toBe("")
  })

  test("isRediscover matches the event type and provider", () => {
    const event = { type: KeteLocalHosts.rediscoverEvent, data: { provider: "ollama" } }
    expect(KeteLocalHosts.isRediscover(event, "ollama")).toBe(true)
    expect(KeteLocalHosts.isRediscover(event, "vllm")).toBe(false)
    expect(KeteLocalHosts.isRediscover({ type: "config.updated", data: { provider: "ollama" } }, "ollama")).toBe(false)
    expect(KeteLocalHosts.isRediscover({ type: KeteLocalHosts.rediscoverEvent }, "ollama")).toBe(false)
  })
})

const summary = (model: string) => ({
  name: model,
  model,
  modified_at: "2026-01-01T00:00:00Z",
  size: 1_000_000,
  digest: `${model}-digest`,
  details: { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_K_M" },
})

const ollamaServer = (name: string) => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(new URL(request.url).pathname)
      if (request.method === "GET") return Response.json({ models: [summary(name)] })
      return Response.json({
        capabilities: ["completion", "tools"],
        details: { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_K_M" },
        model_info: { "llama.context_length": 32_768 },
      })
    },
  })
  return { server, requests }
}

const addPlugin = Effect.fn(function* (origin: string) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* make(origin, "1 hour").effect(host)
})

function eventually<A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, remaining = 3000): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

describe("the Ollama plugin with an environment host", () => {
  it.live("discovers from OLLAMA_HOST", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ollamaServer("from-env")),
      ({ server }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          const providers = yield* Provider.Service
          const host = `${server.url.hostname}:${server.url.port}`
          yield* addPlugin(KeteLocalHosts.origin("ollama", { OLLAMA_HOST: host }))
          yield* eventually(models.get(Provider.ID.make("ollama"), Model.ID.make("from-env")), (model) => model !== undefined)
          expect((yield* providers.get(Provider.ID.make("ollama")))?.settings).toMatchObject({
            baseURL: `${server.url.origin}/v1`,
          })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("discovers from KETE_OLLAMA_HOST (OPENCODE_OLLAMA_HOST) over OLLAMA_HOST", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ({ preferred: ollamaServer("preferred"), other: ollamaServer("other") })),
      ({ preferred, other }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          yield* addPlugin(
            KeteLocalHosts.origin("ollama", {
              OPENCODE_OLLAMA_HOST: `${preferred.server.url.hostname}:${preferred.server.url.port}`,
              OLLAMA_HOST: `${other.server.url.hostname}:${other.server.url.port}`,
            }),
          )
          yield* eventually(models.get(Provider.ID.make("ollama"), Model.ID.make("preferred")), (model) => model !== undefined)
          expect(other.requests).toEqual([])
        }),
      ({ preferred, other }) => Effect.promise(() => Promise.all([preferred.server.stop(true), other.server.stop(true)])),
    ),
  )

  it.live("config baseURL wins over the environment", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ({ fromEnv: ollamaServer("from-env"), fromConfig: ollamaServer("from-config") })),
      ({ fromEnv, fromConfig }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* config.setEntries([
            new Document({
              type: "document",
              info: decode({ providers: { ollama: { settings: { baseURL: `${fromConfig.server.url.origin}/v1` } } } }),
            }),
          ])
          yield* addPlugin(
            KeteLocalHosts.origin("ollama", {
              OLLAMA_HOST: `${fromEnv.server.url.hostname}:${fromEnv.server.url.port}`,
            }),
          )
          yield* eventually(models.get(Provider.ID.make("ollama"), Model.ID.make("from-config")), (model) => model !== undefined)
          expect(fromEnv.requests).toEqual([])
        }),
      ({ fromEnv, fromConfig }) =>
        Effect.promise(() => Promise.all([fromEnv.server.stop(true), fromConfig.server.stop(true)])),
    ),
  )
})
