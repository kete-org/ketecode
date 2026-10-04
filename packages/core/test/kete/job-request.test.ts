// Pure tests for job-mode request enforcement (ADR 0020 rules 8, 16–18): `family`'s URL
// classification, `transportReason`'s header and query allowlists, and each protocol's `conform`
// (the gateway's pre-checks, the output clamp, the thinking budget and its strict schema). The
// bodies produced by the real `@opencode/ai` protocol adapters, through `KeteJobRequest.layer`, are
// checked in job-request-service.test.ts and job-request-wire.test.ts.
import { describe, expect, test } from "bun:test"
import { KeteJobRequest } from "@opencode/core/kete/job-request"
import { KeteJobRequestAnthropicMessages } from "@opencode/core/kete/job-request/anthropic-messages"
import { KeteJobRequestGemini } from "@opencode/core/kete/job-request/gemini"
import { KeteJobRequestOpenAIChat } from "@opencode/core/kete/job-request/openai-chat"
import { KeteJobRequestOpenAIResponses } from "@opencode/core/kete/job-request/openai-responses"

describe("KeteJobRequest.family", () => {
  test("classifies each job route by its wire protocol", () => {
    expect(KeteJobRequest.family("https://gw.example/anthropic/v1/messages")).toBe("anthropic-messages")
    expect(KeteJobRequest.family("https://gw.example/anthropic/v1/messages?beta=true")).toBe("anthropic-messages")
    expect(KeteJobRequest.family("https://gw.example/openai/v1/responses")).toBe("openai-responses")
    expect(KeteJobRequest.family("https://gw.example/openai/v1/chat/completions")).toBe("openai-chat")
    expect(KeteJobRequest.family("https://gw.example/compat/openrouter/v1/chat/completions")).toBe("openrouter-chat")
    expect(KeteJobRequest.family("https://gw.example/gemini/v1beta/models/gemini-2.5-pro:generateContent")).toBe(
      "gemini",
    )
    expect(KeteJobRequest.family("https://gw.example/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent")).toBe(
      "gemini",
    )
  })

  test("refuses anything else: token counting, the deepseek route, unrecognized routes", () => {
    expect(KeteJobRequest.family("https://gw.example/anthropic/v1/messages/count_tokens")).toBeUndefined()
    expect(KeteJobRequest.family("https://gw.example/gemini/v1beta/models/gemini-2.5-pro:countTokens")).toBeUndefined()
    expect(KeteJobRequest.family("https://gw.example/compat/deepseek/v1/chat/completions")).toBeUndefined()
    expect(KeteJobRequest.family("https://gw.example/openai/v1/models")).toBeUndefined()
    expect(KeteJobRequest.family("not a url")).toBeUndefined()
  })
})

describe("KeteJobRequest.transportReason", () => {
  test("allows the anthropic-beta values the runtime sends, alone or together", () => {
    expect(
      KeteJobRequest.transportReason("anthropic-messages", { "anthropic-beta": "interleaved-thinking-2025-05-14" }, []),
    ).toBeUndefined()
    const all =
      "interleaved-thinking-2025-05-14, mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01"
    expect(KeteJobRequest.transportReason("anthropic-messages", { "anthropic-beta": all }, [])).toBeUndefined()
  })

  test("refuses any other anthropic-beta value, and an empty one", () => {
    expect(
      KeteJobRequest.transportReason(
        "anthropic-messages",
        { "anthropic-beta": "interleaved-thinking-2025-05-14,compact-2026-01-12" },
        [],
      ),
    ).toBe('the anthropic-beta value "compact-2026-01-12" isn\'t allowed')
    expect(
      KeteJobRequest.transportReason("anthropic-messages", { "anthropic-beta": "context-1m-2025-08-07" }, []),
    ).toContain("context-1m-2025-08-07")
    expect(KeteJobRequest.transportReason("anthropic-messages", { "anthropic-beta": " , " }, [])).toBe(
      "an empty anthropic-beta header isn't allowed",
    )
  })

  test("refuses openai-beta whatever its value", () => {
    expect(
      KeteJobRequest.transportReason("openai-responses", { "openai-beta": "responses_websockets=2026-02-06" }, []),
    ).toBe("the openai-beta header isn't allowed")
  })

  test("allows Gemini alt=sse and the Anthropic route's beta=true, nothing else", () => {
    expect(KeteJobRequest.transportReason("gemini", {}, [["alt", "sse"]])).toBeUndefined()
    expect(KeteJobRequest.transportReason("anthropic-messages", {}, [["beta", "true"]])).toBeUndefined()
    expect(KeteJobRequest.transportReason("gemini", {}, [["alt", "json"]])).toBe(
      'the query parameter "alt" isn\'t allowed',
    )
    expect(KeteJobRequest.transportReason("gemini", {}, [["key", "secret"]])).toBe(
      'the query parameter "key" isn\'t allowed',
    )
    expect(KeteJobRequest.transportReason("openai-chat", {}, [["beta", "true"]])).toBe(
      'the query parameter "beta" isn\'t allowed',
    )
  })
})

const limits = { maxOutputTokens: 32_000 }

describe("KeteJobRequestAnthropicMessages.conform", () => {
  const base = { model: "claude", messages: [{ role: "user", content: "hi" }] }
  const conform = (body: Record<string, unknown>) => KeteJobRequestAnthropicMessages.conform(body, limits)

  test("sets max_tokens when absent, clamps it when present", () => {
    expect(conform(base)).toEqual({ ok: true, body: { ...base, max_tokens: 32_000 } })
    expect(conform({ ...base, max_tokens: 100 })).toEqual({ ok: true, body: { ...base, max_tokens: 100 } })
    expect(conform({ ...base, max_tokens: 999_999 })).toEqual({ ok: true, body: { ...base, max_tokens: 32_000 } })
  })

  test("allows a function tool (no type, or type custom); refuses anything else", () => {
    const tool = { name: "a", input_schema: { type: "object" } }
    expect(conform({ ...base, tools: [tool, { ...tool, name: "b", type: "custom" }] }).ok).toBe(true)
    expect(conform({ ...base, tools: [{ ...tool, type: "bash_20250124" }] })).toEqual({
      ok: false,
      reason: 'tool type "bash_20250124" isn\'t a function tool',
    })
  })

  test("refuses background, mcp_servers and container", () => {
    expect(conform({ ...base, background: true }).ok).toBe(false)
    expect(conform({ ...base, mcp_servers: [] }).ok).toBe(false)
    expect(conform({ ...base, container: "abc" }).ok).toBe(false)
  })

  test("refuses replayed provider-side tool use", () => {
    for (const type of [
      "server_tool_use",
      "mcp_tool_use",
      "mcp_tool_result",
      "container_upload",
      "web_search_tool_result",
    ]) {
      const body = { ...base, messages: [{ role: "assistant", content: [{ type, id: "x" }] }] }
      expect(conform(body)).toEqual({
        ok: false,
        reason: `replaying provider-side tool use ("${type}" block) isn't allowed`,
      })
    }
  })

  test("refuses a url or file inline-content source, at any depth", () => {
    const url = {
      ...base,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x" } }] }],
    }
    expect(conform(url)).toEqual({ ok: false, reason: 'inline content with source.type "url" isn\'t allowed' })
    const nested = {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "document", source: { type: "file", file_id: "f1" } }],
            },
          ],
        },
      ],
    }
    expect(conform(nested).ok).toBe(false)
  })

  test("allows base64 and text inline content", () => {
    const body = {
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
        },
      ],
    }
    expect(conform(body).ok).toBe(true)
  })

  test("lowers a thinking budget below the clamped max_tokens; refuses one that can't fit", () => {
    const enabled = (budget: number) => ({ type: "enabled", budget_tokens: budget })
    expect(conform({ ...base, max_tokens: 64_000, thinking: enabled(16_000) })).toEqual({
      ok: true,
      body: { ...base, max_tokens: 32_000, thinking: enabled(16_000) },
    })
    expect(conform({ ...base, max_tokens: 64_000, thinking: enabled(63_999) })).toEqual({
      ok: true,
      body: { ...base, max_tokens: 32_000, thinking: enabled(31_999) },
    })
    expect(conform({ ...base, max_tokens: 1_000, thinking: enabled(4_000) })).toEqual({
      ok: false,
      reason: "max_tokens (1000) must be larger than thinking.budget_tokens",
    })
    expect(conform({ ...base, thinking: { type: "adaptive" } }).ok).toBe(true)
  })

  test("refuses what the gateway's strict schema doesn't admit, naming the path", () => {
    expect(conform({ ...base, service_tier: "priority" })).toEqual({
      ok: false,
      reason: "service_tier isn't allowed (the gateway's job request schema)",
    })
    expect(conform({ ...base, context_management: { edits: [] } }).ok).toBe(false)
    expect(conform({ ...base, inference_geo: "us" }).ok).toBe(false)
    const compaction = { ...base, messages: [{ role: "assistant", content: [{ type: "compaction", content: "x" }] }] }
    expect(conform(compaction)).toEqual({
      ok: false,
      reason: "messages[0].content doesn't have an allowed shape (the gateway's job request schema)",
    })
    const content = {
      ...base,
      messages: [{ role: "user", content: [{ type: "document", source: { type: "content", content: [] } }] }],
    }
    expect(conform(content).ok).toBe(false)
  })
})

describe("KeteJobRequestOpenAIResponses.conform", () => {
  const base = { model: "gpt", input: "hi", store: false }
  const conform = (body: Record<string, unknown>) => KeteJobRequestOpenAIResponses.conform(body, limits)

  test("sets max_output_tokens and forces store: false", () => {
    expect(conform({ model: "gpt", input: "hi" })).toEqual({ ok: true, body: { ...base, max_output_tokens: 32_000 } })
    expect(conform({ ...base, store: true })).toEqual({ ok: true, body: { ...base, max_output_tokens: 32_000 } })
  })

  test("clamps an existing max_output_tokens", () => {
    expect(conform({ ...base, max_output_tokens: 999_999 })).toEqual({
      ok: true,
      body: { ...base, max_output_tokens: 32_000 },
    })
  })

  test("refuses previous_response_id, background and conversation", () => {
    expect(conform({ ...base, previous_response_id: "r1" }).ok).toBe(false)
    expect(conform({ ...base, background: true }).ok).toBe(false)
    expect(conform({ ...base, background: false }).ok).toBe(false)
    expect(conform({ ...base, conversation: "c1" }).ok).toBe(false)
  })

  test("refuses a non-function tool and a hosted tool_choice", () => {
    expect(conform({ ...base, tools: [{ type: "web_search" }] }).ok).toBe(false)
    const fn = { type: "function", name: "f", parameters: { type: "object" } }
    expect(conform({ ...base, tools: [fn] }).ok).toBe(true)
    expect(conform({ ...base, tools: [fn], tool_choice: { type: "function", name: "f" } }).ok).toBe(true)
    expect(conform({ ...base, tool_choice: { type: "web_search_preview" } })).toEqual({
      ok: false,
      reason: 'tool_choice type "web_search_preview" isn\'t a function tool',
    })
    expect(
      conform({ ...base, tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "mcp" }] } }).ok,
    ).toBe(false)
  })

  test("refuses replayed hosted-tool items", () => {
    expect(conform({ ...base, input: [{ type: "web_search_call", id: "w" }] })).toEqual({
      ok: false,
      reason: 'replaying hosted-tool use ("web_search_call" item) isn\'t allowed',
    })
  })

  test("refuses input_file.file_url, any file_id, and a non-data input_image url", () => {
    const user = (part: Record<string, unknown>) => ({
      ...base,
      input: [{ type: "message", role: "user", content: [part] }],
    })
    expect(conform(user({ type: "input_file", file_url: "https://x" })).ok).toBe(false)
    expect(conform(user({ type: "input_file", file_id: "f1" })).ok).toBe(false)
    expect(conform(user({ type: "input_image", image_url: "https://x" })).ok).toBe(false)
    expect(conform(user({ type: "input_image", image_url: "data:image/png;base64,AA==" })).ok).toBe(true)
  })

  test("refuses what the gateway's strict schema doesn't admit", () => {
    expect(conform({ ...base, service_tier: "flex" }).ok).toBe(false)
    expect(conform({ ...base, context_management: [] }).ok).toBe(false)
    expect(conform({ ...base, input: [{ type: "item_reference", id: "i" }] }).ok).toBe(false)
    expect(conform({ ...base, include: ["file_search_call.results"] }).ok).toBe(false)
  })
})

describe("KeteJobRequestOpenAIChat.conform", () => {
  const base = { model: "gpt", messages: [{ role: "user", content: "hi" }] }
  const conform = (body: Record<string, unknown>) => KeteJobRequestOpenAIChat.conform(body, limits)
  const openrouter = (body: Record<string, unknown>) =>
    KeteJobRequestOpenAIChat.conform(body, { ...limits, openrouter: true })

  test("sets max_completion_tokens when both limits are absent", () => {
    expect(conform(base)).toEqual({ ok: true, body: { ...base, max_completion_tokens: 32_000 } })
  })

  test("clamps whichever of max_tokens/max_completion_tokens is present", () => {
    expect(conform({ ...base, max_tokens: 999_999 })).toEqual({ ok: true, body: { ...base, max_tokens: 32_000 } })
    expect(conform({ ...base, max_completion_tokens: 999_999, max_tokens: 999_999 })).toEqual({
      ok: true,
      body: { ...base, max_completion_tokens: 32_000, max_tokens: 32_000 },
    })
  })

  test("refuses web_search_options, an openrouter :online model, plugins and n > 1", () => {
    expect(conform({ ...base, web_search_options: {} }).ok).toBe(false)
    expect(openrouter({ ...base, model: "x:online" }).ok).toBe(false)
    expect(openrouter({ ...base, plugins: [] }).ok).toBe(false)
    expect(conform({ ...base, n: 2 })).toEqual({ ok: false, reason: "n must be 1" })
    expect(conform({ ...base, n: 1 }).ok).toBe(true)
  })

  test("refuses a non-function tool", () => {
    expect(conform({ ...base, tools: [{ type: "custom" }] }).ok).toBe(false)
  })

  test("refuses file_id and a non-data image_url.url, at any depth", () => {
    const image = (url: string) => ({
      ...base,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    })
    expect(conform(image("https://x")).ok).toBe(false)
    expect(conform(image("data:image/png;base64,AA==")).ok).toBe(true)
    expect(
      conform({ ...base, messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f1" } }] }] }).ok,
    ).toBe(false)
  })

  test("OpenRouter: allows its own fields, lowers a reasoning budget below the output limit", () => {
    const body = { ...base, usage: { include: true }, reasoning: { max_tokens: 40_000 }, max_completion_tokens: 64_000 }
    expect(openrouter(body)).toEqual({
      ok: true,
      body: { ...body, reasoning: { max_tokens: 31_999 }, max_completion_tokens: 32_000 },
    })
    expect(conform({ ...base, usage: { include: true } }).ok).toBe(false)
  })

  test("refuses what the gateway's strict schema doesn't admit", () => {
    expect(conform({ ...base, store: true }).ok).toBe(false)
    expect(conform({ ...base, store: false }).ok).toBe(true)
    expect(conform({ ...base, logprobs: true }).ok).toBe(false)
    expect(openrouter({ ...base, models: ["a", "b"] }).ok).toBe(false)
    expect(openrouter({ ...base, provider: { order: ["x"] } }).ok).toBe(false)
  })
})

describe("KeteJobRequestGemini.conform", () => {
  const base = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
  const conform = (body: Record<string, unknown>) => KeteJobRequestGemini.conform(body, limits)

  test("sets generationConfig.maxOutputTokens when absent, clamps it when present", () => {
    expect(conform(base)).toEqual({ ok: true, body: { ...base, generationConfig: { maxOutputTokens: 32_000 } } })
    expect(conform({ ...base, generationConfig: { maxOutputTokens: 999_999 } })).toEqual({
      ok: true,
      body: { ...base, generationConfig: { maxOutputTokens: 32_000 } },
    })
  })

  test("refuses cachedContent and candidateCount > 1", () => {
    expect(conform({ ...base, cachedContent: "c1" }).ok).toBe(false)
    expect(conform({ ...base, generationConfig: { candidateCount: 2 } }).ok).toBe(false)
    expect(conform({ ...base, generationConfig: { candidateCount: 1 } }).ok).toBe(true)
  })

  test("refuses a tool entry that isn't functionDeclarations-only", () => {
    expect(conform({ ...base, tools: [{ functionDeclarations: [] }] }).ok).toBe(true)
    expect(conform({ ...base, tools: [{ functionDeclarations: [], codeExecution: {} }] }).ok).toBe(false)
    expect(conform({ ...base, tools: [{ googleSearch: {} }] }).ok).toBe(false)
  })

  test("refuses fileData at any depth", () => {
    const body = {
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://x", mimeType: "image/png" } }] }],
    }
    expect(conform(body)).toEqual({ ok: false, reason: "fileData isn't allowed" })
  })

  test("omits null functionCall.id, thought and thoughtSignature in replayed history instead of sending null", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        {
          role: "model",
          parts: [
            { text: "thinking", thought: null, thoughtSignature: null },
            { functionCall: { id: null, name: "read", args: { path: "a" } }, thoughtSignature: null },
          ],
        },
        { role: "user", parts: [{ functionResponse: { id: null, name: "read", response: { content: "x" } } }] },
      ],
    }
    const result = conform(body)
    expect(result).toEqual({
      ok: true,
      body: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "thinking" }, { functionCall: { name: "read", args: { path: "a" } } }] },
          { role: "user", parts: [{ functionResponse: { name: "read", response: { content: "x" } } }] },
        ],
        generationConfig: { maxOutputTokens: 32_000 },
      },
    })
    expect(JSON.stringify(result.ok ? result.body : undefined)).not.toContain("null")
  })

  test("refuses what the gateway's strict schema doesn't admit", () => {
    expect(conform({ ...base, serviceTier: "priority" }).ok).toBe(false)
    expect(conform({ ...base, labels: { a: "b" } }).ok).toBe(false)
    expect(conform({ ...base, contents: [{ role: "model", parts: [{ executableCode: { code: "x" } }] }] }).ok).toBe(
      false,
    )
  })
})
