import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { KeteGateway } from "@opencode/core/kete/gateway"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { KeteAccount } from "@opencode/util/kete/account"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)
const key = "kete_test_0123456789abcdefghijKLMNOP"

const addPlugin = Effect.fn(function* (
  environment: Record<string, string | undefined> = {},
  account?: KeteAccount.Options,
  jobKey?: () => string | undefined,
) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* KeteGateway.make({ interval: "1 hour", balanceInterval: "1 hour", environment, account, jobKey }).effect(host)
})

// An in-memory stand-in for the OS credential store.
function memoryStore(): KeteSecretStore.Store {
  const entries = new Map<string, string>()
  return {
    kind: "keychain",
    description: "test store",
    set: async (name, secret) => void entries.set(name, secret),
    get: async (name) => entries.get(name),
    remove: async (name) => void entries.delete(name),
  }
}

// A signed-in account (as `kete login` leaves it) in a temporary directory.
const signIn = (gatewayURL: string, secret: string | undefined) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "kete-account-"))
      const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
      const saved = await KeteAccount.save(
        options,
        {
          platform_url: gatewayURL,
          gateway_url: gatewayURL,
          organization: { id: "o", name: "Acme" },
          key_id: "00000000-0000-4000-8000-000000000001",
          device_name: "test",
        },
        secret ?? "placeholder",
      )
      if (secret === undefined) await options.native.remove(`${new URL(gatewayURL).host}/${saved.account.key_id}`)
      return { root, options }
    }),
    ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(Effect.map(({ options }) => options))

// Stands in for the catalog entries models.dev provides for the gateway's source providers.
const seedCatalog = Effect.fn(function* () {
  const catalog = yield* Provider.Service
  yield* catalog.transform((providers) => {
    providers.update(Provider.ID.make("anthropic"), (provider) => {
      provider.package = "@ai-sdk/anthropic"
    })
    providers.models.update(Provider.ID.make("anthropic"), Model.ID.make("claude-sonnet-4-5"), (model) => {
      model.name = "Claude Sonnet 4.5"
      model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
      model.limit.context = 200_000
      model.cost = [
        {
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(15),
          cache: { read: Money.USDPerMillionTokens.make(0.3), write: Money.USDPerMillionTokens.make(3.75) },
        },
      ]
    })
    providers.update(Provider.ID.make("openai"), (provider) => {
      provider.package = "@ai-sdk/openai"
    })
  })
})

function gateway(platform: "prices" | "down" = "prices") {
  const requests: Array<{ path: string; headers: Record<string, string | null> }> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      requests.push({
        path,
        headers: {
          "x-api-key": request.headers.get("x-api-key"),
          authorization: request.headers.get("authorization"),
          "x-goog-api-key": request.headers.get("x-goog-api-key"),
        },
      })
      if (path === "/anthropic/v1/models")
        return Response.json({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5 (Kete)" }] })
      if (path === "/openai/v1/models") return Response.json({ object: "list", data: [{ id: "gpt-4.1" }] })
      if (path === "/api/v1/me")
        return platform === "down"
          ? Response.json({ error: { code: "internal" } }, { status: 500 })
          : Response.json({
              key: { id: "k", name: "CLI", kind: "cli" },
              organization: { id: "o", name: "Acme" },
              balance_micros: 12_500_000,
              currency: "USD",
              gateway_url: "ignored",
            })
      if (path === "/api/v1/models")
        return platform === "down"
          ? Response.json({ error: { code: "internal" } }, { status: 500 })
          : Response.json({
              models: [
                {
                  provider: "anthropic",
                  model_id: "claude-sonnet-4-5",
                  display_name: "Claude Sonnet 4.5",
                  context_window: 200000,
                  gateway_base_url: "ignored",
                  pricing_micros_per_mtok: {
                    input: 3_300_000,
                    output: 16_500_000,
                    cache_read: 330_000,
                    cache_write: 4_125_000,
                  },
                },
                {
                  provider: "gemini",
                  model_id: "gemini-2.5-pro",
                  display_name: "Gemini 2.5 Pro",
                  context_window: null,
                  gateway_base_url: "ignored",
                  pricing_micros_per_mtok: { input: 1, output: 1, cache_read: 1, cache_write: 1 },
                },
              ],
            })
      return Response.json({ error: { message: "Provider is not available." } }, { status: 404 })
    },
  })
  return { requests, server }
}

const prices = (model: Model.Info | undefined) =>
  model?.cost.map((cost): number[] => [cost.input, cost.output, cost.cache.read, cost.cache.write])

function settings(value: Record<string, string>, platform?: string) {
  return new Document({
    type: "document",
    info: decode({
      providers: { kete: { settings: value } },
      ...(platform ? { kete: { platform: { url: platform } } } : {}),
    }),
  })
}

function eventually<A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 3000,
): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

describe("KeteGateway", () => {
  it.live("offers the gateway's allowlisted models on their native routes", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ requests, server }) =>
        Effect.gen(function* () {
          const providers = yield* Provider.Service
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: `${server.url.origin}/`, apiKey: key })])
          yield* addPlugin()

          const claude = yield* eventually(
            models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
            (model) => model !== undefined,
          )
          expect(claude).toMatchObject({
            providerID: "kete",
            modelID: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5 (Kete)",
            canonical: "anthropic",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 200_000 },
            settings: { baseURL: `${server.url.origin}/anthropic/v1` },
          })
          expect(claude?.package).toContain("anthropic")

          const gpt = yield* models.get(KeteGateway.providerID, Model.ID.make("gpt-4.1"))
          expect(gpt?.settings?.baseURL).toBe(`${server.url.origin}/openai/v1`)
          expect(gpt?.package).toContain("openai")

          expect(yield* providers.get(KeteGateway.providerID)).toMatchObject({
            name: "Kete Code Gateway",
            activation: "enabled",
            integrationID: "kete",
            settings: { apiKey: key },
          })

          // Each route gets the key in the header its provider SDK uses; unserved providers are skipped.
          expect(requests).toContainEqual({
            path: "/anthropic/v1/models",
            headers: { "x-api-key": key, authorization: null, "x-goog-api-key": null },
          })
          expect(requests).toContainEqual({
            path: "/openai/v1/models",
            headers: { "x-api-key": null, authorization: `Bearer ${key}`, "x-goog-api-key": null },
          })
          expect(requests).toContainEqual({
            path: "/gemini/v1beta/models",
            headers: { "x-api-key": null, authorization: null, "x-goog-api-key": key },
          })
          expect(requests.map((request) => request.path)).toContain("/compat/deepseek/v1/models")
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("uses the platform's prices for gateway models", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => gateway("prices")),
      ({ requests, server }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: server.url.origin, apiKey: key }, `${server.url.origin}/`)])
          yield* addPlugin()
          const claude = yield* eventually(
            models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
            (model) => model?.cost[0]?.input === 3.3,
          )
          expect(prices(claude)).toEqual([[3.3, 16.5, 0.33, 4.125]])
          // The platform catalog lists models the gateway doesn't serve here; they aren't offered.
          expect(yield* models.get(KeteGateway.providerID, Model.ID.make("gemini-2.5-pro"))).toBeUndefined()
          expect(requests).toContainEqual({
            path: "/api/v1/models",
            headers: { "x-api-key": null, authorization: `Bearer ${key}`, "x-goog-api-key": null },
          })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("publishes the platform balance as the kete integration's metadata", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => gateway("prices")),
      ({ requests, server }) =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: server.url.origin, apiKey: key }, server.url.origin)])
          yield* addPlugin()
          const integration = yield* eventually(
            integrations.get(KeteGateway.integrationID),
            (item) => item?.metadata?.balance_micros !== undefined,
          )
          expect(integration?.metadata).toMatchObject({
            balance_micros: 12_500_000,
            currency: "USD",
            organization: "Acme",
          })
          expect(requests).toContainEqual({
            path: "/api/v1/me",
            headers: { "x-api-key": null, authorization: `Bearer ${key}`, "x-goog-api-key": null },
          })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("publishes no balance without a platform URL", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => gateway("prices")),
      ({ requests, server }) =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: server.url.origin, apiKey: key })])
          yield* addPlugin()
          yield* eventually(
            models.get(KeteGateway.providerID, Model.ID.make("gpt-4.1")),
            (model) => model !== undefined,
          )
          expect((yield* integrations.get(KeteGateway.integrationID))?.metadata?.balance_micros).toBeUndefined()
          expect(requests.map((request) => request.path)).not.toContain("/api/v1/me")
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("keeps gateway models on catalog prices while the platform is down", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => gateway("down")),
      ({ server }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: server.url.origin, apiKey: key }, server.url.origin)])
          yield* addPlugin()
          const claude = yield* eventually(
            models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
            (model) => model !== undefined,
          )
          expect(prices(claude)).toEqual([[3, 15, 0.3, 3.75]])
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("registers a Kete Gateway key login once a gateway URL is configured", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      yield* addPlugin({ [KeteGateway.urlVariable]: "http://127.0.0.1:9" })
      const integration = yield* integrations.get(KeteGateway.integrationID)
      expect(integration?.name).toBe("Kete Code Gateway")
      expect(integration?.methods).toContainEqual({ type: "key", label: "Kete Code API key" })
    }),
  )

  it.live("uses the signed-in account over hand-configured gateway settings", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ requests, server }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const providers = yield* Provider.Service
            const models = yield* Model.Service
            const config = yield* Config.Test
            const integrations = yield* Integration.Service
            yield* seedCatalog()
            yield* config.setEntries([settings({ baseURL: "http://127.0.0.1:9/", apiKey: "config-key" })])
            const account = yield* signIn(server.url.origin, "account-key")
            yield* addPlugin({ [KeteGateway.keyVariable]: "env-key" }, account)

            yield* eventually(
              models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
              (model) => model !== undefined,
            )
            expect((yield* providers.get(KeteGateway.providerID))?.settings).toEqual({ apiKey: "account-key" })
            expect(requests.find((request) => request.path === "/anthropic/v1/models")?.headers["x-api-key"]).toBe(
              "account-key",
            )
            // The account's platform URL is used for prices and the balance too.
            const integration = yield* eventually(
              integrations.get(KeteGateway.integrationID),
              (item) => item?.metadata?.organization === "Acme",
            )
            expect(integration?.metadata).toMatchObject({ balance_micros: 12_500_000 })
            expect(requests.find((request) => request.path === "/api/v1/me")?.headers.authorization).toBe(
              "Bearer account-key",
            )
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("job mode: the descriptor key is the only key and the env URL the only URL — account, config and env keys, config URL ignored (D2)", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ requests, server }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const providers = yield* Provider.Service
            const models = yield* Model.Service
            const config = yield* Config.Test
            yield* seedCatalog()
            // A configured gateway URL pointing elsewhere: ignored in job mode.
            yield* config.setEntries([settings({ baseURL: "http://127.0.0.1:9/", apiKey: "config-key" })])
            // A signed-in account pointing elsewhere: never read in job mode.
            const account = yield* signIn("http://127.0.0.1:9", "account-key")
            yield* addPlugin(
              { OPENCODE_JOB_MODE: "1", [KeteGateway.urlVariable]: server.url.origin, [KeteGateway.keyVariable]: "env-key" },
              account,
              () => "job-descriptor-key",
            )

            yield* eventually(
              models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
              (model) => model !== undefined,
            )
            expect((yield* providers.get(KeteGateway.providerID))?.settings).toEqual({ apiKey: "job-descriptor-key" })
            const keys = requests.flatMap((request) => [request.headers["x-api-key"], request.headers.authorization])
            expect(keys).toContain("job-descriptor-key")
            for (const ignored of ["env-key", "config-key", "account-key"])
              expect(keys.some((value) => value?.includes(ignored))).toBe(false)
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("job mode without a descriptor key offers nothing, even with config and env keys (D2)", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ requests, server }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const providers = yield* Provider.Service
            const config = yield* Config.Test
            yield* seedCatalog()
            yield* config.setEntries([settings({ baseURL: `${server.url.origin}/`, apiKey: "config-key" })])
            yield* addPlugin(
              { OPENCODE_JOB_MODE: "1", [KeteGateway.urlVariable]: server.url.origin, [KeteGateway.keyVariable]: "env-key" },
              undefined,
              () => undefined,
            )
            expect(requests).toEqual([])
            expect((yield* providers.get(KeteGateway.providerID))?.settings ?? {}).not.toHaveProperty("apiKey")
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("job mode ignores a configured gateway URL: without KETE_GATEWAY_URL nothing is discovered", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ requests, server }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const providers = yield* Provider.Service
            const config = yield* Config.Test
            yield* seedCatalog()
            yield* config.setEntries([settings({ baseURL: `${server.url.origin}/` }, server.url.origin)])
            yield* addPlugin({ OPENCODE_JOB_MODE: "1" }, undefined, () => "job-descriptor-key")
            expect(requests).toEqual([])
            expect(yield* providers.get(KeteGateway.providerID)).toBeUndefined()
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("outside job mode the injected job key is never used", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ requests, server }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const models = yield* Model.Service
            yield* seedCatalog()
            yield* addPlugin(
              { [KeteGateway.urlVariable]: server.url.origin, [KeteGateway.keyVariable]: "env-key" },
              undefined,
              () => "job-descriptor-key",
            )
            yield* eventually(
              models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
              (model) => model !== undefined,
            )
            expect(requests.find((request) => request.path === "/anthropic/v1/models")?.headers["x-api-key"]).toBe(
              "env-key",
            )
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("falls back to hand configuration when the account's key is gone from its store", () =>
    Effect.acquireUseRelease(
      Effect.sync(gateway),
      ({ server }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const providers = yield* Provider.Service
            const models = yield* Model.Service
            const config = yield* Config.Test
            yield* seedCatalog()
            yield* config.setEntries([settings({ baseURL: `${server.url.origin}/`, apiKey: key })])
            const account = yield* signIn("http://127.0.0.1:9", undefined)
            yield* addPlugin({}, account)

            yield* eventually(
              models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
              (model) => model !== undefined,
            )
            expect((yield* providers.get(KeteGateway.providerID))?.settings).toEqual({ apiKey: key })
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("one provider route failing keeps the others' models", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname
            if (path === "/anthropic/v1/models") return Response.json({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5 (Kete)" }] })
            // OpenAI's route is down (a cold start, an outage): it must not hide Anthropic's models.
            if (path === "/openai/v1/models") return Response.json({ error: { message: "upstream timeout" } }, { status: 504 })
            return Response.json({ error: { message: "Provider is not available." } }, { status: 404 })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: `${server.url.origin}/`, apiKey: key })])
          yield* addPlugin()
          const claude = yield* eventually(
            models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")),
            (model) => model !== undefined,
          )
          expect(claude?.providerID).toBe(KeteGateway.providerID)
          expect(yield* models.get(KeteGateway.providerID, Model.ID.make("gpt-4.1"))).toBeUndefined()
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("a failed first discovery is retried within seconds, not at the next interval", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { failing: true }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname
            if (state.failing) return Response.json({ error: { message: "starting up" } }, { status: 503 })
            if (path === "/anthropic/v1/models") return Response.json({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5 (Kete)" }] })
            return Response.json({ error: { message: "Provider is not available." } }, { status: 404 })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          const config = yield* Config.Test
          yield* seedCatalog()
          yield* config.setEntries([settings({ baseURL: `${server.url.origin}/`, apiKey: key })])
          yield* addPlugin()
          expect(yield* models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5"))).toBeUndefined()
          // The gateway recovers; the plugin's first retry (2 s) picks it up, well before the 1 h interval.
          state.failing = false
          const claude = yield* eventually(
            models.get(KeteGateway.providerID, Model.ID.make("claude-sonnet-4-5")).pipe(
              Effect.tap(() => Effect.promise(() => Bun.sleep(5))),
            ),
            (model) => model !== undefined,
          )
          expect(claude?.providerID).toBe(KeteGateway.providerID)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("does nothing without a gateway URL", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const integrations = yield* Integration.Service
      yield* addPlugin({ [KeteGateway.keyVariable]: key })
      expect(yield* providers.get(KeteGateway.providerID)).toBeUndefined()
      expect(yield* integrations.get(KeteGateway.integrationID)).toBeUndefined()
    }),
  )
})

describe("KeteGateway.configured", () => {
  test("prefers config over the environment and normalises the URL", () => {
    const environment = { [KeteGateway.urlVariable]: "http://env:8787", [KeteGateway.keyVariable]: "env-key" }
    expect(
      KeteGateway.configured([settings({ baseURL: "http://localhost:8787/", apiKey: "config-key" })], environment),
    ).toEqual({
      url: "http://localhost:8787",
      key: "config-key",
      platform: undefined,
      signedIn: false,
    })
    expect(KeteGateway.configured([], environment)).toEqual({
      url: "http://env:8787",
      key: "env-key",
      platform: undefined,
      signedIn: false,
    })
  })

  test("reads the platform URL from config, then the environment", () => {
    const environment = { [KeteGateway.platformVariable]: "http://env-platform:3000/" }
    expect(KeteGateway.configured([settings({}, "https://platform.example/")], environment).platform).toBe(
      "https://platform.example",
    )
    expect(KeteGateway.configured([], environment).platform).toBe("http://env-platform:3000")
  })

  test("prefers a signed-in account over config and the environment", () => {
    const environment = { [KeteGateway.urlVariable]: "http://env:8787", [KeteGateway.keyVariable]: "env-key" }
    const account = KeteAccount.Account.make({
      version: 1,
      platform_url: "https://platform.example/",
      gateway_url: "https://gateway.example/",
      organization: { id: "o", name: "Acme" },
      key_id: "k",
      device_name: "laptop",
      storage: "keychain",
      created_at: "2026-09-25T00:00:00.000Z",
    })
    expect(
      KeteGateway.configured(
        [settings({ baseURL: "http://localhost:8787/", apiKey: "config-key" }, "http://config-platform")],
        environment,
        { account, key: "account-key" },
      ),
    ).toEqual({
      url: "https://gateway.example",
      key: "account-key",
      platform: "https://platform.example",
      signedIn: true,
    })
  })

  test("job mode: the job key only; URLs from the environment only, configured URLs ignored", () => {
    const environment = {
      [KeteGateway.urlVariable]: "http://env:8787",
      [KeteGateway.keyVariable]: "env-key",
      [KeteGateway.platformVariable]: "https://env-platform.example/",
    }
    const entries = [
      settings({ baseURL: "https://config-gateway.example/", apiKey: "config-key" }, "https://config-platform.example/"),
    ]
    expect(KeteGateway.configured(entries, environment, undefined, { key: "job-key" })).toEqual({
      url: "http://env:8787",
      key: "job-key",
      platform: "https://env-platform.example",
      signedIn: false,
    })
    expect(KeteGateway.configured(entries, {}, undefined, { key: "job-key" })).toEqual({
      url: undefined,
      key: "job-key",
      platform: undefined,
      signedIn: false,
    })
    expect(KeteGateway.configured(entries, environment, undefined, { key: undefined }).key).toBeUndefined()
  })

  test("drops URLs that are not HTTP(S)", () => {
    expect(KeteGateway.configured([], { [KeteGateway.urlVariable]: "file:///etc/passwd" }).url).toBeUndefined()
    expect(KeteGateway.configured([], { [KeteGateway.urlVariable]: "not a url" }).url).toBeUndefined()
    expect(KeteGateway.configured([], {})).toEqual({
      url: undefined,
      key: undefined,
      platform: undefined,
      signedIn: false,
    })
  })
})
