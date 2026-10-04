// Job-mode request enforcement (D4, D4b; ADR 0020 rules 8, 16, 17): job mode replaces
// `LayerNodePlatform.requestExecutor` with `layer(limits)`, so every model HTTP request — session
// steps, compaction, title, `Generate` (which bypasses session hooks, core/src/generate.ts) and
// image clients — goes through `family`/`conform` before any bytes reach the network. The session
// `http.request` hook can't fail (plugin/hooks.ts, pitfalls.md), so this executor is the one place a
// job-mode request can be refused. Only the `kete` provider's models survive job mode
// (kete/job-plugin.ts), and only their gateway routes are recognized here; a route this module
// doesn't recognize, or a body that isn't JSON, is refused rather than guessed at (CLAUDE.md §10).

export * as KeteJobRequest from "./job-request.js"

import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AIError, InvalidRequestError } from "@opencode/ai"
import {
  RequestExecutor,
  type HttpHandler,
  type HttpMiddleware,
  type Interface as RequestExecutorInterface,
} from "@opencode/ai/route"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobRequestAnthropicMessages } from "./job-request/anthropic-messages.js"
import { KeteJobRequestGemini } from "./job-request/gemini.js"
import { KeteJobRequestOpenAIChat } from "./job-request/openai-chat.js"
import { KeteJobRequestOpenAIResponses } from "./job-request/openai-responses.js"

export type Family = "anthropic-messages" | "openai-responses" | "openai-chat" | "openrouter-chat" | "gemini"

/** Classifies a request by its gateway route path (kete/gateway.ts's `routes`, docs/gateway.md §1)
 * — the wire protocol, not the model name. Only the six routes a job key may use (the gateway's
 * `JOB_ROUTES`, docs/platform/jobs-v1.md): `undefined` for anything else — token counting, the
 * deepseek compat route (the gateway refuses every deepseek route for job keys), an unrecognized
 * route. */
export function family(url: string): Family | undefined {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return undefined
  }
  if (pathname.endsWith("/anthropic/v1/messages")) return "anthropic-messages"
  if (pathname.endsWith("/openai/v1/responses")) return "openai-responses"
  if (pathname.endsWith("/openai/v1/chat/completions")) return "openai-chat"
  if (pathname.endsWith("/compat/openrouter/v1/chat/completions")) return "openrouter-chat"
  if (/\/gemini\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(pathname)) return "gemini"
  return undefined
}

/**
 * `anthropic-beta` values a job request may send (the gateway's `JOB_HEADER_ALLOWLISTS`,
 * docs/gateway.md §2.8): each is one `requiredBetaHeaders` adds
 * (packages/ai/src/protocols/anthropic-messages.ts) and that changes neither price nor what the
 * gateway's schemas admit. Refused: `compact-2026-01-12` (compaction is refused), `context-1m-*`
 * and anything else, such as a beta added through provider settings.
 */
const ANTHROPIC_BETAS: ReadonlySet<string> = new Set([
  "interleaved-thinking-2025-05-14",
  "mid-conversation-output-config-2026-07-01",
  "thinking-binding-controls-2026-08-01",
])

/**
 * Query parameters each route may carry, and their only values. Gemini's `alt=sse` is the one the
 * gateway forwards (and allows only as `sse`); `beta=true` is what the Anthropic route adds for a
 * model whose provider is `anthropic` (the `kete` provider's Anthropic models are, by canonical
 * provider) and the gateway doesn't forward. Anything else is refused, never stripped.
 */
const QUERY_ALLOWLISTS: Readonly<Record<Family, Readonly<Record<string, ReadonlySet<string>>>>> = {
  "anthropic-messages": { beta: new Set(["true"]) },
  "openai-responses": {},
  "openai-chat": {},
  "openrouter-chat": {},
  gemini: { alt: new Set(["sse"]) },
}

/** The headers and query parameters of a job request (the gateway's `checkTransport`): refused,
 * never silently dropped, so the request that leaves is exactly the one that was built. */
export function transportReason(
  kind: Family,
  headers: Readonly<Record<string, string | undefined>>,
  query: Iterable<readonly [string, string]>,
): string | undefined {
  const betas = headers["anthropic-beta"]
  if (betas !== undefined) {
    const entries = betas
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
    const refused = entries.find((entry) => !ANTHROPIC_BETAS.has(entry))
    if (refused !== undefined) return `the anthropic-beta value "${refused}" isn't allowed`
    if (entries.length === 0) return "an empty anthropic-beta header isn't allowed"
  }
  if (headers["openai-beta"] !== undefined) return "the openai-beta header isn't allowed"

  const allowed = QUERY_ALLOWLISTS[kind]
  for (const [name, value] of query) {
    const values = Object.hasOwn(allowed, name) ? allowed[name] : undefined
    if (values === undefined || !values.has(value)) return `the query parameter "${name}" isn't allowed`
  }
  return undefined
}

export interface Limits {
  /** `KeteJobMode.maxOutputTokens()` (D4b); `undefined` refuses every request, naming
   * KETE_JOB_MAX_OUTPUT_TOKENS. */
  readonly maxOutputTokens: number | undefined
}

const conformers = {
  "anthropic-messages": KeteJobRequestAnthropicMessages.conform,
  "openai-responses": KeteJobRequestOpenAIResponses.conform,
  "openai-chat": KeteJobRequestOpenAIChat.conform,
  "openrouter-chat": (body: Record<string, unknown>, limits: { readonly maxOutputTokens: number }) =>
    KeteJobRequestOpenAIChat.conform(body, { ...limits, openrouter: true }),
  gemini: KeteJobRequestGemini.conform,
} as const

function refusal(reason: string): AIError {
  return new AIError({ reason: new InvalidRequestError({ message: `Job mode: ${reason}; this request wasn't sent` }) })
}

/** Non-POST requests (media fetches, which go through the VM's proxy allowlist) pass through
 * unchanged. A POST is classified, parsed as JSON, run through its family's `conform`, and either
 * refused or rewritten with the conforming body. */
const check = (
  request: HttpClientRequest.HttpClientRequest,
  limits: Limits,
): Effect.Effect<HttpClientRequest.HttpClientRequest, AIError> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return request
    if (limits.maxOutputTokens === undefined)
      return yield* Effect.fail(refusal(`${KeteJobMode.maxOutputTokensPublicName} must be set`))
    const kind = family(request.url)
    if (kind === undefined) return yield* Effect.fail(refusal("this route isn't one a job may use"))
    const transport = transportReason(kind, request.headers, [
      ...new URL(request.url).searchParams,
      ...request.urlParams,
    ])
    if (transport !== undefined) return yield* Effect.fail(refusal(transport))
    if (request.body._tag !== "Uint8Array") return yield* Effect.fail(refusal("the request body isn't JSON"))
    const text = new TextDecoder().decode(request.body.body)
    const parsed = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => undefined }).pipe(
      Effect.catch(() => Effect.fail(refusal("the request body isn't JSON"))),
    )
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return yield* Effect.fail(refusal("the request body isn't JSON"))
    const conformed = conformers[kind](parsed as Record<string, unknown>, { maxOutputTokens: limits.maxOutputTokens })
    if (!conformed.ok) return yield* Effect.fail(refusal(conformed.reason))
    return HttpClientRequest.bodyText(request, JSON.stringify(conformed.body), "application/json")
  })

/** Wraps a `HttpMiddleware`'s inner handler so the final bytes it hands the network — after
 * whatever the `http.request` hook did — are checked again, not just the initial request. Defence
 * in depth: in job mode the only hooks are internal plugins. `HttpHandler`'s error channel is a
 * plain `Error`, so a refusal is converted at this boundary; `execute` below still fails with the
 * original `AIError`. */
const guard =
  (handler: HttpHandler, limits: Limits): HttpHandler =>
  (request) =>
    check(request, limits).pipe(
      Effect.mapError((error) => new Error(error.message)),
      Effect.flatMap(handler),
    )

const guardMiddleware = (middleware: HttpMiddleware | undefined, limits: Limits): HttpMiddleware | undefined =>
  middleware === undefined ? undefined : (request, handler) => middleware(request, guard(handler, limits))

/** Builds the real executor (`RequestExecutor.layer`) and wraps it so every request is checked, and
 * rewritten, before it reaches the network. */
export function layer(limits: Limits): Layer.Layer<RequestExecutor.Service, never, HttpClient.HttpClient> {
  return Layer.effect(
    RequestExecutor.Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const innerContext = yield* Layer.build(RequestExecutor.layer).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      )
      const inner = Context.get(innerContext, RequestExecutor.Service)
      const execute: RequestExecutorInterface["execute"] = (request, middleware) =>
        Effect.gen(function* () {
          const rewritten = yield* check(request, limits)
          return yield* inner.execute(rewritten, guardMiddleware(middleware, limits))
        })
      return RequestExecutor.Service.of({ execute })
    }),
  )
}
