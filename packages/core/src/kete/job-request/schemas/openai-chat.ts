// Kete mirror of kete-code-platform `apps/gateway/src/jobs/schemas/openai-chat.ts` (the gateway's strict job-key
// request schema; docs/platform/jobs-v1.md, docs/gateway.md §2.8 there). Kept field-for-field equal so a job
// request the gateway would refuse is refused here first, with a local error, before any bytes leave the VM
// (CLAUDE.md §10). zod, not Effect Schema, so the two copies stay diffable line by line. When the platform
// changes its copy, change this one in the same way (docs/context/contracts.md "Job request shape").
import { z } from "zod"
import { DataUrl, JsonObject, OpenRouterCacheControl, TokenCount } from "./common.js"

/**
 * The OpenAI Chat Completions body a job key may send (`POST /openai/v1/chat/completions`), and
 * OpenRouter's extension of it (`POST /compat/openrouter/v1/chat/completions`; ADR 0020 rules
 * 16–18). It mirrors what the Kete runtime builds: kete-code
 * `packages/ai/src/protocols/openai-chat.ts:38-199` (body fields) and `:740-850` (lowering;
 * `store: false` by default, :784-788), OpenRouter's additions in
 * `packages/ai/src/providers/openrouter.ts:96-170` (`usage`, `reasoning`, `user`,
 * `reasoning_details`, `cache_control`), after the job-mode conformer
 * `packages/core/src/kete/job-request/openai-chat.ts`.
 *
 * Every object is strict, so an unknown field anywhere is refused (rule 18). Refused on purpose:
 * `image_url` over http(s) and `file.file_id` (rule 17); `n` other than 1; `store: true` (plan
 * B7); `tool_stream`, `audio`, `modalities`, `prediction`, `functions` and `logprobs`; and on
 * OpenRouter `models` (fallbacks would bypass the model pin), `provider`, `debug`, `transforms` and
 * `route` (plan B4). Provider tools, `web_search_options`, `plugins` and `:online` models are
 * refused earlier, by the request-shape pre-checks.
 */
function chatSchema(openrouter: boolean) {
  // OpenRouter accepts cache_control on text parts, tool messages, tools and assistant messages.
  const cacheControl = openrouter ? { cache_control: OpenRouterCacheControl.optional() } : {}

  const Part = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), text: z.string(), ...cacheControl }),
    z.strictObject({ type: z.literal("image_url"), image_url: z.strictObject({ url: DataUrl }) }),
    z.strictObject({ type: z.literal("file"), file: z.strictObject({ filename: z.string(), file_data: z.string() }) }),
  ])
  const Content = z.union([z.string(), z.array(Part)])

  const ToolCall = z.strictObject({
    id: z.string(),
    type: z.literal("function"),
    function: z.strictObject({ name: z.string(), arguments: z.string() }),
  })

  const detailFields = {
    id: z.string().nullable().optional(),
    format: z.string().optional(),
    index: z.number().optional(),
    signature: z.string().nullable().optional(),
  }
  const ReasoningDetail = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("reasoning.text"), text: z.string().optional(), ...detailFields }),
    z.strictObject({ type: z.literal("reasoning.summary"), summary: z.string().optional(), ...detailFields }),
    z.strictObject({ type: z.literal("reasoning.encrypted"), data: z.string(), ...detailFields }),
  ])
  const assistantExtras = openrouter
    ? { reasoning: z.string().optional(), reasoning_details: z.array(ReasoningDetail).optional(), ...cacheControl }
    : {}

  const Message = z.discriminatedUnion("role", [
    z.strictObject({ role: z.literal("system"), content: Content }),
    z.strictObject({ role: z.literal("user"), content: Content }),
    z.strictObject({
      role: z.literal("assistant"),
      content: z.string().nullable().optional(),
      tool_calls: z.array(ToolCall).optional(),
      ...assistantExtras,
    }),
    z.strictObject({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string(), ...cacheControl }),
  ])

  const Tool = z.strictObject({
    type: z.literal("function"),
    function: z.strictObject({
      name: z.string(),
      description: z.string().optional(),
      parameters: JsonObject,
      strict: z.boolean().optional(),
    }),
    ...cacheControl,
  })

  const ToolChoice = z.union([
    z.enum(["auto", "none", "required"]),
    z.strictObject({ type: z.literal("function"), function: z.strictObject({ name: z.string() }) }),
  ])

  const openrouterFields = openrouter
    ? {
        usage: z.strictObject({ include: z.boolean() }).optional(),
        reasoning: z
          .strictObject({
            enabled: z.boolean().optional(),
            exclude: z.boolean().optional(),
            effort: z.string().optional(),
            max_tokens: TokenCount.optional(),
          })
          .optional(),
        user: z.string().optional(),
      }
    : {}

  return z.strictObject({
    model: z.string(),
    messages: z.array(Message),
    tools: z.array(Tool).optional(),
    tool_choice: ToolChoice.optional(),
    stream: z.boolean().optional(),
    stream_options: z.strictObject({ include_usage: z.boolean() }).optional(),
    store: z.literal(false).optional(),
    prompt_cache_key: z.string().optional(),
    reasoning_effort: z.string().optional(),
    max_completion_tokens: TokenCount.optional(),
    max_tokens: TokenCount.optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    seed: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    n: z.literal(1).optional(),
    ...openrouterFields,
  })
}

export const OpenAIChatJobBody = chatSchema(false)
export const OpenRouterChatJobBody = chatSchema(true)
