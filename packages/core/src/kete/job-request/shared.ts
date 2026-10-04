// Helpers shared by the job-mode conformers (../job-request.ts and its siblings): the result
// type, the strict-schema check that mirrors the gateway's (kete-code-platform
// `apps/gateway/src/jobs/request-shape.ts`, `describeIssue`), and the thinking-budget rule both
// Anthropic and OpenRouter apply (ADR 0020 rule 8; gateway docs §2.8 step 6). Pure: no network,
// no Effect.

export * as KeteJobRequestShared from "./shared.js"

import type { z } from "zod"

export type Conform =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The object entries of an array; anything else yields none. */
export const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isObject) : []

const MAX_PATH_CHARS = 200
const MAX_KEY_CHARS = 64

/** A key name or short identifier (a type, a model id) from the body, safe to put in an error:
 * word characters, dots, dashes, colons and slashes only, capped. */
export function escapeKey(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_.:/-]/g, "?")
  return safe.length > MAX_KEY_CHARS ? `${safe.slice(0, MAX_KEY_CHARS)}…` : safe
}

function formatPath(path: readonly (string | number)[]): string {
  let text = ""
  for (const key of path) text += typeof key === "number" ? `[${key}]` : `${text === "" ? "" : "."}${escapeKey(key)}`
  return text
}

/**
 * Validates the final body against the gateway's strict schema for its route. `undefined` when it
 * passes; otherwise the refusal reason, naming the first issue's JSON path (with an unrecognized
 * key appended) — never a value from the body, which may hold source code or secrets.
 */
export function schemaReason(schema: z.ZodType, body: Record<string, unknown>): string | undefined {
  const parsed = schema.safeParse(body)
  if (parsed.success) return undefined
  const issue = parsed.error.issues[0]
  if (issue === undefined) return "the gateway's job request schema refuses this request"
  const path = issue.path.map((key) => (typeof key === "number" ? key : String(key)))
  const shown = issue.code === "unrecognized_keys" && issue.keys[0] !== undefined ? [...path, issue.keys[0]] : path
  const where = formatPath(shown).slice(0, MAX_PATH_CHARS)
  const what = issue.code === "unrecognized_keys" ? "isn't allowed" : "doesn't have an allowed shape"
  return `${where === "" ? "the request body" : where} ${what} (the gateway's job request schema)`
}

/**
 * A thinking or reasoning budget must stay below every output-token field the body sets (the
 * gateway refuses `budget >= limit` and `output <= budget`). `outputs` are the body's output
 * fields after the clamp, so each is already ≤ the platform limit; a budget at or over the
 * smallest is lowered to one below it, as the clamp lowers the output itself. `undefined` refuses:
 * the lowered budget would be under `minimum` (Anthropic's smallest budget is 1,024).
 */
export function fitBudget(budget: number, outputs: readonly number[], minimum: number): number | undefined {
  if (outputs.length === 0) return budget
  const ceiling = Math.min(...outputs) - 1
  if (budget <= ceiling) return budget
  return ceiling >= minimum ? ceiling : undefined
}
