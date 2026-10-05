// Kete-owned. The step's results: the exit code and the output variables Harness reads from the
// file named by `$DRONE_OUTPUT` (and `$HARNESS_OUTPUT`, when set), one `KEY=value` line each. Values
// are single lines: newlines are folded to spaces and long values cut, so a summary can never
// inject another variable.

import { appendFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { KeteRedact } from "@opencode/util/kete/redact"
import { Secrets } from "./secrets.js"

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
export function oneLine(text: string, redact: Secrets.Redactor, max = summaryMaxBytes): string {
  const flat = redact(text)
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
  const cut = KeteRedact.truncate(flat, max)
  return cut.length < flat.length ? `${KeteRedact.truncate(flat, max - 3)}...` : cut
}

export function format(values: Values, redact: Secrets.Redactor): string {
  return (Object.keys(values) as (keyof Values)[]).map((key) => `${key}=${oneLine(values[key], redact)}\n`).join("")
}

/** The output files Harness and Drone name; the same path once. */
export function targets(env: Readonly<Record<string, string | undefined>>): string[] {
  const paths = [env.DRONE_OUTPUT, env.HARNESS_OUTPUT].filter((p): p is string => p !== undefined && p.trim() !== "")
  return [...new Set(paths)]
}

export function write(
  env: Readonly<Record<string, string | undefined>>,
  values: Values,
  redact: Secrets.Redactor,
): void {
  const text = format(values, redact)
  for (const file of targets(env)) appendFileSync(file, text, { mode: 0o600 })
}

/**
 * Writes `name` in the output directory as a new file: whatever was there (a file, or a symlink
 * planted to redirect the write) is removed first, and the create fails rather than follow a
 * symlink that appears in between (`wx` is O_CREAT|O_EXCL, which never follows one).
 */
export function writeArtifact(dir: string, name: string, text: string): void {
  const file = path.join(dir, name)
  rmSync(file, { force: true })
  writeFileSync(file, text, { flag: "wx", mode: 0o644 })
}
