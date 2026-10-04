// The unattended-run contract's wire shapes and stop-message text (ADR 0008), shared by the
// runtime (`core/src/kete/unattended-policy.ts` re-exports `AllowRule`/`Policy` from here) and the
// CLI (`cli/src/kete/job-spec.ts`, which can't import core): one set of identifiers, one set of
// message strings, so the two never drift apart. `classify` is the inverse of the message builders:
// given a stop message a client read from an audit line or a `session.execution.failed` event, it
// says which of the four stop reasons produced it.

export * as KeteUnattendedSchema from "./unattended.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const AllowRule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
}).annotate({ identifier: "KeteUnattendedPolicy.AllowRule" })
export type AllowRule = typeof AllowRule.Type

export const Policy = Schema.Struct({
  version: Schema.Literal(1),
  allow: Schema.Array(AllowRule).pipe(optional),
  budget: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
  timeout: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
}).annotate({ identifier: "KeteUnattendedPolicy.Policy" })
export type Policy = typeof Policy.Type

/** What `refused` needs to say which limit(s) a run has none of. */
export type MissingLimit = "budget" | "time limit"

/** "Unattended run refused: job mode requires ..." — job mode (KETE_JOB_MODE) requires every
 * session to be unattended; `core/src/kete/run-checks.ts` supplies this when a job-mode session has
 * no `kete.unattended` metadata. Starts with the same prefix as `refused` below, so `classify`
 * reports it the same way: "refused". */
export function jobMode(): string {
  return "Unattended run refused: job mode requires every session to be unattended (kete.unattended)."
}

/** "Unattended run refused: ..." — a run that can't start because it has no budget, no time
 * limit, or neither. `core/src/kete/unattended.ts`'s `refused` supplies `missing`. */
export function refused(missing: ReadonlyArray<MissingLimit>): string {
  const detail =
    missing.length === 2
      ? "no spending budget and no time limit. Set the run's budget and timeout, or kete.budget.session and kete.subagents.timeout"
      : missing[0] === "budget"
        ? "no spending budget. Set the run's budget or kete.budget.session"
        : "no time limit. Set the run's timeout or kete.subagents.timeout"
  return `Unattended run refused: ${detail}.`
}

/** "Unattended run stopped: ... time limit." `minutes` is already resolved (e.g.
 * `Duration.toMinutes`); this module doesn't depend on `effect`'s `Duration`. */
export function timeLimit(minutes: number): string {
  return `Unattended run stopped: it reached its ${minutes}-minute time limit.`
}

/** "Unattended run stopped: ... budget (spent ...)." `budgetUsd`/`spentUsd` are already formatted
 * (e.g. `KeteBudget.usd`), so this module doesn't depend on core's money formatting. */
export function budget(budgetUsd: string, spentUsd: string): string {
  return `Unattended run stopped: it reached its ${budgetUsd} budget (spent ${spentUsd}).`
}

/** "Unattended run stopped: ... audit log can't be written (...)." */
export function auditUnavailable(path: string, code: string): string {
  return `Unattended run stopped: its audit log can't be written (${path}: ${code}).`
}

export type StopReason = "refused" | "audit" | "time_limit" | "budget"

/**
 * The inverse of the builders above: which stop reason produced `message`, or `undefined` for any
 * other message (an ordinary error, an interrupt, or text these builders didn't produce). Matches
 * on fixed substrings each builder's output alone contains, so it stays right if the messages
 * above ever change wording together with this function.
 */
export function classify(message: string): StopReason | undefined {
  if (message.startsWith("Unattended run refused:")) return "refused"
  if (!message.startsWith("Unattended run stopped:")) return undefined
  if (message.includes("audit log can't be written")) return "audit"
  if (message.includes("time limit")) return "time_limit"
  if (message.includes("budget")) return "budget"
  return undefined
}
