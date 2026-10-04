// The real wire requests, end to end: each `@opencode/ai` provider package the `kete` provider uses
// (Anthropic, OpenAI Responses and Chat, Gemini, OpenRouter), pointed at a gateway route, builds a
// multi-turn tool-loop request with replayed history; `LLMClient` sends it through
// `KeteJobRequest.layer` over a fake HTTP client. A request that reaches the fake passed every
// local check — the gateway's route, header and query allowlists, pre-checks, output clamp and
// strict schema — so these tests catch drift between what the runtime really sends and what the
// gateway admits for a job key (kete-code-platform `apps/gateway/src/jobs/`).
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMClient, Message, ToolCallPart, ToolDefinition, type LanguageModel } from "@opencode/ai"
import * as Anthropic from "@opencode/ai/providers/anthropic"
import * as Google from "@opencode/ai/providers/google"
import * as OpenAI from "@opencode/ai/providers/openai"
import * as OpenRouter from "@opencode/ai/providers/openrouter"
import { KeteJobRequest } from "@opencode/core/kete/job-request"
import { it } from "../lib/effect"

type Call = { readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }

const gateway = "https://gw.example"
const key = "kete_test_job"

function fakeHttpClient(calls: Call[]) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const text = yield* Effect.promise(() => web.text())
        calls.push({ url: web.url, headers: web.headers, body: JSON.parse(text) as Record<string, unknown> })
        // Any answer ends the call; only the request matters here.
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "stop" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        )
      }),
    ),
  )
}

const tool = ToolDefinition.make({
  name: "read_file",
  description: "Read a file in the working tree.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
})

/** A request with replayed history: text, reasoning (with the provider's replay metadata), a tool
 * call and its result, and a follow-up. */
function request(
  model: LanguageModel,
  reasoning: Record<string, Record<string, unknown>>,
  extra: Partial<Parameters<typeof LLM.request>[0]> = {},
) {
  return LLM.request({
    id: "job_req",
    model,
    system: "You are a careful engineer.",
    tools: [tool],
    generation: { maxTokens: 64_000 },
    messages: [
      Message.user("Fix the failing test."),
      Message.assistant([
        { type: "reasoning", text: "Read the test first.", providerMetadata: reasoning },
        { type: "text", text: "Reading the test." },
        ToolCallPart.make({ id: "call_1", name: "read_file", input: { path: "test/a.test.ts" } }),
      ]),
      Message.tool({ id: "call_1", name: "read_file", result: "expect(1).toBe(2)" }),
      Message.user("Go on."),
    ],
    ...extra,
  })
}

const withoutReasoning = [
  Message.user("Fix the failing test."),
  Message.assistant([
    { type: "text", text: "Reading the test." },
    ToolCallPart.make({ id: "call_1", name: "read_file", input: { path: "test/a.test.ts" } }),
  ]),
  Message.tool({ id: "call_1", name: "read_file", result: "expect(1).toBe(2)" }),
  Message.user("Go on."),
]

const send = (calls: Call[], llm: ReturnType<typeof LLM.request>) =>
  LLMClient.generate(llm).pipe(
    Effect.exit,
    Effect.provide(
      LLMClient.layer.pipe(
        Layer.provide(KeteJobRequest.layer({ maxOutputTokens: 32_000 }).pipe(Layer.provide(fakeHttpClient(calls)))),
      ),
    ),
  )

describe("job-mode wire requests from the real provider packages", () => {
  it.effect(
    "Anthropic: sent with the allowed beta, beta=true, max_tokens clamped and the thinking budget lowered",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = []
        const model = Anthropic.model("claude-sonnet-4-5", { apiKey: key, baseURL: `${gateway}/anthropic/v1` })
        yield* send(
          calls,
          request(
            model,
            { anthropic: { signature: "sig_1" } },
            {
              providerOptions: { thinking: { type: "enabled", budgetTokens: 63_999 } },
            },
          ),
        )
        expect(calls).toHaveLength(1)
        const call = calls[0]!
        expect(new URL(call.url).pathname).toBe("/anthropic/v1/messages")
      // The kete provider's Anthropic models have canonical provider "anthropic", so the route adds it.
      expect(new URL(call.url).search).toBe("?beta=true")
        expect(call.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
        expect(call.body["max_tokens"]).toBe(32_000)
        expect(call.body["thinking"]).toEqual({ type: "enabled", budget_tokens: 31_999 })
      }),
  )

  it.effect("Anthropic: a disallowed beta from provider headers is refused before anything is sent", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const model = Anthropic.model("claude-sonnet-4-5", {
        apiKey: key,
        baseURL: `${gateway}/anthropic/v1`,
        headers: { "anthropic-beta": "context-1m-2025-08-07" },
      })
      const exit = yield* send(calls, request(model, { anthropic: { signature: "sig_1" } }))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("context-1m-2025-08-07")
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect("OpenAI Responses: sent with store false and max_output_tokens clamped", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const model = OpenAI.model("gpt-5.5", { apiKey: key, baseURL: `${gateway}/openai/v1` })
      yield* send(calls, request(model, { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" } }))
      expect(calls).toHaveLength(1)
      expect(new URL(calls[0]!.url).pathname).toBe("/openai/v1/responses")
      expect(calls[0]!.headers.get("openai-beta")).toBeNull()
      expect(calls[0]!.body["store"]).toBe(false)
      expect(calls[0]!.body["max_output_tokens"]).toBe(32_000)
    }),
  )

  it.effect("OpenAI Chat: sent with the output limit clamped", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const model = OpenAI.chatModel("gpt-4.1", { apiKey: key, baseURL: `${gateway}/openai/v1` })
      // Native OpenAI Chat streams no reasoning, so a job's own history has none to replay.
      yield* send(calls, request(model, {}, { messages: withoutReasoning }))
      expect(calls).toHaveLength(1)
      expect(new URL(calls[0]!.url).pathname).toBe("/openai/v1/chat/completions")
      const outputs = [calls[0]!.body["max_completion_tokens"], calls[0]!.body["max_tokens"]].filter(
        (v) => v !== undefined,
      )
      expect(outputs).toEqual([32_000])
    }),
  )

  it.effect(
    "OpenAI Chat: replayed reasoning lowers to reasoning_content, which the gateway refuses, so it fails locally",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = []
        const model = OpenAI.chatModel("gpt-4.1", { apiKey: key, baseURL: `${gateway}/openai/v1` })
        const exit = yield* send(calls, request(model, {}))
        expect(String(exit)).toContain("messages[2].reasoning_content isn't allowed")
        expect(calls).toHaveLength(0)
      }),
  )

  it.effect("OpenRouter: sent with its reasoning budget lowered below the clamped output", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const model = OpenRouter.model("anthropic/claude-sonnet-4.6", {
        apiKey: key,
        baseURL: `${gateway}/compat/openrouter/v1`,
        reasoning: { max_tokens: 40_000 },
      })
      yield* send(calls, request(model, {}))
      expect(calls).toHaveLength(1)
      expect(new URL(calls[0]!.url).pathname).toBe("/compat/openrouter/v1/chat/completions")
      expect(calls[0]!.body["max_completion_tokens"]).toBe(32_000)
      expect(calls[0]!.body["reasoning"]).toEqual({ max_tokens: 31_999 })
    }),
  )

  it.effect("Gemini: sent with alt=sse only, and replayed history carries no null field", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const model = Google.model("gemini-3-pro-preview", { apiKey: key, baseURL: `${gateway}/gemini/v1beta` })
      yield* send(calls, request(model, { google: { thoughtSignature: "sig_g" } }))
      expect(calls).toHaveLength(1)
      const url = new URL(calls[0]!.url)
      expect(url.pathname).toBe("/gemini/v1beta/models/gemini-3-pro-preview:streamGenerateContent")
      expect([...url.searchParams]).toEqual([["alt", "sse"]])
      expect(JSON.stringify(calls[0]!.body)).not.toContain("null")
      expect((calls[0]!.body["generationConfig"] as Record<string, unknown>)["maxOutputTokens"]).toBe(32_000)
    }),
  )
})
