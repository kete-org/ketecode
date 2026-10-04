// Kete mirror of kete-code-platform `apps/gateway/src/jobs/schemas/anthropic-messages.ts` (the gateway's strict job-key
// request schema; docs/platform/jobs-v1.md, docs/gateway.md §2.8 there). Kept field-for-field equal so a job
// request the gateway would refuse is refused here first, with a local error, before any bytes leave the VM
// (CLAUDE.md §10). zod, not Effect Schema, so the two copies stay diffable line by line. When the platform
// changes its copy, change this one in the same way (docs/context/contracts.md "Job request shape").
import { z } from "zod"
import { AnthropicCacheControl as CacheControl, JsonObject, TokenCount } from "./common.js"

/**
 * The Anthropic Messages body a job key may send (`POST /anthropic/v1/messages`; ADR 0020 rules
 * 16–18). It mirrors what the Kete runtime builds: kete-code
 * `packages/ai/src/protocols/anthropic-messages.ts:82-394` (blocks, tools, thinking and body
 * fields), `:807-878` (mid-conversation system updates) and `:1030-1100` (lowering), after the
 * job-mode conformer `packages/core/src/kete/job-request/anthropic-messages.ts`.
 *
 * Every object is strict, so an unknown field anywhere is refused (rule 18). Refused on purpose:
 * `url`, `file` and `content` sources (rule 17), `compaction` blocks, `context_management`,
 * `inference_geo` and `service_tier` (cost tiers and server-side compaction; plan B4). Provider
 * tools, `mcp_servers` and `container` are refused earlier, by the request-shape pre-checks.
 */

const Text = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControl.optional(),
})

const Image = z.strictObject({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
  ]),
  cache_control: CacheControl.optional(),
  transformations: z.strictObject({ oversized_image: z.enum(["downsize", "error"]).optional() }).optional(),
})

const Document = z.strictObject({
  type: z.literal("document"),
  source: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("base64"), media_type: z.literal("application/pdf"), data: z.string() }),
    z.strictObject({ type: z.literal("text"), media_type: z.literal("text/plain"), data: z.string() }),
  ]),
  cache_control: CacheControl.optional(),
  title: z.string().optional(),
  context: z.string().optional(),
  citations: z.strictObject({ enabled: z.boolean() }).optional(),
})

const ToolResult = z.strictObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.discriminatedUnion("type", [Text, Image, Document]))]).optional(),
  is_error: z.boolean().optional(),
  cache_control: CacheControl.optional(),
})

const Thinking = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string(),
  cache_control: CacheControl.optional(),
})

const RedactedThinking = z.strictObject({
  type: z.literal("redacted_thinking"),
  data: z.string(),
  cache_control: CacheControl.optional(),
})

const ToolUse = z.strictObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: JsonObject,
  cache_control: CacheControl.optional(),
})

const UserBlock = z.discriminatedUnion("type", [Text, Image, Document, ToolResult])
const AssistantBlock = z.discriminatedUnion("type", [Text, Thinking, RedactedThinking, ToolUse])

const Message = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("user"), content: z.union([z.string(), z.array(UserBlock)]) }),
  z.strictObject({ role: z.literal("assistant"), content: z.union([z.string(), z.array(AssistantBlock)]) }),
  // The runtime's native mid-conversation system update (anthropic-messages.ts:807-878).
  z.strictObject({
    role: z.literal("system"),
    content: z.array(Text),
    output_config: z.strictObject({ effort: z.string() }).optional(),
  }),
])

/** Client tools only: no `type`, or `custom` (plan B5). */
const Tool = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  input_schema: JsonObject,
  cache_control: CacheControl.optional(),
  type: z.literal("custom").optional(),
})

const ToolChoice = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal(["auto", "any", "none"]), disable_parallel_tool_use: z.boolean().optional() }),
  z.strictObject({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }),
])

const BlockBinding = z.strictObject({ prefix_mismatch_behavior: z.string().optional() })

const ThinkingConfig = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("enabled"),
    budget_tokens: TokenCount,
    display: z.string().optional(),
    block_binding: BlockBinding.optional(),
  }),
  z.strictObject({
    type: z.literal("adaptive"),
    display: z.string().optional(),
    block_binding: BlockBinding.optional(),
  }),
  z.strictObject({ type: z.literal("disabled") }),
])

const OutputConfig = z.strictObject({
  effort: z.string().optional(),
  format: z
    .strictObject({ type: z.literal("json_schema"), schema: JsonObject })
    .nullable()
    .optional(),
})

export const AnthropicMessagesJobBody = z.strictObject({
  model: z.string(),
  messages: z.array(Message),
  max_tokens: TokenCount.optional(),
  system: z.union([z.string(), z.array(Text)]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(Tool).optional(),
  tool_choice: ToolChoice.optional(),
  thinking: ThinkingConfig.optional(),
  output_config: OutputConfig.optional(),
  cache_control: CacheControl.optional(),
  metadata: z.strictObject({ user_id: z.string().nullable().optional() }).optional(),
})
