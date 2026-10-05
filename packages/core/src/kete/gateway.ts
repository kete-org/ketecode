// Kete Gateway client: offers the models a Kete Model Gateway allows, as provider `kete`.
//
// The gateway (kete-code-platform, apps/gateway) is a native passthrough: each provider
// keeps its own API under its own route prefix, and `GET <prefix>/models` returns the
// Kete allowlist for that provider. So each discovered model reuses the catalog
// definition of its source provider (package, limits, capabilities) and only points its
// base URL at the matching gateway route. See docs/adr/0004-gateway-client.md.
//
// Configuration, all optional; without a gateway URL this plugin does nothing:
// - Signed in with `kete login`: the account's gateway URL, key and platform URL (see
//   @opencode/util/kete/account) take precedence over everything below.
// - URL: `providers.kete.settings.baseURL` (the gateway root), else `KETE_GATEWAY_URL`.
// - Key: `kete auth login` ("Kete Gateway"), else `providers.kete.settings.apiKey`,
//   else `KETE_GATEWAY_KEY`.
// - Prices: with a platform URL (`kete.platform.url`, else `KETE_PLATFORM_URL`), gateway
//   models use the prices from the platform's `GET /api/v1/models` instead of the catalog's,
//   and the account balance from `GET /api/v1/me` is published as the `kete` integration's
//   metadata (`balance_micros`, `currency`, `organization`) for clients to show.
// - Job mode (KETE_JOB_MODE, job mode piece A1, D2): the key `kete job run` read from its descriptor
//   (KETE_JOB_GATEWAY_KEY_FD, held in memory by @opencode/util/kete/job-secrets) is the only key.
//   No account is read, and `kete auth login` keys, `providers.kete.settings.apiKey` and
//   `KETE_GATEWAY_KEY` are all ignored, so every model call is metered on the job's key. The
//   gateway and platform URLs come only from the entrypoint's KETE_GATEWAY_URL / KETE_PLATFORM_URL;
//   `providers.kete.settings.baseURL` and `kete.platform.url` are ignored too.
// The env bridge renames KETE_* to OPENCODE_* before plugins run, hence the names below.

export * as KeteGateway from "./gateway.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { KeteAccount } from "@opencode/util/kete/account"
import { Brand } from "@opencode/util/kete/brand"
import { KeteHttpURL } from "@opencode/util/kete/http-url"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import { Duration, Effect, Schedule, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../config.js"
import { Integration } from "../integration.js"
import { Model } from "../model.js"
import type { PluginInternal } from "../plugin/internal.js"
import { foldSettings } from "../plugin/provider/configured.js"
import { Provider } from "../provider.js"
import { KeteOffline } from "./offline.js"
import { Money } from "@opencode/schema/money"

export const providerID = Provider.ID.make("kete")
export const integrationID = Integration.ID.make("kete")
export const urlVariable = KeteJobMode.gatewayURLVariable
export const keyVariable = "OPENCODE_GATEWAY_KEY"
export const platformVariable = KeteJobMode.platformURLVariable
const httpURL = KeteHttpURL.normalize

type Listed = { id: string; name?: string; context?: number }
type Route = {
  prefix: string
  catalog: Provider.ID
  auth: (key: string) => Record<string, string>
  parse: (body: unknown) => Listed[]
}
type Discovered = Listed & { route: Route }
type Price = Model.Info["cost"][number]

const AnthropicList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, display_name: Schema.String.pipe(Schema.optional) })),
})
// kete-code-platform docs/platform-api.md, GET /api/v1/models. Prices are micro-USD per million tokens.
const PlatformModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      model_id: Schema.String,
      pricing_micros_per_mtok: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        cache_read: Schema.Finite,
        cache_write: Schema.Finite,
      }),
    }),
  ),
})
// GET /api/v1/me. The balance is integer micro-USD and may be negative.
const PlatformMe = Schema.Struct({
  organization: Schema.Struct({ name: Schema.String }),
  balance_micros: Schema.Finite,
  currency: Schema.String,
})
type Account = { balance_micros: number; currency: string; organization: string }

// The platform names providers as the gateway does; the catalog calls Gemini "google".
const platformRoute = (provider: string) =>
  routes.find((route) => route.catalog === (provider === "gemini" ? "google" : provider))
const usd = (micros: number) => Money.USDPerMillionTokens.make(micros / 1_000_000)

const OpenAIList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })
const GeminiList = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      baseModelId: Schema.String.pipe(Schema.optional),
      displayName: Schema.String.pipe(Schema.optional),
      inputTokenLimit: Schema.Number.pipe(Schema.optional),
    }),
  ),
})

/** The gateway's routes (kete-code-platform docs/gateway.md §1), in model-ID precedence order. */
export const routes: Route[] = [
  {
    prefix: "/anthropic/v1",
    catalog: Provider.ID.make("anthropic"),
    auth: (key: string) => ({ "x-api-key": key }),
    parse: (body: unknown) =>
      Schema.decodeUnknownSync(AnthropicList)(body).data.map((item) => ({ id: item.id, name: item.display_name })),
  },
  {
    prefix: "/openai/v1",
    catalog: Provider.ID.make("openai"),
    auth: (key: string) => ({ authorization: `Bearer ${key}` }),
    parse: (body: unknown) => Schema.decodeUnknownSync(OpenAIList)(body).data.map((item) => ({ id: item.id })),
  },
  {
    prefix: "/gemini/v1beta",
    catalog: Provider.ID.make("google"),
    auth: (key: string) => ({ "x-goog-api-key": key }),
    parse: (body: unknown) =>
      Schema.decodeUnknownSync(GeminiList)(body).models.map((item) => ({
        id: item.baseModelId ?? item.name.replace(/^models\//, ""),
        name: item.displayName,
        context: item.inputTokenLimit,
      })),
  },
  ...(["deepseek", "openrouter"] as const).map((id) => ({
    prefix: `/compat/${id}/v1`,
    catalog: Provider.ID.make(id),
    auth: (key: string) => ({ authorization: `Bearer ${key}` }),
    parse: (body: unknown) => Schema.decodeUnknownSync(OpenAIList)(body).data.map((item) => ({ id: item.id })),
  })),
]

export function make(
  options: {
    readonly interval?: Duration.Input
    readonly balanceInterval?: Duration.Input
    readonly environment?: Record<string, string | undefined>
    /** Where `kete login` keeps the account; tests point this at a temporary directory. */
    readonly account?: KeteAccount.Options
    /** The job's descriptor key (job mode only); tests inject it instead of the write-once holder. */
    readonly jobKey?: () => string | undefined
  } = {},
) {
  const interval = options.interval ?? "5 minutes"
  const balanceInterval = options.balanceInterval ?? "1 minute"
  const environment = options.environment ?? process.env
  const accountOptions = options.account ?? KeteAccount.defaults()
  const jobKey = options.jobKey ?? KeteJobSecrets.gatewayKey
  const jobMode = KeteJobMode.enabled(environment)
  return define({
    id: "kete.provider.gateway",
    effect: Effect.fn(function* (ctx) {
      const http = yield* HttpClient.HttpClient
      const config = yield* Config.Service
      // Offline mode: no gateway models, balance or price requests (docs/local-models.md). Checked on
      // every refresh and balance tick (env flag or the config as loaded now), so turning `kete.offline`
      // on pauses the gateway from its next tick and turning it off resumes it. Models already loaded
      // are removed by KeteOffline's model filter.
      const offline = () => KeteOffline.active(config, environment)
      const signedIn = Effect.fn("KeteGateway.signedIn")(function* () {
        const account = yield* Effect.tryPromise(() => KeteAccount.read(accountOptions))
        if (!account) return undefined
        const key = yield* Effect.tryPromise(() => KeteAccount.key(accountOptions, account))
        if (key !== undefined) return { account, key }
        yield* Effect.logWarning(
          `${Brand.displayName} account key is missing from ${KeteAccount.store(accountOptions, account.storage).description}; run \`${Brand.cliName} login\` again`,
        )
        return undefined
      })
      // An unreadable account or credential store must not take down the plugin: fall back to hand configuration.
      const load = Effect.fn("KeteGateway.load")(function* () {
        // Job mode: the descriptor key only; no account is read (D2).
        if (jobMode) return configured(yield* config.entries(), environment, undefined, { key: jobKey() })
        const account = yield* signedIn().pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`${Brand.displayName} account unavailable`, { cause }).pipe(Effect.as(undefined)),
          ),
        )
        return configured(yield* config.entries(), environment, account)
      })
      const source = { current: yield* load() }
      const loaded = { models: [] as Discovered[], prices: new Map<string, Price>(), hash: "[]" }
      const account = { current: undefined as Account | undefined }
      const lock = Semaphore.makeUnsafe(1)

      yield* ctx.integration.transform((integrations) => {
        if (!source.current.url) return
        integrations.update(integrationID, (integration) => {
          integration.name = `${Brand.displayName} Gateway`
          if (account.current) integration.metadata = { ...integration.metadata, ...account.current }
        })
        integrations.method.update({ integrationID, method: { type: "key", label: `${Brand.displayName} API key` } })
      })

      yield* ctx.provider.transform((providers) => {
        const url = source.current.url
        if (!url || loaded.models.length === 0) return
        providers.update(providerID, (provider) => {
          provider.name = `${Brand.displayName} Gateway`
          provider.activation = "enabled"
          provider.integrationID = integrationID
          provider.settings = source.current.key === undefined ? {} : { apiKey: source.current.key }
        })
        for (const item of loaded.models) {
          const origin = providers.get(item.route.catalog)
          const base = origin?.models.get(Model.ID.make(item.id))
          providers.models.update(providerID, Model.ID.make(item.id), (model) => {
            if (base) Object.assign(model, structuredClone(base))
            model.modelID = Model.ID.make(item.id)
            model.name = item.name ?? base?.name ?? item.id
            model.package = base?.package ?? origin?.provider.package
            model.canonical = origin?.provider.canonical ?? item.route.catalog
            model.settings = Provider.mergeOverlay(model.settings, { baseURL: `${url}${item.route.prefix}` })
            if (item.context !== undefined) model.limit.context = item.context
            const price = loaded.prices.get(`${item.route.prefix} ${item.id}`)
            if (price) model.cost = [price]
          })
        }
      })

      const key = Effect.fn("KeteGateway.key")(function* () {
        const connection = yield* ctx.integration.connection.active(integrationID)
        const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
        // A signed-in account wins over a `kete auth login` key, as over every other hand-configured key.
        // In job mode the job's descriptor key is the only key.
        if (source.current.signedIn || jobMode) return source.current.key
        return credential?.type === "key" ? credential.key : source.current.key
      })

      // One provider's route failing (a slow cold start, a provider outage) keeps that route's last
      // known models and never discards the others; only when every route fails does discovery fail.
      const discover = Effect.fn("KeteGateway.discover")(function* (url: string, apiKey: string) {
        const lists = yield* Effect.forEach(
          routes,
          (route) =>
            http
              .execute(
                HttpClientRequest.get(`${url}${route.prefix}/models`).pipe(
                  HttpClientRequest.acceptJson,
                  HttpClientRequest.setHeaders(route.auth(apiKey)),
                ),
              )
              .pipe(
                // 404: the gateway doesn't serve this provider. Other failures keep the last inventory.
                Effect.flatMap((response) =>
                  response.status === 404
                    ? Effect.succeed([])
                    : HttpClientResponse.filterStatusOk(response).pipe(
                        Effect.flatMap((ok) => ok.json),
                        Effect.flatMap((body) => Effect.try(() => route.parse(body))),
                        Effect.map((items) => items.map((item) => ({ ...item, route }))),
                      ),
                ),
                Effect.timeout("5 seconds"),
                Effect.map((items): Discovered[] | undefined => items),
                Effect.catch((cause) =>
                  Effect.logWarning(`${Brand.displayName} Gateway route ${route.prefix} unavailable; keeping its last models`, {
                    cause,
                  }).pipe(Effect.as(undefined)),
                ),
              ),
          { concurrency: routes.length },
        )
        if (lists.every((list) => list === undefined)) return yield* Effect.fail(new Error("every gateway route failed"))
        const seen = new Set<string>()
        return lists
          .flatMap((list, index) => list ?? loaded.models.filter((item) => item.route.prefix === routes[index]!.prefix))
          .filter((item) => !seen.has(item.id) && seen.add(item.id))
      })

      const pricing = Effect.fn("KeteGateway.pricing")(function* (platform: string, apiKey: string) {
        const body = yield* http
          .execute(
            HttpClientRequest.get(`${platform}/api/v1/models`).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(apiKey),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(PlatformModels)),
            Effect.timeout("5 seconds"),
          )
        return new Map(
          body.models.flatMap((item) => {
            const route = platformRoute(item.provider)
            const price = item.pricing_micros_per_mtok
            return route
              ? [
                  [
                    `${route.prefix} ${item.model_id}`,
                    {
                      input: usd(price.input),
                      output: usd(price.output),
                      cache: { read: usd(price.cache_read), write: usd(price.cache_write) },
                    },
                  ] as const,
                ]
              : []
          }),
        )
      })

      const me = Effect.fn("KeteGateway.me")(function* (platform: string, apiKey: string) {
        const body = yield* http
          .execute(
            HttpClientRequest.get(`${platform}/api/v1/me`).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(apiKey),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(PlatformMe)),
            Effect.timeout("5 seconds"),
          )
        return { balance_micros: body.balance_micros, currency: body.currency, organization: body.organization.name }
      })

      // The balance changes with every request, so it refreshes more often than the model list.
      const balance = Effect.fn("KeteGateway.balance")(function* () {
        if (yield* offline()) return
        const platform = source.current.platform
        const apiKey = yield* key()
        const next = platform && apiKey ? yield* me(platform, apiKey) : undefined
        if (source.current.platform !== platform) return
        if (JSON.stringify(next) === JSON.stringify(account.current)) return
        account.current = next
        yield* ctx.integration.reload()
      })

      const refresh = Effect.fn("KeteGateway.refresh")(function* () {
        if (yield* offline()) return
        const url = source.current.url
        const platform = source.current.platform
        const apiKey = yield* key()
        if (!url || !apiKey) return
        const models = yield* lock.withPermit(discover(url, apiKey))
        // Prices are optional: without the platform, models keep their catalog prices.
        const prices = platform
          ? yield* pricing(platform, apiKey).pipe(
              Effect.catch((cause) =>
                Effect.logWarning(`${Brand.displayName} platform prices unavailable`, { cause }).pipe(
                  Effect.as(loaded.prices),
                ),
              ),
            )
          : new Map<string, Price>()
        if (source.current.url !== url) return
        const hash = JSON.stringify([
          models.map((item) => [item.route.prefix, item.id, item.name, item.context]),
          Array.from(prices),
        ])
        if (hash === loaded.hash) return
        loaded.models = models
        loaded.prices = prices
        loaded.hash = hash
        yield* ctx.provider.reload()
      })

      // Keep the last successful inventory through transient outages instead of flickering model availability.
      const logged = refresh().pipe(
        Effect.catch((cause) => Effect.logWarning(`${Brand.displayName} Gateway model discovery failed`, { cause })),
      )
      // Wait for the first discovery (bounded by the request timeout), so a command run right after the
      // service starts can use gateway models. If it fails, retry soon (2, 4, 8 s) in the background
      // rather than leaving gateway models unavailable until the next interval.
      const first = yield* refresh().pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning(`${Brand.displayName} Gateway model discovery failed; retrying shortly`, { cause }).pipe(Effect.as(false)),
        ),
      )
      const retries = first
        ? Effect.void
        : Effect.gen(function* () {
            for (const seconds of [2, 4, 8]) {
              yield* Effect.sleep(`${seconds} seconds`)
              const ok = yield* refresh().pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              )
              if (ok) return
            }
            yield* Effect.logWarning(`${Brand.displayName} Gateway model discovery still failing; next try in ${Duration.format(Duration.fromInputUnsafe(interval))}`)
          })
      yield* retries.pipe(
        Effect.andThen(Effect.sleep(interval)),
        Effect.andThen(logged.pipe(Effect.repeat(Schedule.spaced(interval)))),
        Effect.forkScoped,
      )
      // A failed balance check keeps the last known balance.
      const balanced = balance().pipe(
        Effect.catch((cause) => Effect.logWarning(`${Brand.displayName} balance unavailable`, { cause })),
      )
      yield* balanced.pipe(Effect.repeat(Schedule.spaced(balanceInterval)), Effect.forkScoped)

      const reload = Effect.fn("KeteGateway.reload")(function* () {
        const next = yield* load()
        if (
          next.url === source.current.url &&
          next.key === source.current.key &&
          next.platform === source.current.platform &&
          next.signedIn === source.current.signedIn
        )
          return
        source.current = next
        loaded.models = []
        loaded.prices = new Map()
        account.current = undefined
        loaded.hash = "[]"
        yield* ctx.integration.reload()
        yield* ctx.provider.reload()
        yield* logged
      })
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) =>
          ["config.updated", "integration.updated", "credential.updated", "credential.switched"].includes(event.type),
        ),
        Stream.runForEach((event) =>
          event.type === "config.updated" ? reload().pipe(Effect.andThen(balanced)) : Effect.andThen(logged, balanced),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    }),
  } satisfies PluginInternal.InternalPlugin)
}

export const Plugin = make()

/**
 * Gateway URL, key and platform URL: from the signed-in account when there is one, else from config,
 * falling back to the environment. URLs are normalised or dropped. With `job` (job mode), the key is
 * `job.key` and the URLs come from the environment only — configured keys and URLs are ignored.
 */
export function configured(
  entries: readonly Entry[],
  environment: Record<string, string | undefined>,
  signedIn?: { account: KeteAccount.Account; key: string },
  job?: { readonly key: string | undefined },
) {
  if (signedIn)
    return {
      url: httpURL(signedIn.account.gateway_url),
      key: signedIn.key,
      platform: httpURL(signedIn.account.platform_url),
      signedIn: true,
    }
  // Job mode: the key from the descriptor, the URLs from the entrypoint's environment only
  // (KETE_GATEWAY_URL / KETE_PLATFORM_URL); configured keys and URLs are ignored.
  if (job)
    return {
      url: KeteJobMode.endpoints(environment).gateway,
      key: job.key,
      platform: KeteJobMode.endpoints(environment).platform,
      signedIn: false,
    }
  const settings = foldSettings(entries, providerID, undefined)
  const key =
    typeof settings?.apiKey === "string" && settings.apiKey !== ""
      ? settings.apiKey
      : environment[keyVariable] || undefined
  return {
    url: httpURL(typeof settings?.baseURL === "string" ? settings.baseURL : environment[urlVariable]),
    key,
    platform: httpURL(Config.latest(entries, "kete")?.platform?.url ?? environment[platformVariable]),
    signedIn: false,
  }
}
