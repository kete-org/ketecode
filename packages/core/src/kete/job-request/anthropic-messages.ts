// Job-mode conformance for the Anthropic Messages wire body (POST …/anthropic/v1/messages), the
// shape `packages/ai/src/protocols/anthropic-messages.ts` sends. Pure and adapter-local (ADR 0020
// rules 8, 16–18; CLAUDE.md §3): no network, no Effect. See ../job-request.ts for how the executor
// calls this, and for what a refusal means. The checks mirror the gateway's, in its order
// (kete-code-platform `apps/gateway/src/jobs/request-shape.ts`, `checkJobRequest`), so a request
// the gateway would refuse is refused here with a local error instead.

export * as KeteJobRequestAnthropicMessages from "./anthropic-messages.js"

import { escapeKey, fitBudget, isObject, objects, schemaReason, type Conform } from "./shared.js"
import { AnthropicMessagesJobBody } from "./schemas/anthropic-messages.js"

export type { Conform } from "./shared.js"

/** Content blocks that echo provider-side tool use (the gateway's `ANTHROPIC_PROVIDER_BLOCKS`). */
const PROVIDER_BLOCKS = new Set(["server_tool_use", "mcp_tool_use", "mcp_tool_result", "container_upload"])

/** Anthropic's smallest `thinking.budget_tokens`. */
const MIN_THINKING_BUDGET = 1024

/** Depth-first walk of every object node in `value` — messages, tool_result content and system
 * blocks included, whatever their nesting. */
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

/** `background`, rule 16 (function tools only, no provider-tool history), rule 17 (inline content,
 * base64/text only), rule 8 (the output-token limit, clamped or set; a thinking budget lowered
 * below it) and rule 18 (the gateway's strict schema). `limits.maxOutputTokens` is already
 * required non-`undefined` by the caller. */
export function conform(body: Record<string, unknown>, limits: { readonly maxOutputTokens: number }): Conform {
  if (body["background"] === true) return { ok: false, reason: "background isn't allowed" }
  if ("mcp_servers" in body) return { ok: false, reason: "mcp_servers isn't allowed" }
  if ("container" in body) return { ok: false, reason: "container isn't allowed" }

  const tools = body["tools"]
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isObject(tool)) continue
      const type = tool["type"]
      if (type !== undefined && type !== "custom")
        return { ok: false, reason: `tool type "${escapeKey(String(type))}" isn't a function tool` }
    }
  }

  for (const message of objects(body["messages"])) {
    for (const block of objects(message["content"])) {
      const type = block["type"]
      if (typeof type !== "string") continue
      if (PROVIDER_BLOCKS.has(type) || (type.endsWith("_tool_result") && type !== "tool_result"))
        return { ok: false, reason: `replaying provider-side tool use ("${escapeKey(type)}" block) isn't allowed` }
    }
  }

  const inline = walk(body, (node) => {
    const source = node["source"]
    if (!isObject(source)) return undefined
    const type = source["type"]
    return type === "url" || type === "file"
      ? `inline content with source.type "${escapeKey(String(type))}" isn't allowed`
      : undefined
  })
  if (inline !== undefined) return { ok: false, reason: inline }

  const existing = body["max_tokens"]
  const max_tokens =
    typeof existing === "number" && Number.isFinite(existing)
      ? Math.min(existing, limits.maxOutputTokens)
      : limits.maxOutputTokens
  const next: Record<string, unknown> = { ...body, max_tokens }

  const thinking = body["thinking"]
  if (isObject(thinking) && thinking["type"] === "enabled" && typeof thinking["budget_tokens"] === "number") {
    const budget = fitBudget(thinking["budget_tokens"], [max_tokens], MIN_THINKING_BUDGET)
    if (budget === undefined)
      return { ok: false, reason: `max_tokens (${max_tokens}) must be larger than thinking.budget_tokens` }
    next["thinking"] = { ...thinking, budget_tokens: budget }
  }

  const reason = schemaReason(AnthropicMessagesJobBody, next)
  if (reason !== undefined) return { ok: false, reason }
  return { ok: true, body: next }
}
