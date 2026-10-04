// Job-mode conformance for the Gemini `generateContent`/`streamGenerateContent` wire body (POST
// …/gemini/v1beta/models/<model>:generateContent), the shape `packages/ai/src/protocols/gemini.ts`
// sends. Pure and adapter-local (ADR 0020 rules 8, 16–18; CLAUDE.md §3). See ../job-request.ts for
// how the executor calls this. The checks mirror the gateway's, in its order (kete-code-platform
// `apps/gateway/src/jobs/request-shape.ts`).

export * as KeteJobRequestGemini from "./gemini.js"

import { escapeKey, isObject, objects, schemaReason, type Conform } from "./shared.js"
import { GeminiJobBody } from "./schemas/gemini.js"

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

/** A copy of `node` without the listed keys whose value is `null`. */
function withoutNulls(node: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  if (!keys.some((key) => node[key] === null)) return node
  const next = { ...node }
  for (const key of keys) if (next[key] === null) delete next[key]
  return next
}

/**
 * Replayed history's optional part fields are omitted, never sent as `null`. The protocol's part
 * schemas are shared with response decoding, where Gemini does send explicit `null`
 * (`optionalNull`, packages/ai/src/protocols/gemini.ts:62-97), so the request type admits `null`
 * for `thought`, `thoughtSignature` and `functionCall.id`; the gateway's strict schema doesn't
 * (they're optional, not nullable). Dropping a `null` key changes nothing Gemini reads.
 */
function omitNullPartFields(contents: unknown): unknown {
  if (!Array.isArray(contents)) return contents
  return contents.map((content) => {
    if (!isObject(content) || !Array.isArray(content["parts"])) return content
    const parts = content["parts"].map((part) => {
      if (!isObject(part)) return part
      let next = withoutNulls(part, ["thought", "thoughtSignature"])
      const call = next["functionCall"]
      if (isObject(call) && call["id"] === null) next = { ...next, functionCall: withoutNulls(call, ["id"]) }
      const response = next["functionResponse"]
      if (isObject(response) && response["id"] === null)
        next = { ...next, functionResponse: withoutNulls(response, ["id"]) }
      return next
    })
    return { ...content, parts }
  })
}

/** Rule 16 (every `tools[]` entry has only `functionDeclarations` — no built-in Gemini tool),
 * `cachedContent` refused, one candidate (`generationConfig.candidateCount` must be 1 if present),
 * rule 17 (`fileData` refused at any depth), rule 8 (`generationConfig.maxOutputTokens`, clamped
 * or set), `null` part fields omitted, and rule 18 (the gateway's strict schema). */
export function conform(body: Record<string, unknown>, limits: { readonly maxOutputTokens: number }): Conform {
  if (body["background"] === true) return { ok: false, reason: "background isn't allowed" }
  if ("cachedContent" in body) return { ok: false, reason: "cachedContent isn't allowed" }

  for (const tool of objects(body["tools"])) {
    const keys = Object.keys(tool)
    if (keys.length !== 1 || keys[0] !== "functionDeclarations")
      return { ok: false, reason: `tool entry "${escapeKey(keys.join(","))}" isn't a function-declarations-only tool` }
  }

  const generationConfig = isObject(body["generationConfig"]) ? body["generationConfig"] : {}
  const candidateCount = generationConfig["candidateCount"]
  if (typeof candidateCount === "number" && candidateCount > 1)
    return { ok: false, reason: "generationConfig.candidateCount must be 1" }

  const fileData = walk(body, (node) => ("fileData" in node ? "fileData isn't allowed" : undefined))
  if (fileData !== undefined) return { ok: false, reason: fileData }

  const existing = generationConfig["maxOutputTokens"]
  const maxOutputTokens =
    typeof existing === "number" && Number.isFinite(existing)
      ? Math.min(existing, limits.maxOutputTokens)
      : limits.maxOutputTokens
  const next: Record<string, unknown> = { ...body, generationConfig: { ...generationConfig, maxOutputTokens } }
  if ("contents" in body) next["contents"] = omitNullPartFields(body["contents"])

  const reason = schemaReason(GeminiJobBody, next)
  if (reason !== undefined) return { ok: false, reason }
  return { ok: true, body: next }
}
