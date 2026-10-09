// Pull request review jobs (jobs-v1 "Pull request review", additive 2026-10-08; platform ADR 0028;
// docs/platform/jobs-v1.md): the spec section `spec.review` (`JobSpecReview`), the findings a review
// job reports in its result (`JobReviewOutput`, checked like the platform's `parseJobReviewOutput`)
// and the record the `review` tool writes in kete's state directory, which `kete job run` reads into
// its `--json` result. Hand-written strict checks, so the CLI (which can't use core) and core's
// `review` tool refuse exactly what the contract refuses: unknown fields at any level, every bound.
// The entrypoint checks the result again in Go (kete-job-entrypoint internal/platform/review.go).

export * as KeteReview from "./review.js"

import { mkdir, open, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { KeteOrchestrationSpec } from "./orchestration-spec.js"

/** JOB_REVIEW_MAX_FINDINGS: no review carries more findings (a spec's `max_findings` may lower it). */
export const maxFindings = 50
/** JOB_REVIEW_SUMMARY_MAX_CHARS (JavaScript string length). */
export const summaryMaxChars = 4000
/** JOB_REVIEW_BODY_MAX_CHARS. */
export const bodyMaxChars = 2000
export const titleMaxChars = 200
export const pathMaxChars = 1024
export const maxLine = 1_000_000
/** JOB_REVIEW_MAX_BYTES: the serialized review (UTF-8 JSON). */
export const maxBytes = 64 * 1024
const maxPullNumber = 2_147_483_647

export const severities = ["info", "minor", "major", "critical"] as const
export type Severity = (typeof severities)[number]
export const sides = ["RIGHT", "LEFT"] as const
export type Side = (typeof sides)[number]

/** `spec.review` (JobSpecReview). */
export interface Spec {
  readonly version: 1
  readonly pull_number: number
  readonly head_sha: string
  readonly base_ref: string
  readonly head_ref: string
  readonly untrusted: boolean
  readonly max_findings: number
}

/** One finding (JobReviewFinding). `side` absent means RIGHT. */
export interface Finding {
  readonly path: string
  readonly line: number
  readonly side?: Side
  readonly severity: Severity
  readonly title?: string
  readonly body: string
}

/** `result.review` (JobReviewOutput). */
export interface Output {
  readonly version: 1
  readonly summary: string
  readonly findings: ReadonlyArray<Finding>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
const gitSha = /^[0-9a-f]{40}$/

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const own = Object.keys(value)
  return own.length === keys.length && own.every((k) => keys.includes(k))
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((k) => keys.includes(k))
}

export type ParsedSpec = { readonly ok: true; readonly spec: Spec } | { readonly ok: false; readonly field: string }

/** Parses `spec.review`; on failure names the first bad field (never a value). `head_ref` must be
 * exactly `refs/pull/<pull_number>/head` (the platform always compiles it so). */
export function parseSpec(value: unknown, base = "review"): ParsedSpec {
  const fail = (field: string): ParsedSpec => ({ ok: false, field: `${base}.${field}` })
  if (!isObject(value)) return { ok: false, field: base }
  if (!exactKeys(value, ["version", "pull_number", "head_sha", "base_ref", "head_ref", "untrusted", "max_findings"]))
    return fail("(unknown or missing field)")
  if (value.version !== 1) return fail("version")
  if (!isInt(value.pull_number, 1, maxPullNumber)) return fail("pull_number")
  if (typeof value.head_sha !== "string" || !gitSha.test(value.head_sha)) return fail("head_sha")
  if (typeof value.base_ref !== "string" || !KeteOrchestrationSpec.validGitRef(value.base_ref)) return fail("base_ref")
  if (value.head_ref !== `refs/pull/${value.pull_number}/head`) return fail("head_ref")
  if (typeof value.untrusted !== "boolean") return fail("untrusted")
  if (!isInt(value.max_findings, 1, maxFindings)) return fail("max_findings")
  return {
    ok: true,
    spec: {
      version: 1,
      pull_number: value.pull_number,
      head_sha: value.head_sha,
      base_ref: value.base_ref,
      head_ref: value.head_ref,
      untrusted: value.untrusted,
      max_findings: value.max_findings,
    },
  }
}

/** A repository path as the contract accepts it: relative, `/`-separated, no empty, `.` or `..`
 * segment, no backslash, no control character, 1–1024 characters. */
export function validPath(value: string): boolean {
  if (value.length < 1 || value.length > pathMaxChars) return false
  if (value.startsWith("/") || value.includes("\\")) return false
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
}

/** The serialized size the platform measures (`JSON.stringify`, UTF-8). */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export type ParsedOutput =
  | { readonly ok: true; readonly review: Output }
  | { readonly ok: false; readonly reason: "missing" | "too_large" | "invalid"; readonly issues: ReadonlyArray<string> }

function findingIssues(value: unknown, at: string): string[] {
  if (!isObject(value)) return [`${at}: must be an object`]
  const issues: string[] = []
  if (!onlyKeys(value, ["path", "line", "side", "severity", "title", "body"]))
    issues.push(`${at}: only path, line, side, severity, title and body are allowed`)
  if (typeof value.path !== "string" || !validPath(value.path))
    issues.push(`${at}.path: a repository-relative path with / separators (no leading /, no . or .. segments, at most ${pathMaxChars} characters)`)
  if (!isInt(value.line, 1, maxLine)) issues.push(`${at}.line: an integer from 1 to ${maxLine}`)
  if (value.side !== undefined && value.side !== "RIGHT" && value.side !== "LEFT") issues.push(`${at}.side: RIGHT or LEFT`)
  if (typeof value.severity !== "string" || !severities.includes(value.severity as Severity))
    issues.push(`${at}.severity: one of ${severities.join(", ")}`)
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > titleMaxChars))
    issues.push(`${at}.title: at most ${titleMaxChars} characters`)
  if (typeof value.body !== "string" || value.body.length < 1 || value.body.length > bodyMaxChars)
    issues.push(`${at}.body: 1 to ${bodyMaxChars} characters`)
  return issues
}

/**
 * `result.review` checked against the contract and the byte cap, as the platform's
 * `parseJobReviewOutput` does (`missing` when absent), plus the spec's `max_findings` (default: the
 * contract's 50). `issues` say what to fix, for the `review` tool's refusal; they never quote values.
 */
export function parseOutput(value: unknown, max: number = maxFindings): ParsedOutput {
  if (value === undefined || value === null) return { ok: false, reason: "missing", issues: ["no review"] }
  let size: number
  try {
    size = serializedBytes(value)
  } catch {
    return { ok: false, reason: "invalid", issues: ["not serializable"] }
  }
  if (size > maxBytes)
    return { ok: false, reason: "too_large", issues: [`the review is ${size} bytes serialized; at most ${maxBytes} are accepted`] }
  if (!isObject(value)) return { ok: false, reason: "invalid", issues: ["must be an object"] }
  const issues: string[] = []
  if (!exactKeys(value, ["version", "summary", "findings"])) issues.push("only version, summary and findings are allowed")
  if (value.version !== 1) issues.push("version: must be 1")
  if (typeof value.summary !== "string" || value.summary.length > summaryMaxChars)
    issues.push(`summary: at most ${summaryMaxChars} characters`)
  const limit = Math.min(Math.max(1, Math.trunc(max)), maxFindings)
  if (!Array.isArray(value.findings)) issues.push("findings: must be an array")
  else {
    if (value.findings.length > limit) issues.push(`findings: at most ${limit}`)
    value.findings.forEach((finding, index) => issues.push(...findingIssues(finding, `findings[${index}]`)))
  }
  if (issues.length > 0) return { ok: false, reason: "invalid", issues }
  return { ok: true, review: value as unknown as Output }
}

// ---------------------------------------------------------------- the record

/** Where the `review` tool records the review, beneath kete's state directory. It lives in kete's
 * home, which the job's tools (another user) can't write, and a review job runs no tool process. */
export const recordFileName = "review.json"
const maxRecordBytes = 2 * maxBytes

export function recordPath(stateDirectory: string): string {
  return path.join(stateDirectory, recordFileName)
}

/** Writes the record atomically (a temporary file, then rename), private to kete's user. */
export async function writeRecord(stateDirectory: string, review: Output): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const target = recordPath(stateDirectory)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(review), { mode: 0o600 })
  await rename(temporary, target)
}

/** Removes a record left from before this run (none exists in a fresh job). */
export async function removeRecord(stateDirectory: string): Promise<void> {
  await rm(recordPath(stateDirectory), { force: true })
}

export type ReadRecord =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly review: Output }
  | { readonly kind: "invalid"; readonly reason: string }

/** Reads the record and checks it again (`max` is the spec's `max_findings`): none, a valid review,
 * or why it can't be used. A record over twice the byte cap is not read. */
export async function readRecord(stateDirectory: string, max: number = maxFindings): Promise<ReadRecord> {
  let handle
  try {
    handle = await open(recordPath(stateDirectory), "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" }
    return { kind: "invalid", reason: "the review record could not be opened" }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxRecordBytes) return { kind: "invalid", reason: "the review record is too large" }
    const text = await handle.readFile("utf8")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { kind: "invalid", reason: "the review record is not JSON" }
    }
    const parsed = parseOutput(value, max)
    return parsed.ok ? { kind: "ok", review: parsed.review } : { kind: "invalid", reason: `the review record is ${parsed.reason}` }
  } finally {
    await handle.close()
  }
}
