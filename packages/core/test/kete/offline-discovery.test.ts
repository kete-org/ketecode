// Offline mode and the upstream local server plugins (plugin/provider/{ollama,lmstudio,vllm}.ts): a
// server whose base URL isn't on this machine or a private network is never contacted (no model list,
// no /api/show, no /health, no API key), while a private-network one still is. A recording stub
// client answers every request, so these tests never reach a real host.
import { Config } from "@opencode/core/config"
import { KeteOffline } from "@opencode/core/kete/offline"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make as makeLMStudio } from "@opencode/core/plugin/provider/lmstudio"
import { make as makeOllama } from "@opencode/core/plugin/provider/ollama"
import { make as makeVLLM } from "@opencode/core/plugin/provider/vllm"
import { Document, type Entry, Info } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)
const document = (value: unknown): Entry => new Document({ type: "document", info: decode(value) })

const plugins = {
  ollama: makeOllama,
  lmstudio: makeLMStudio,
  vllm: makeVLLM,
} as const

type ID = keyof typeof plugins

const recording = () => {
  const requests: Array<{ url: string; authorization: string | undefined }> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers["authorization"] })
      return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }))
    }),
  )
  return { requests, client }
}

// Each case uses its own port: the plugins keep a process-wide discovery cache keyed by endpoint.
let port = 41000
const next = () => port++

const run = (id: ID, host: string, offline: boolean) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    const baseURL = `http://${host}:${next()}/v1`
    yield* config.setEntries([
      document({ providers: { [id]: { settings: { baseURL, apiKey: "discovery-key" } } } }),
      ...(offline ? [document({ kete: { offline: true } })] : []),
    ])
    const fake = recording()
    const plugin = yield* Plugin.Service
    const pluginHost = yield* PluginHost.make(plugin)
    yield* plugins[id](`http://${host}:1`, "1 hour")
      .effect(pluginHost)
      .pipe(Effect.provideService(HttpClient.HttpClient, fake.client))
    yield* Effect.promise(() => Bun.sleep(100))
    return { requests: fake.requests, host: new URL(baseURL).host }
  })

describe("local server discovery in offline mode", () => {
  for (const id of Object.keys(plugins) as ID[]) {
    it.live(`${id}: a public base URL gets no request at all`, () =>
      Effect.gen(function* () {
        const result = yield* run(id, "203.0.113.10", true)
        expect(result.requests).toEqual([])
      }),
    )

    it.live(`${id}: a private-network base URL is still discovered`, () =>
      Effect.gen(function* () {
        const result = yield* run(id, "192.168.1.20", true)
        expect(result.requests.length).toBeGreaterThan(0)
        expect(result.requests.every((request) => request.url.includes(result.host))).toBe(true)
      }),
    )

    it.live(`${id}: the public base URL is discovered when offline mode is off (the stub is in use)`, () =>
      Effect.gen(function* () {
        const result = yield* run(id, "203.0.113.10", false)
        expect(result.requests.length).toBeGreaterThan(0)
        expect(result.requests.every((request) => request.url.includes(result.host))).toBe(true)
      }),
    )
  }
})

describe("KeteOffline.blocks", () => {
  it.live("on with the flag or config, and only for hosts that aren't local", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([])
      const service = yield* Config.Service
      expect(yield* KeteOffline.blocks(service, "http://203.0.113.10:11434/v1", {})).toBe(false)
      expect(yield* KeteOffline.blocks(service, "http://203.0.113.10:11434/v1", { OPENCODE_OFFLINE: "1" })).toBe(true)
      expect(yield* KeteOffline.blocks(service, "http://10.1.2.3:11434/v1", { OPENCODE_OFFLINE: "1" })).toBe(false)
      expect(yield* KeteOffline.blocks(service, "not a url", { OPENCODE_OFFLINE: "1" })).toBe(true)
      yield* config.setEntries([document({ kete: { offline: true } })])
      expect(yield* KeteOffline.blocks(service, "https://gpu.example.com/v1", {})).toBe(true)
      expect(yield* KeteOffline.blocks(service, "http://localhost:1234/v1", {})).toBe(false)
    }),
  )
})
