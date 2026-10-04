// Kete mirror of kete-code-platform `apps/gateway/src/jobs/schemas/common.ts` (the gateway's strict job-key
// request schema; docs/platform/jobs-v1.md, docs/gateway.md §2.8 there). Kept field-for-field equal so a job
// request the gateway would refuse is refused here first, with a local error, before any bytes leave the VM
// (CLAUDE.md §10). zod, not Effect Schema, so the two copies stay diffable line by line. When the platform
// changes its copy, change this one in the same way (docs/context/contracts.md "Job request shape").
import { z } from "zod"

/**
 * Shared pieces of the job-key request schemas (ADR 0020 rule 18; docs/gateway.md §2.8). Every
 * schema is built from `z.strictObject` at every level, so an unknown field anywhere fails closed.
 */

/**
 * An opaque JSON object. Used only for data a provider never fetches from: tool input schemas,
 * tool-call arguments and Gemini `functionResponse.response`.
 */
export const JsonObject = z.record(z.string(), z.unknown())

/** An output-token count or budget. The platform limit is checked after the schema. */
export const TokenCount = z.number().int().min(1)

/** Inline media only (rule 17): a `data:` URL, never one a provider would fetch. */
export const DataUrl = z.string().startsWith("data:")

/** Anthropic `cache_control` (kete-code `packages/ai/src/protocols/anthropic-messages.ts:82-85`). */
export const AnthropicCacheControl = z.strictObject({
  type: z.literal("ephemeral"),
  ttl: z.enum(["5m", "1h"]).optional(),
})

/** OpenRouter's `cache_control` (kete-code `packages/ai/src/protocols/openai-chat.ts:46-49`). */
export const OpenRouterCacheControl = z.strictObject({
  type: z.literal("ephemeral"),
  ttl: z.string().optional(),
})
