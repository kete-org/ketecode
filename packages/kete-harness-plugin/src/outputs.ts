// Kete-owned. The step's results: the exit code and the output variables Harness reads from the
// file named by `$DRONE_OUTPUT` (and `$HARNESS_OUTPUT`, when set), one `KEY=value` line each. Values
// are single lines: newlines are folded to spaces and long values cut, so a summary can never
// inject another variable.

import { appendFileSync } from "node:fs"
import { KeteRedact } from "@opencode/util/kete/redact"

export * as Outputs from "./outputs.js"

/** 0 success, 1 failure, 2 refused (settings, policy, budget). */
export type ExitCode = 0 | 1 | 2

export type Values = {
  readonly KETE_OUTCOME: string
  readonly KETE_SUMMARY: string
  readonly KETE_BRANCH: string
  readonly KETE_JOB_URL: string
}

export const summaryMaxBytes = 2000

/** `kete job run`'s outcome (docs/jobs.md "Exit codes") or a cloud job's, as this step's exit code. */
export function exitCode(outcome: string): ExitCode {
  switch (outcome) {
    case "completed":
    case "succeeded":
      return 0
    case "refused":
    case "audit_failed":
    case "budget":
    case "insufficient_balance":
    case "not_permitted":
      return 2
    default:
      return 1
  }
}

/** One line, redacted, at most `summaryMaxBytes` bytes. */
export function oneLine(text: string, max = summaryMaxBytes): string {
  const flat = KeteRedact.text(text)
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
  const cut = KeteRedact.truncate(flat, max)
  return cut.length < flat.length ? `${KeteRedact.truncate(flat, max - 3)}...` : cut
}

export function format(values: Values): string {
  return (Object.keys(values) as (keyof Values)[]).map((key) => `${key}=${oneLine(values[key])}\n`).join("")
}

/** The output files Harness and Drone name; the same path once. */
export function targets(env: Readonly<Record<string, string | undefined>>): string[] {
  const paths = [env.DRONE_OUTPUT, env.HARNESS_OUTPUT].filter((p): p is string => p !== undefined && p.trim() !== "")
  return [...new Set(paths)]
}

export function write(env: Readonly<Record<string, string | undefined>>, values: Values): void {
  const text = format(values)
  for (const path of targets(env)) appendFileSync(path, text, { mode: 0o600 })
}
