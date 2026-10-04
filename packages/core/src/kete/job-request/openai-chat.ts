// Job-mode conformance for the OpenAI Chat Completions wire body (POST …/openai/v1/chat/completions,
// and the OpenRouter compat route, which extends this shape), the format
// `packages/ai/src/protocols/openai-chat.ts` sends. Pure and adapter-local (ADR 0020 rules 8, 16–18;
// CLAUDE.md §3). See ../job-request.ts for how the executor calls this. The checks mirror the
// gateway's, in its order (kete-code-platform `apps/gateway/src/jobs/request-shape.ts`).

export * as KeteJobRequestOpenAIChat from "./openai-chat.js"

import { escapeKey, fitBudget, isObject, schemaReason, type Conform } from "./shared.js"
import { OpenAIChatJobBody, OpenRouterChatJobBody } from "./schemas/openai-chat.js"

export type { Conform } from "./shared.js"

function walk(value: unknown, visit: (node: Record<string, unknown>) => string | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = walk(item, visit)
      if (reason !== undefined) return reason
    }
    return undefined
  }
  if (!isObject(value)) return undefined
  const reason = visit(value)
  if (reason !== undefined) return reason
  for (const key of Object.keys(value)) {
    const nested = walk(value[key], visit)
    if (nested !== undefined) return nested
  }
  return undefined
}

export interface Options {
  readonly maxOutputTokens: number
  /** The OpenRouter compat route: its schema adds `usage`, `reasoning`, `user`, reasoning details
   * and `cache_control`, and `reasoning.max_tokens` is a budget the output must exceed. */
  readonly openrouter?: boolean
}

/** `background`, rule 16 (function tools only; `web_search_options` and the openrouter
 * `plugins`/`:online` extras refused), one candidate (`n` must be 1 if present), rule 17 (inline
 * content, `data:` URLs only), rule 8 (the output-token limit: whichever of
 * `max_completion_tokens`/`max_tokens` is present is clamped; `max_completion_tokens` is set when
 * both are absent; an OpenRouter reasoning budget is lowered below it) and rule 18 (the gateway's
 * strict schema for the route). */
export function conform(body: Record<string, unknown>, limits: Options): Conform {
  if (body["background"] === true) return { ok: false, reason: "background isn't allowed" }
  if (limits.openrouter === true) {
    const model = body["model"]
    if (typeof model === "string" && model.endsWith(":online"))
      return { ok: false, reason: `model "${escapeKey(model)}" isn't allowed (the ":online" plugin suffix)` }
    if ("plugins" in body) return { ok: false, reason: "plugins isn't allowed" }
  }
  if ("web_search_options" in body) return { ok: false, reason: "web_search_options isn't allowed" }

  const tools = body["tools"]
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isObject(tool)) continue
      const type = tool["type"]
      if (type !== "function")
        return { ok: false, reason: `tool type "${escapeKey(String(type))}" isn't a function tool` }
    }
  }

  const n = body["n"]
  if (typeof n === "number" && n > 1) return { ok: false, reason: "n must be 1" }

  const inline = walk(body, (node) => {
    if ("file_id" in node) return "file_id isn't allowed"
    const imageUrl = node["image_url"]
    if (isObject(imageUrl) && typeof imageUrl["url"] === "string" && !imageUrl["url"].startsWith("data:"))
      return "image_url.url must be a data: URL"
    return undefined
  })
  if (inline !== undefined) return { ok: false, reason: inline }

  const existingCompletion = body["max_completion_tokens"]
  const existingTokens = body["max_tokens"]
  const next = { ...body }
  const outputs: number[] = []
  if (typeof existingCompletion === "number" && Number.isFinite(existingCompletion)) {
    next["max_completion_tokens"] = Math.min(existingCompletion, limits.maxOutputTokens)
    outputs.push(next["max_completion_tokens"] as number)
  }
  if (typeof existingTokens === "number" && Number.isFinite(existingTokens)) {
    next["max_tokens"] = Math.min(existingTokens, limits.maxOutputTokens)
    outputs.push(next["max_tokens"] as number)
  }
  if (outputs.length === 0) {
    next["max_completion_tokens"] = limits.maxOutputTokens
    outputs.push(limits.maxOutputTokens)
  }

  const reasoning = body["reasoning"]
  if (limits.openrouter === true && isObject(reasoning) && typeof reasoning["max_tokens"] === "number") {
    const budget = fitBudget(reasoning["max_tokens"], outputs, 1)
    if (budget === undefined)
      return { ok: false, reason: "the output-token limit must be larger than reasoning.max_tokens" }
    next["reasoning"] = { ...reasoning, max_tokens: budget }
  }

  const reason = schemaReason(limits.openrouter === true ? OpenRouterChatJobBody : OpenAIChatJobBody, next)
  if (reason !== undefined) return { ok: false, reason }
  return { ok: true, body: next }
}
