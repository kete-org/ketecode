// Kete mirror of kete-code-platform `apps/gateway/src/jobs/schemas/gemini.ts` (the gateway's strict job-key
// request schema; docs/platform/jobs-v1.md, docs/gateway.md §2.8 there). Kept field-for-field equal so a job
// request the gateway would refuse is refused here first, with a local error, before any bytes leave the VM
// (CLAUDE.md §10). zod, not Effect Schema, so the two copies stay diffable line by line. When the platform
// changes its copy, change this one in the same way (docs/context/contracts.md "Job request shape").
import { z } from "zod"
import { JsonObject, TokenCount } from "./common.js"

/**
 * The Gemini body a job key may send (`POST /gemini/v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent`; ADR 0020 rules 16–18). It mirrors what the Kete runtime builds:
 * kete-code `packages/ai/src/protocols/gemini.ts:58-217`, with the `thinkingConfig` the runtime
 * sets (`packages/core/src/variant.ts:343-352`), after the job-mode conformer
 * `packages/core/src/kete/job-request/gemini.ts`.
 *
 * Every object is strict, so an unknown field anywhere is refused (rule 18); a part is a union of
 * strict objects, so it carries exactly one data key. Refused on purpose: `fileData` at any depth
 * (rule 17), `cachedContent`, `labels` and `serviceTier` (plan B4), `executableCode` and
 * `codeExecutionResult` parts, and `candidateCount` other than 1. Built-in Gemini tools are
 * refused earlier, by the request-shape pre-checks.
 */

const InlineData = z.strictObject({ mimeType: z.string(), data: z.string() })

const Part = z.union([
  z.strictObject({ text: z.string(), thought: z.boolean().optional(), thoughtSignature: z.string().optional() }),
  z.strictObject({ inlineData: InlineData, thoughtSignature: z.string().optional() }),
  z.strictObject({
    functionCall: z.strictObject({ id: z.string().optional(), name: z.string(), args: JsonObject.optional() }),
    thoughtSignature: z.string().optional(),
  }),
  z.strictObject({
    functionResponse: z.strictObject({
      id: z.string().optional(),
      name: z.string(),
      response: JsonObject,
      parts: z.array(z.strictObject({ inlineData: InlineData })).optional(),
    }),
  }),
])

const Content = z.strictObject({ role: z.enum(["user", "model"]).optional(), parts: z.array(Part) })

const Tool = z.strictObject({
  functionDeclarations: z.array(
    z.strictObject({ name: z.string(), description: z.string().optional(), parametersJsonSchema: JsonObject }),
  ),
})

const GenerationConfig = z.strictObject({
  maxOutputTokens: TokenCount.optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  seed: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  thinkingConfig: z
    .strictObject({
      thinkingBudget: z.number().int().min(-1).optional(),
      includeThoughts: z.boolean().optional(),
      thinkingLevel: z.string().optional(),
    })
    .optional(),
  candidateCount: z.literal(1).optional(),
})

export const GeminiJobBody = z.strictObject({
  contents: z.array(Content),
  systemInstruction: z.strictObject({ parts: z.array(z.strictObject({ text: z.string() })) }).optional(),
  tools: z.array(Tool).optional(),
  toolConfig: z
    .strictObject({
      functionCallingConfig: z.strictObject({
        mode: z.enum(["AUTO", "NONE", "ANY"]),
        allowedFunctionNames: z.array(z.string()).optional(),
      }),
    })
    .optional(),
  generationConfig: GenerationConfig.optional(),
  safetySettings: z.array(z.strictObject({ category: z.string(), threshold: z.string() })).optional(),
})
