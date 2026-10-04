// Local model servers (Ollama, LM Studio, vLLM): status, rediscovery, and models that can't call tools
// (docs/local-models.md). Registered in plugin/internal.ts's `post` list, after the config plugins so a
// configured `capabilities.tools` has already been applied.
//
// - RPC `kete.local-models` (`status`, `rediscover`; schema in @opencode/schema/kete/local-models) on
//   the existing `POST /api/rpc/:rpcID/:method`: every client reads the same status. Probing happens
//   only when `status` is called (no background work), 2 s per request, providers concurrently. The
//   status never carries an API key, request headers or URL credentials, and error text is capped.
//   `not_configured` is "no host was set and the default port refuses the connection" — most users
//   have no local server and shouldn't see three warnings (R1); `unreachable` is a host that was set
//   explicitly, or a default port that answers badly or not at all.
// - `rediscover` emits the plugin event `rpc.kete.local-models.rediscover`; the Ollama plugin
//   (plugin/provider/ollama.ts) re-reads its model list when it sees it.
// - A plain-http host that isn't this machine is allowed but logged once per URL: code sent to it
//   crosses the network unencrypted. There is no way to turn TLS verification off here.
// - A model whose `capabilities.tools` is false (discovery, or config's override) runs without
//   tools: the `session.context` hook removes every tool and tells the agent. An unknown model keeps
//   upstream behaviour.
// - Ollama's context window (D4): the OpenAI-compatible endpoint Kete uses can't set `num_ctx`, so a
//   model advertising a large window that Ollama serves smaller gets a warning with the server-side fix.

export * as KeteLocalModels from "./local-models.js"

import { define } from "@opencode/plugin/effect/plugin"
import { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { Brand } from "@opencode/util/kete/brand"
import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "../config.js"
import type { PluginInternal } from "../plugin/internal.js"
import { foldSettings } from "../plugin/provider/configured.js"
import { KeteLocalHosts } from "./local-hosts.js"
import { KeteOffline } from "./offline.js"

export const id = KeteLocalModelsRpc.ID

const providers: readonly KeteLocalHosts.ProviderID[] = ["ollama", "lmstudio", "vllm"]

/** Ollama's default window (in recent versions, for most GPUs) and the point above which a larger
 * advertised window is worth a warning when the served one is unknown. */
export const OLLAMA_SMALL_CONTEXT = 8192

export const noToolsNotice =
  "This model can't call tools in " +
  Brand.displayName +
  ": you can't read or edit files or run commands. Answer from the conversation, and tell the user to switch to a model with tool support for changes."

const hint = (provider: KeteLocalHosts.ProviderID): string => {
  const prefix = Brand.envPrefix
  if (provider === "ollama")
    return `Start it with \`ollama serve\`, or point ${Brand.displayName} at it with ${prefix}OLLAMA_HOST (or OLLAMA_HOST) or providers.ollama.settings.baseURL.`
  if (provider === "lmstudio")
    return `Start LM Studio's local server (\`lms server start\`), or set ${prefix}LMSTUDIO_HOST or providers.lmstudio.settings.baseURL.`
  return `Start \`vllm serve <model>\`, or set ${prefix}VLLM_HOST or providers.vllm.settings.baseURL.`
}

/**
 * The warning for a model whose served context window is smaller than the one it advertises, or
 * undefined. The served window is `num_ctx` from the model's parameters, or the window Ollama
 * reports for a loaded model (`loaded` wins, as it is what is really served). With neither known,
 * only a large advertised window (above 8192) is flagged, as "may serve only the default window".
 */
export function contextWarning(input: {
  readonly model: string
  readonly discovered: number | undefined
  readonly numCtx?: number
  readonly loaded?: number
}): string | undefined {
  const { model, discovered } = input
  if (discovered === undefined || discovered <= 0) return undefined
  const served = input.loaded ?? input.numCtx
  const fix = `Raise it with OLLAMA_CONTEXT_LENGTH (for example 32768) when starting Ollama, or PARAMETER num_ctx in a Modelfile.`
  if (served !== undefined) {
    if (served >= discovered) return undefined
    return `${model} advertises a ${discovered}-token context window but Ollama serves ${served} tokens. ${fix}`
  }
  if (discovered <= OLLAMA_SMALL_CONTEXT) return undefined
  return `${model} advertises a ${discovered}-token context window, but Ollama may serve only its default window (often 4096 tokens). ${fix}`
}

// What we read from each server: only the fields used, so a server adding fields never breaks status.
const Tags = Schema.Struct({ models: Schema.Array(Schema.Struct({ model: Schema.String })) })
const ShowRequest = Schema.Struct({ model: Schema.String })
const Show = Schema.Struct({
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
  parameters: Schema.String.pipe(Schema.optional),
  model_info: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
})
const Ps = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      model: Schema.String.pipe(Schema.optional),
      name: Schema.String.pipe(Schema.optional),
      context_length: Schema.Number.pipe(Schema.optional),
    }),
  ),
})
const LMStudioModels = Schema.Struct({ models: Schema.Array(Schema.Struct({ type: Schema.String })) })
const VLLMModels = Schema.Struct({ data: Schema.Array(Schema.Struct({ owned_by: Schema.String })) })

const decodeTags = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(Tags)(value)
  } catch {
    return undefined
  }
}
const decodeShow = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(Show)(value)
  } catch {
    return undefined
  }
}
const decodePs = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(Ps)(value)
  } catch {
    return undefined
  }
}
const decodeLMStudio = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(LMStudioModels)(value)
  } catch {
    return undefined
  }
}
const decodeVLLM = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(VLLMModels)(value)
  } catch {
    return undefined
  }
}

type Failure = { readonly kind: "transport" | "timeout" | "http" | "invalid"; readonly message: string }
type Fetched = { readonly kind: "ok"; readonly body: unknown } | Failure

/** Error text for a client: credentials in URLs removed, never headers, capped. */
function clean(text: string): string {
  const redacted = text.replace(/\/\/[^/@\s]*@/g, "//").replace(/\s+/g, " ").trim()
  return redacted.length > KeteLocalModelsRpc.MAX_ERROR
    ? `${redacted.slice(0, KeteLocalModelsRpc.MAX_ERROR - 1)}…`
    : redacted
}

function tagged(error: unknown, tag: string): boolean {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === tag
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return ""
}

type Target = {
  readonly id: KeteLocalHosts.ProviderID
  readonly baseURL: string
  /** Scheme, host, port and any path prefix before `/v1`; undefined when the URL is unusable. */
  readonly root: string | undefined
  readonly apiKey: string | undefined
  readonly source: KeteLocalModelsRpc.Source
}

function target(
  entries: Parameters<typeof foldSettings>[0],
  provider: KeteLocalHosts.ProviderID,
  environment: KeteLocalHosts.Environment,
  defaultOrigin: string | undefined,
): Target {
  const settings = foldSettings(entries, provider, undefined)
  const configured = typeof settings?.baseURL === "string" ? settings.baseURL : undefined
  const resolved = KeteLocalHosts.resolve(provider, environment)
  const origin = resolved.source === "default" && defaultOrigin !== undefined ? defaultOrigin : resolved.origin
  const baseURL = (configured ?? `${origin}/v1`).replace(/\/+$/, "")
  const apiKey = typeof settings?.apiKey === "string" && settings.apiKey !== "" ? settings.apiKey : undefined
  const source = configured !== undefined ? "config" : resolved.source
  if (!URL.canParse(baseURL)) return { id: provider, baseURL, root: undefined, apiKey, source }
  const url = new URL(baseURL)
  if (url.protocol !== "http:" && url.protocol !== "https:") return { id: provider, baseURL, root: undefined, apiKey, source }
  const path = url.pathname.replace(/\/+$/, "")
  const prefix = path.endsWith("/v1") ? path.slice(0, -3) : path
  return { id: provider, baseURL, root: `${url.origin}${prefix}`, apiKey, source }
}

function shown(baseURL: string): string {
  return URL.canParse(baseURL) ? KeteLocalHosts.display(baseURL) : clean(baseURL).slice(0, 200)
}

export function make(
  options: {
    readonly environment?: KeteLocalHosts.Environment
    readonly timeout?: Duration.Input
    /** Replaces a provider's default origin (tests point it at a closed port; nothing else sets it). */
    readonly defaultOrigins?: Partial<Record<KeteLocalHosts.ProviderID, string>>
  } = {},
) {
  const environment = options.environment ?? process.env
  const timeout = options.timeout ?? "2 seconds"
  return define({
    id,
    effect: Effect.fn("KeteLocalModels.Plugin")(function* (ctx) {
      const http = yield* HttpClient.HttpClient
      const config = yield* Config.Service
      const warned = new Set<string>()

      const authorize = (request: HttpClientRequest.HttpClientRequest, apiKey: string | undefined) =>
        apiKey ? request.pipe(HttpClientRequest.bearerToken(apiKey)) : request

      // Never fails: every outcome, including a timeout or a dropped connection, is a value.
      const fetchJson = (
        build: Effect.Effect<HttpClientRequest.HttpClientRequest, unknown>,
      ): Effect.Effect<Fetched> =>
        build.pipe(
          Effect.flatMap((request) => http.execute(request)),
          Effect.flatMap(
            (response): Effect.Effect<Fetched> =>
              response.status >= 200 && response.status < 300
                ? response.json.pipe(
                    Effect.map((body): Fetched => ({ kind: "ok", body })),
                    Effect.catch(() =>
                      Effect.succeed<Fetched>({ kind: "invalid", message: "the server's answer wasn't what was expected" }),
                    ),
                  )
                : Effect.succeed<Fetched>({ kind: "http", message: `the server answered HTTP ${response.status}` }),
          ),
          Effect.timeout(timeout),
          Effect.catch((error): Effect.Effect<Fetched> => {
            if (tagged(error, "TimeoutError"))
              return Effect.succeed({
                kind: "timeout",
                message: `no answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
              })
            const reason = clean(messageOf(error))
            return Effect.succeed({ kind: "transport", message: reason === "" ? "can't connect" : `can't connect: ${reason}` })
          }),
        )

      const get = (url: string, apiKey: string | undefined) =>
        fetchJson(Effect.succeed(authorize(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson), apiKey)))

      type Result =
        | {
            readonly kind: "ok"
            readonly models: number
            readonly contextWarnings: readonly KeteLocalModelsRpc.ContextWarning[]
          }
        | Failure

      const ollama = Effect.fn("KeteLocalModels.ollama")(function* (item: Target & { readonly root: string }) {
        const tags = yield* get(`${item.root}/api/tags`, item.apiKey)
        if (tags.kind !== "ok") return tags satisfies Failure as Result
        const listed = decodeTags(tags.body)
        if (!listed) return { kind: "invalid", message: "the server's model list wasn't what was expected" } as Result
        const ps = yield* get(`${item.root}/api/ps`, item.apiKey)
        const loaded = new Map<string, number>()
        const psModels = ps.kind === "ok" ? decodePs(ps.body) : undefined
        for (const model of psModels?.models ?? []) {
          if (model.context_length === undefined) continue
          for (const name of [model.model, model.name]) if (name) loaded.set(name, model.context_length)
        }
        const shows = yield* Effect.forEach(
          listed.models.filter((model) => model.model.length > 0),
          (model) =>
            fetchJson(
              HttpClientRequest.post(`${item.root}/api/show`).pipe(
                HttpClientRequest.acceptJson,
                (request) => authorize(request, item.apiKey),
                HttpClientRequest.schemaBodyJson(ShowRequest)({ model: model.model }),
              ),
            ).pipe(Effect.map((fetched) => ({ name: model.model, show: fetched.kind === "ok" ? decodeShow(fetched.body) : undefined }))),
          { concurrency: 4 },
        )
        const usable = shows.flatMap((entry) =>
          entry.show !== undefined && (entry.show.capabilities?.includes("completion") ?? false)
            ? [{ name: entry.name, show: entry.show }]
            : [],
        )
        const contextWarnings: KeteLocalModelsRpc.ContextWarning[] = []
        for (const entry of usable.toSorted((a, b) => a.name.localeCompare(b.name))) {
          const discovered = Object.entries(entry.show.model_info ?? {}).flatMap(([key, value]) =>
            key.endsWith(".context_length") && typeof value === "number" && value > 0 ? [value] : [],
          )[0]
          const numCtx = /^\s*num_ctx\s+([0-9]+)/m.exec(entry.show.parameters ?? "")?.[1]
          const running = loaded.get(entry.name)
          const message = contextWarning({
            model: entry.name,
            discovered,
            ...(numCtx !== undefined ? { numCtx: Number(numCtx) } : {}),
            ...(running !== undefined ? { loaded: running } : {}),
          })
          if (message) contextWarnings.push({ model: entry.name, message })
        }
        return { kind: "ok", models: usable.length, contextWarnings } as Result
      })

      const lmstudio = Effect.fn("KeteLocalModels.lmstudio")(function* (item: Target & { readonly root: string }) {
        const fetched = yield* get(`${item.root}/api/v1/models`, item.apiKey)
        if (fetched.kind !== "ok") return fetched satisfies Failure as Result
        const listed = decodeLMStudio(fetched.body)
        if (!listed) return { kind: "invalid", message: "the server's model list wasn't what was expected" } as Result
        return { kind: "ok", models: listed.models.filter((model) => model.type === "llm").length, contextWarnings: [] } as Result
      })

      const vllm = Effect.fn("KeteLocalModels.vllm")(function* (item: Target & { readonly root: string }) {
        const health = yield* fetchJson(
          Effect.succeed(authorize(HttpClientRequest.get(`${item.root}/health`).pipe(HttpClientRequest.acceptJson), item.apiKey)),
        ).pipe(
          // /health answers 200 with an empty body: reaching it with a success status is all that matters.
          Effect.map((fetched): Fetched => (fetched.kind === "invalid" ? { kind: "ok", body: undefined } : fetched)),
        )
        if (health.kind !== "ok") return health satisfies Failure as Result
        const fetched = yield* get(`${item.baseURL}/models`, item.apiKey)
        if (fetched.kind !== "ok") return fetched satisfies Failure as Result
        const listed = decodeVLLM(fetched.body)
        if (!listed) return { kind: "invalid", message: "the server's model list wasn't what was expected" } as Result
        return { kind: "ok", models: listed.data.filter((model) => model.owned_by === "vllm").length, contextWarnings: [] } as Result
      })

      const probe = Effect.fn("KeteLocalModels.probe")(function* (item: Target) {
        const base = {
          id: item.id,
          url: shown(item.baseURL),
          source: item.source,
          insecure: KeteLocalHosts.insecure(item.baseURL),
          hint: hint(item.id),
        }
        const root = item.root
        if (root === undefined) {
          const invalid: KeteLocalModelsRpc.ProviderStatus = {
            ...base,
            state: "unreachable",
            error: "the configured base URL isn't a valid http(s) URL",
          }
          return invalid
        }
        const usable = { ...item, root }
        const result: Result = yield* item.id === "ollama"
          ? ollama(usable)
          : item.id === "lmstudio"
            ? lmstudio(usable)
            : vllm(usable)
        const out: KeteLocalModelsRpc.ProviderStatus =
          result.kind === "ok"
            ? {
                ...base,
                state: "reachable",
                models: result.models,
                ...(result.contextWarnings.length > 0 ? { contextWarnings: result.contextWarnings } : {}),
              }
            : // Nobody listening on a port we guessed is the normal case, not a problem to report.
              item.source === "default" && result.kind === "transport"
              ? { ...base, state: "not_configured" }
              : { ...base, state: "unreachable", error: clean(result.message) }
        return out
      })

      // Once per URL per activation: a plain-http host that isn't this machine.
      const warnInsecure = (items: readonly Target[]) =>
        Effect.forEach(
          items.filter((item) => KeteLocalHosts.insecure(item.baseURL) && !warned.has(`insecure ${shown(item.baseURL)}`)),
          (item) => {
            const url = shown(item.baseURL)
            warned.add(`insecure ${url}`)
            return Effect.logWarning(
              `${item.id} at ${url} uses plain http to a host that isn't this machine: code sent to it crosses the network unencrypted. Put it behind https if that matters.`,
            )
          },
          { discard: true },
        )

      const targets = Effect.fn("KeteLocalModels.targets")(function* () {
        const entries = yield* config.entries()
        return {
          kete: Config.latest(entries, "kete"),
          items: providers.map((provider) => target(entries, provider, environment, options.defaultOrigins?.[provider])),
        }
      })

      // A host variable that can't be read is skipped by the provider plugin: say so once.
      const invalid = new Set(providers.flatMap((provider) => KeteLocalHosts.resolve(provider, environment).invalid))
      yield* Effect.forEach(
        [...invalid],
        (variable) =>
          Effect.logWarning(`Ignoring ${variable}: not a valid host (use host, host:port or http(s)://host[:port])`),
        { discard: true },
      )
      yield* warnInsecure((yield* targets()).items)

      const status = Effect.fn("KeteLocalModels.status")(function* () {
        const current = yield* targets()
        yield* warnInsecure(current.items)
        const items = yield* Effect.forEach(current.items, probe, { concurrency: providers.length })
        for (const item of items)
          for (const warning of item.state === "reachable" ? (item.contextWarnings ?? []) : []) {
            const key = `context ${item.url} ${warning.model}`
            if (warned.has(key)) continue
            warned.add(key)
            yield* Effect.logWarning(warning.message)
          }
        return { offline: KeteOffline.enabled(environment, current.kete), providers: items }
      })

      const emitter: { current?: (provider: KeteLocalModelsRpc.ProviderID) => Effect.Effect<void, unknown> } = {}
      const registration = yield* ctx.rpc
        .register(KeteLocalModelsRpc.Definition, {
          status: () => status().pipe(Effect.orDie),
          rediscover: (input) =>
            Effect.forEach(
              input.provider === undefined ? providers : [input.provider],
              (provider) => emitter.current?.(provider) ?? Effect.void,
              { discard: true },
            ).pipe(Effect.orDie),
        })
        .pipe(Effect.orDie)
      emitter.current = (provider) => registration.events.emit("rediscover", { provider })

      // Which models can call tools, as of the final model list (after config overrides).
      const tools = new Map<string, boolean>()
      const key = (providerID: string, modelID: string) => `${providerID}/${modelID}`
      yield* ctx.model.transform((models) => {
        tools.clear()
        for (const model of models.list()) tools.set(key(model.providerID, model.id), model.capabilities.tools)
      })

      const removeTools =
        (notice: boolean) =>
        (event: {
          readonly model: { readonly providerID: string; readonly id: string }
          readonly system: Array<{ type: "text"; text: string }>
          tools: Record<string, unknown>
        }) =>
          Effect.sync(() => {
            if (tools.get(key(event.model.providerID, event.model.id)) !== false) return
            for (const name of Object.keys(event.tools)) delete event.tools[name]
            if (notice) event.system.push({ type: "text", text: noToolsNotice })
          })
      yield* ctx.session.hook("context", removeTools(true))
      yield* ctx.session.hook("compaction", removeTools(false))
      yield* ctx.session.hook("generate", removeTools(false))
    }),
  } satisfies PluginInternal.InternalPlugin)
}

export const Plugin = make()
