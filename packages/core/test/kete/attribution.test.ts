import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeteAttribution } from "@opencode/core/kete/attribution"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import path from "node:path"
import { CerebrasPlugin } from "@opencode/core/plugin/provider/cerebras"
import { KiloPlugin } from "@opencode/core/plugin/provider/kilo"
import { LLMGatewayPlugin } from "@opencode/core/plugin/provider/llmgateway"
import { NvidiaPlugin } from "@opencode/core/plugin/provider/nvidia"
import { OpenRouterPlugin } from "@opencode/core/plugin/provider/openrouter"
import { VercelPlugin } from "@opencode/core/plugin/provider/vercel"
import { ZenmuxPlugin } from "@opencode/core/plugin/provider/zenmux"
import { Provider } from "@opencode/core/provider"
import { Brand } from "@opencode/util/kete/brand"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

// The upstream provider plugins, then Kete's, in the order the runtime registers them.
const addPlugins = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  for (const item of [OpenRouterPlugin, VercelPlugin, KiloPlugin, LLMGatewayPlugin, ZenmuxPlugin, NvidiaPlugin, CerebrasPlugin])
    yield* item.effect(host)
  yield* KeteAttribution.Plugin.effect(host)
})

const compatible = (id: string, baseURL: string) => ({ id, package: "@opencode/ai/providers/openai-compatible", baseURL })
const providers = [
  { id: "openrouter", package: "@opencode/ai/providers/openrouter" },
  { id: "vercel", package: Provider.aisdk("@ai-sdk/vercel") },
  compatible("kilo", "https://api.kilo.ai/api/gateway"),
  compatible("zenmux", "https://zenmux.ai/api/v1"),
  compatible("nvidia", "https://integrate.api.nvidia.com/v1"),
  { id: "cerebras", package: "@opencode/ai/providers/cerebras" },
  { id: "openai", package: Provider.aisdk("@ai-sdk/openai") },
]

const seed = (headers: (id: string) => Record<string, string> | undefined = () => undefined) =>
  Effect.gen(function* () {
    const catalog = yield* Provider.Service
    yield* catalog.transform((catalog) => {
      for (const item of providers)
        catalog.update(Provider.ID.make(item.id), (provider) => {
          provider.package = item.package
          if ("baseURL" in item) provider.settings = { baseURL: item.baseURL }
          const extra = headers(item.id)
          if (extra) provider.headers = extra
        })
    })
    return catalog
  })

const headersOf = (catalog: Provider.Interface, id: string) =>
  catalog.get(Provider.ID.make(id)).pipe(Effect.map((provider) => provider?.headers ?? {}))

describe("KeteAttribution", () => {
  // The internal plugin list isn't exported; its order is the registration order in the source.
  test("is registered after the upstream provider plugins", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/plugin/internal.ts")).text()
    const providers = source.indexOf("  ...ProviderPlugins,")
    const kete = source.indexOf("  KeteAttribution.Plugin,")
    expect(providers).toBeGreaterThan(-1)
    expect(kete).toBeGreaterThan(providers)
  })

  it.effect("credits Kete Code instead of OpenCode", () =>
    Effect.gen(function* () {
      const catalog = yield* seed()
      yield* addPlugins()
      // No Kete Code website yet: the referer is dropped rather than credit opencode.ai.
      expect(Brand.urls.website).toBeUndefined()
      for (const id of ["openrouter", "kilo", "zenmux"])
        expect(yield* headersOf(catalog, id)).toEqual({ "X-Title": "Kete Code" })
      expect(yield* headersOf(catalog, "vercel")).toEqual({ "x-title": "Kete Code" })
      expect(yield* headersOf(catalog, "nvidia")).toEqual({ "X-Title": "Kete Code", "X-BILLING-INVOKE-ORIGIN": "KeteCode" })
      expect(yield* headersOf(catalog, "cerebras")).toEqual({ "X-Cerebras-3rd-Party-Integration": "kete-code" })
    }),
  )

  it.effect("leaves other values, and headers it doesn't own, untouched", () =>
    Effect.gen(function* () {
      const configured: Record<string, Record<string, string>> = {
        nvidia: { "X-BILLING-INVOKE-ORIGIN": "MyCompany" },
        openai: { originator: "opencode", "x-opencode-session": "s1", Existing: "value" },
      }
      const catalog = yield* seed((id) => configured[id])
      yield* addPlugins()
      expect((yield* headersOf(catalog, "nvidia"))["X-BILLING-INVOKE-ORIGIN"]).toBe("MyCompany")
      expect(yield* headersOf(catalog, "openai")).toEqual({ originator: "opencode", "x-opencode-session": "s1", Existing: "value" })
    }),
  )

  // LLM Gateway's plugin only applies to a connected integration; these are the headers it sets.
  test("LLM Gateway: drops the opencode referer and source, keeps a Kete title", () => {
    expect(
      KeteAttribution.rewrite({ "HTTP-Referer": "https://opencode.ai/", "X-Title": "opencode", "X-Source": "opencode" }),
    ).toEqual({ "X-Title": "Kete Code" })
  })

  test("rewrite replaces only upstream's exact default values", () => {
    expect(KeteAttribution.rewrite({ "HTTP-Referer": "https://example.com/", "X-Title": "My App" })).toEqual({
      "HTTP-Referer": "https://example.com/",
      "X-Title": "My App",
    })
    const unchanged = { originator: "opencode" }
    expect(KeteAttribution.rewrite(unchanged)).toBe(unchanged)
    expect(KeteAttribution.rewrite({ "http-referer": "https://opencode.ai/", "x-title": "opencode" })).toEqual({
      "x-title": "Kete Code",
    })
  })
})
