// AC5, end to end: `KeteJobRequest.layer` wraps the real `RequestExecutor` (the same one
// `LayerNodePlatform.requestExecutor` builds outside job mode), over a fake `HttpClient`, so these
// tests prove the wiring — not just each family's pure `conform` (job-request.test.ts) — including
// that a refused request never reaches the fake client at all.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AIError } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { KeteJobRequest } from "@opencode/core/kete/job-request"
import { it } from "../lib/effect"

type Call = { readonly url: string; readonly body: unknown }

function fakeHttpClient(calls: Call[]) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const text = yield* Effect.promise(() => web.text())
        calls.push({ url: request.url, body: text ? (JSON.parse(text) as unknown) : undefined })
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
        )
      }),
    ),
  )
}

const post = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(JSON.stringify(body), "application/json"))

const run = <A, E>(
  calls: Call[],
  limits: KeteJobRequest.Limits,
  effect: Effect.Effect<A, E, RequestExecutor.Service>,
) => effect.pipe(Effect.provide(KeteJobRequest.layer(limits).pipe(Layer.provide(fakeHttpClient(calls)))))

const limits: KeteJobRequest.Limits = { maxOutputTokens: 32_000 }
const messages = [{ role: "user", content: "hi" }]
const contents = [{ role: "user", parts: [{ text: "hi" }] }]

describe("KeteJobRequest.layer, over the real RequestExecutor", () => {
  it.effect("anthropic-messages: sends the conforming (max_tokens-clamped) body to the gateway route", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor.execute(
          post("https://gw.example/anthropic/v1/messages", { model: "claude", messages, max_tokens: 999_999 }),
        )
        expect(calls).toEqual([
          { url: "https://gw.example/anthropic/v1/messages", body: { model: "claude", messages, max_tokens: 32_000 } },
        ])
      }),
    )
  })

  it.effect("openai-responses: forces store: false and clamps max_output_tokens", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor.execute(
          post("https://gw.example/openai/v1/responses", { model: "gpt", input: "hi", store: true }),
        )
        expect(calls[0]!.body).toEqual({ model: "gpt", input: "hi", store: false, max_output_tokens: 32_000 })
      }),
    )
  })

  it.effect("openai-chat: sets max_completion_tokens; the openrouter compat route shares the same rules", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor.execute(
          post("https://gw.example/compat/openrouter/v1/chat/completions", {
            model: "a/b",
            messages,
            usage: { include: true },
          }),
        )
        expect(calls[0]!.body).toEqual({
          model: "a/b",
          messages,
          usage: { include: true },
          max_completion_tokens: 32_000,
        })
      }),
    )
  })

  it.effect("the deepseek compat route is refused (the gateway refuses it for job keys); nothing is sent", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const error = yield* Effect.flip(
          executor.execute(
            post("https://gw.example/compat/deepseek/v1/chat/completions", { model: "deepseek-chat", messages }),
          ),
        )
        expect(error.message).toContain("this route isn't one a job may use")
        expect(calls).toHaveLength(0)
      }),
    )
  })

  it.effect("a disallowed anthropic-beta value or query parameter is refused; nothing is sent", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const beta = post("https://gw.example/anthropic/v1/messages", { model: "claude", messages }).pipe(
          HttpClientRequest.setHeader("anthropic-beta", "interleaved-thinking-2025-05-14,context-1m-2025-08-07"),
        )
        expect((yield* Effect.flip(executor.execute(beta))).message).toContain("context-1m-2025-08-07")
        const query = post("https://gw.example/gemini/v1beta/models/g:streamGenerateContent", {
          contents: [{ parts: [{ text: "hi" }] }],
        }).pipe(HttpClientRequest.setUrlParam("alt", "json"))
        expect((yield* Effect.flip(executor.execute(query))).message).toContain('the query parameter "alt"')
        const openaiBeta = post("https://gw.example/openai/v1/responses", { model: "gpt", input: "hi" }).pipe(
          HttpClientRequest.setHeader("openai-beta", "responses=v1"),
        )
        expect((yield* Effect.flip(executor.execute(openaiBeta))).message).toContain("openai-beta")
        expect(calls).toHaveLength(0)
      }),
    )
  })

  it.effect("gemini: clamps generationConfig.maxOutputTokens", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor.execute(
          post("https://gw.example/gemini/v1beta/models/gemini-2.5-pro:generateContent", {
            contents,
            generationConfig: { maxOutputTokens: 999_999 },
          }),
        )
        expect(calls[0]!.body).toEqual({ contents, generationConfig: { maxOutputTokens: 32_000 } })
      }),
    )
  })

  it.effect("a non-POST request (a media fetch) passes through unchanged", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor.execute(HttpClientRequest.get("https://gw.example/anthropic/files/f1"))
        expect(calls).toHaveLength(1)
        expect(calls[0]!.url).toBe("https://gw.example/anthropic/files/f1")
      }),
    )
  })

  it.effect("a URL image fails with InvalidRequestError, and the fake client sees zero requests", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const body = {
          model: "claude",
          messages: [
            { role: "user", content: [{ type: "image", source: { type: "url", url: "https://evil.example/x.png" } }] },
          ],
        }
        const error = yield* Effect.flip(executor.execute(post("https://gw.example/anthropic/v1/messages", body)))
        expect(error).toBeInstanceOf(AIError)
        expect(error.reason._tag).toBe("InvalidRequest")
        expect(error.message).toContain("this request wasn't sent")
        expect(calls).toHaveLength(0)
      }),
    )
  })

  it.effect("an unrecognized route is refused, and the fake client sees zero requests", () => {
    const calls: Call[] = []
    return run(
      calls,
      limits,
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const error = yield* Effect.flip(
          executor.execute(post("https://gw.example/anthropic/v1/messages/count_tokens", { model: "x" })),
        )
        expect(error).toBeInstanceOf(AIError)
        expect(calls).toHaveLength(0)
      }),
    )
  })

  it.effect("a missing output-token limit refuses every model request and names KETE_JOB_MAX_OUTPUT_TOKENS", () => {
    const calls: Call[] = []
    return run(
      calls,
      { maxOutputTokens: undefined },
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const error = yield* Effect.flip(
          executor.execute(post("https://gw.example/anthropic/v1/messages", { model: "x" })),
        )
        expect(error.message).toContain("KETE_JOB_MAX_OUTPUT_TOKENS")
        expect(calls).toHaveLength(0)
      }),
    )
  })
})
