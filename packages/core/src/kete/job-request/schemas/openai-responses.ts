// Kete mirror of kete-code-platform `apps/gateway/src/jobs/schemas/openai-responses.ts` (the gateway's strict job-key
// request schema; docs/platform/jobs-v1.md, docs/gateway.md §2.8 there). Kept field-for-field equal so a job
// request the gateway would refuse is refused here first, with a local error, before any bytes leave the VM
// (CLAUDE.md §10). zod, not Effect Schema, so the two copies stay diffable line by line. When the platform
// changes its copy, change this one in the same way (docs/context/contracts.md "Job request shape").
import { z } from "zod"
import { DataUrl, JsonObject, TokenCount } from "./common.js"

/**
 * The OpenAI Responses body a job key may send (`POST /openai/v1/responses`; ADR 0020 rules
 * 16–18). It mirrors what the Kete runtime builds: kete-code
 * `packages/ai/src/protocols/open-responses.ts:37-301` (items, content, tools, body fields) and
 * `packages/ai/src/protocols/openai-responses.ts:33-131` (OpenAI's `configuration_update`), with
 * the default options of `packages/ai/src/providers/openai-options.ts:35-64` (`store: false`,
 * `include: ["reasoning.encrypted_content"]`, `reasoning.summary: "auto"`), after the job-mode
 * conformer `packages/core/src/kete/job-request/openai-responses.ts` (which forces `store: false`).
 *
 * Every object is strict, so an unknown field anywhere is refused (rule 18). Refused on purpose:
 * `input_image` over http(s) or by `file_id`, `input_file` by `file_url` or `file_id` (rule 17);
 * `item_reference` and `compaction` items, `context_management` and `service_tier` (plan B4);
 * other `include` values, `text.format`, `prompt`. Hosted tools, hosted-tool history,
 * `background`, `previous_response_id`, `conversation` and a missing or true `store` are refused
 * earlier, by the request-shape pre-checks.
 */

const InputText = z.strictObject({ type: z.literal("input_text"), text: z.string() })
const InputImage = z.strictObject({ type: z.literal("input_image"), image_url: DataUrl, detail: z.string().optional() })
const InputFile = z.strictObject({
  type: z.literal("input_file"),
  filename: z.string(),
  file_data: z.string(),
  detail: z.string().optional(),
})
const InputVideo = z.strictObject({ type: z.literal("input_video"), video_url: DataUrl })
const OutputText = z.strictObject({ type: z.literal("output_text"), text: z.string() })
const SummaryText = z.strictObject({ type: z.literal("summary_text"), text: z.string() })

const MessageItem = z.discriminatedUnion("role", [
  z.strictObject({ type: z.literal("message"), role: z.literal("system"), content: z.string() }),
  z.strictObject({ type: z.literal("message"), role: z.literal("developer"), content: z.string() }),
  z.strictObject({
    type: z.literal("message"),
    role: z.literal("user"),
    content: z.array(z.discriminatedUnion("type", [InputText, InputImage, InputFile])),
    id: z.string().optional(),
    status: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(OutputText),
    id: z.string().optional(),
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    status: z.string().optional(),
  }),
])

const Item = z.discriminatedUnion("type", [
  MessageItem,
  z.strictObject({
    type: z.literal("reasoning"),
    id: z.string().optional(),
    summary: z.array(SummaryText),
    encrypted_content: z.string().nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("function_call"),
    id: z.string().optional(),
    call_id: z.string(),
    name: z.string(),
    namespace: z.string().optional(),
    arguments: z.string(),
  }),
  z.strictObject({
    type: z.literal("function_call_output"),
    call_id: z.string(),
    output: z.union([
      z.string(),
      z.array(z.discriminatedUnion("type", [InputText, InputImage, InputFile, InputVideo])),
    ]),
  }),
  z.strictObject({ type: z.literal("configuration_update"), reasoning: z.strictObject({ effort: z.string() }) }),
])

const FunctionTool = z.strictObject({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: JsonObject,
  strict: z.boolean().optional(),
})

const ToolChoiceMode = z.enum(["auto", "none", "required"])
const ToolChoice = z.union([
  ToolChoiceMode,
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("function"), name: z.string() }),
    z.strictObject({
      type: z.literal("allowed_tools"),
      mode: ToolChoiceMode,
      tools: z.array(z.strictObject({ type: z.literal("function"), name: z.string() })),
    }),
  ]),
])

export const OpenAIResponsesJobBody = z.strictObject({
  model: z.string(),
  input: z.union([z.string(), z.array(Item)]),
  instructions: z.string().optional(),
  tools: z.array(FunctionTool).optional(),
  tool_choice: ToolChoice.optional(),
  store: z.literal(false),
  metadata: z.record(z.string(), z.string()).optional(),
  safety_identifier: z.string().optional(),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_obfuscation: z.boolean().optional() }).optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  truncation: z.enum(["auto", "disabled"]).optional(),
  prompt_cache_key: z.string().optional(),
  include: z.array(z.enum(["reasoning.encrypted_content", "message.output_text.logprobs"])).optional(),
  reasoning: z
    .strictObject({
      effort: z.string().optional(),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
    })
    .optional(),
  text: z.strictObject({ verbosity: z.string().optional() }).optional(),
  max_output_tokens: TokenCount.optional(),
  max_tool_calls: z.number().int().min(0).optional(),
  parallel_tool_calls: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
})
