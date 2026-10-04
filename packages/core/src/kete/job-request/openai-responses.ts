// Job-mode conformance for the OpenAI Responses wire body (POST …/openai/v1/responses), the shape
// `packages/ai/src/protocols/open-responses.ts` sends. Pure and adapter-local (ADR 0020 rules 8,
// 16–18; CLAUDE.md §3). See ../job-request.ts for how the executor calls this. The checks mirror
// the gateway's, in its order (kete-code-platform `apps/gateway/src/jobs/request-shape.ts`).

export * as KeteJobRequestOpenAIResponses from "./openai-responses.js"

import { escapeKey, isObject, objects, schemaReason, type Conform } from "./shared.js"
import { OpenAIResponsesJobBody } from "./schemas/openai-responses.js"

export type { Conform } from "./shared.js"

/** Input items that echo hosted-tool use (the gateway's `RESPONSES_HOSTED_ITEMS`). */
const HOSTED_ITEMS = new Set([
  "web_search_call",
  "web_search_preview_call",
  "file_search_call",
  "code_interpreter_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "computer_call",
  "computer_call_output",
  "image_generation_call",
  "local_shell_call",
  "local_shell_call_output",
])

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

/** Rule 16 (function tools and function `tool_choice` only, no hosted-tool history), the
 * Responses-specific state fields (previous_response_id, background, conversation refused; store
 * forced false), rule 17 (inline content, `data:` URLs only), rule 8 (the output-token limit) and
 * rule 18 (the gateway's strict schema). */
export function conform(body: Record<string, unknown>, limits: { readonly maxOutputTokens: number }): Conform {
  if ("background" in body) return { ok: false, reason: "background isn't allowed" }
  if ("previous_response_id" in body) return { ok: false, reason: "previous_response_id isn't allowed" }
  if ("conversation" in body) return { ok: false, reason: "conversation isn't allowed" }

  const tools = body["tools"]
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isObject(tool)) continue
      const type = tool["type"]
      if (type !== "function")
        return { ok: false, reason: `tool type "${escapeKey(String(type))}" isn't a function tool` }
    }
  }

  const choice = body["tool_choice"]
  if (isObject(choice)) {
    const allowed =
      choice["type"] === "allowed_tools" && objects(choice["tools"]).every((tool) => tool["type"] === "function")
    if (choice["type"] !== "function" && !allowed)
      return { ok: false, reason: `tool_choice type "${escapeKey(String(choice["type"]))}" isn't a function tool` }
  }

  for (const item of objects(body["input"])) {
    const type = item["type"]
    if (typeof type === "string" && HOSTED_ITEMS.has(type))
      return { ok: false, reason: `replaying hosted-tool use ("${escapeKey(type)}" item) isn't allowed` }
  }

  const inline = walk(body, (node) => {
    if ("file_id" in node) return "file_id isn't allowed"
    if (node["type"] === "input_file" && "file_url" in node) return "input_file.file_url isn't allowed"
    if (node["type"] === "input_image") {
      const url = node["image_url"]
      if (typeof url === "string" && !url.startsWith("data:")) return "input_image.image_url must be a data: URL"
    }
    return undefined
  })
  if (inline !== undefined) return { ok: false, reason: inline }

  const existing = body["max_output_tokens"]
  const max_output_tokens =
    typeof existing === "number" && Number.isFinite(existing)
      ? Math.min(existing, limits.maxOutputTokens)
      : limits.maxOutputTokens
  const next = { ...body, max_output_tokens, store: false }

  const reason = schemaReason(OpenAIResponsesJobBody, next)
  if (reason !== undefined) return { ok: false, reason }
  return { ok: true, body: next }
}
