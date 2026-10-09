// `kete job run`'s spec v1: a JSON document describing one unattended run (ADR 0005/0008). Parsing
// is pure over injected file access (`Deps`), so `job-run.ts` and its tests never touch the real
// filesystem through this module. Every error names the field that's wrong, `path.to.field:
// reason`, so a spec author can find the problem without reading this file.
//
// `policy` is validated against the exact rules `@opencode/schema/kete/unattended`'s `Policy`
// schema encodes (the runtime decodes a session's `kete.unattended` metadata with the same
// schema — `core/src/kete/unattended-policy.ts` re-exports it) — the CLI can't import core
// (`test/import-boundaries.test.ts`), so this module and the runtime both depend on the shared
// schema module instead of hand-checked rules that could drift from it. The constructed policy is
// re-decoded through that schema as a final consistency check (`parsePolicy`'s last step); a
// mismatch there is a bug in this file, not a bad spec.

export * as JobSpec from "./job-spec.js"

import path from "node:path"
import { SchemaParser } from "effect"
import { KeteUnattendedSchema } from "@opencode/schema/kete/unattended"
import { KeteOrchestrationSpec } from "@opencode/util/kete/orchestration-spec"
import { Model } from "@opencode/schema/model"

/** A job's `policy`: the shared schema's `Policy`, with `budget`/`timeout` required — a job always
 * has both (the runtime refuses an unattended run without them either way; this fails fast). */
export interface Policy extends KeteUnattendedSchema.Policy {
  readonly budget: number
  readonly timeout: number
}

export interface Spec {
  readonly version: 1
  readonly prompt: string
  readonly agent?: string
  readonly model?: string
  readonly policy: Policy
  readonly branch?: string
  /** An orchestrated job's section (jobs-v1 `JobSpecOrchestration`): only the cloud job entrypoint
   * writes it, copied from a claim that carried it; `kete job run` accepts it only in job mode. */
  readonly orchestration?: KeteOrchestrationSpec.Spec
}

export class SpecError extends Error {
  override readonly name = "JobSpec.SpecError"
}

/** File access the parser needs, injected so it stays pure and testable. */
export interface Deps {
  readonly readFile: (file: string) => Promise<string>
  readonly stat: (file: string) => Promise<{ readonly size: number; readonly isFile: () => boolean }>
  /** Resolves symlinks (`fs.realpath`) — used to confine `prompt_file` to the spec's own
   * directory even through a symlink. */
  readonly realpath: (file: string) => Promise<string>
}

const MAX_PROMPT_FILE_BYTES = 256 * 1024

/** Actions a policy's `allow` rules can never grant — matches core's `neverAllowed`
 * (`core/src/kete/unattended-policy.ts`); a job spec refuses them outright rather than accept a
 * rule the runtime would ignore. */
const NEVER_ALLOWED: ReadonlySet<string> = new Set(["question", "budget"])

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["version", "prompt", "prompt_file", "agent", "model", "policy", "branch", "orchestration"])
const POLICY_KEYS: ReadonlySet<string> = new Set(["version", "allow", "budget", "timeout"])
const ALLOW_RULE_KEYS: ReadonlySet<string> = new Set(["action", "resource"])

/** No spaces/control chars, no `..`, `@{`, `\`, `~^:?*[`, no leading `-`/`/`, no trailing
 * `/`/`.lock`/`.` — a pure subset of `git check-ref-format`'s rules, deliberately conservative. */
function validRefName(name: string): boolean {
  if (name.length === 0) return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  if (name.includes("..") || name.includes("@{")) return false
  if (name.startsWith("-") || name.startsWith("/")) return false
  if (name.endsWith("/") || name.endsWith(".lock") || name.endsWith(".")) return false
  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(fieldPath: string, reason: string): never {
  throw new SpecError(`${fieldPath}: ${reason}`)
}

function checkExtraKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, base: string) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(base ? `${base}.${key}` : key, "unknown field")
}

function parsePolicy(raw: Record<string, unknown>): Policy {
  const policyRaw = raw["policy"]
  if (policyRaw === undefined) fail("policy", "missing")
  if (!isPlainObject(policyRaw)) fail("policy", "must be an object")
  checkExtraKeys(policyRaw, POLICY_KEYS, "policy")

  if (policyRaw["version"] !== undefined && policyRaw["version"] !== 1) fail("policy.version", "must be 1")

  const budgetRaw = policyRaw["budget"]
  if (budgetRaw === undefined) fail("policy.budget", "missing")
  if (typeof budgetRaw !== "number" || !Number.isFinite(budgetRaw) || budgetRaw <= 0)
    fail("policy.budget", "must be a number greater than 0")

  const timeoutRaw = policyRaw["timeout"]
  if (timeoutRaw === undefined) fail("policy.timeout", "missing")
  if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0)
    fail("policy.timeout", "must be a number greater than 0")

  let allow: ReadonlyArray<KeteUnattendedSchema.AllowRule> | undefined
  const allowRaw = policyRaw["allow"]
  if (allowRaw !== undefined) {
    if (!Array.isArray(allowRaw)) fail("policy.allow", "must be an array")
    allow = allowRaw.map((item, index) => {
      const base = `policy.allow[${index}]`
      if (!isPlainObject(item)) fail(base, "must be an object")
      checkExtraKeys(item, ALLOW_RULE_KEYS, base)
      const action = item["action"]
      if (typeof action !== "string" || action.length === 0) fail(`${base}.action`, "must be a non-empty string")
      if (NEVER_ALLOWED.has(action)) fail(`${base}.action`, `"${action}" can never be allowed in an unattended run`)
      const resource = item["resource"]
      if (typeof resource !== "string" || resource.length === 0) fail(`${base}.resource`, "must be a non-empty string")
      return { action, resource }
    })
  }

  const policy: Policy = { version: 1, budget: budgetRaw, timeout: timeoutRaw, ...(allow ? { allow } : {}) }
  const check = SchemaParser.decodeUnknownResult(KeteUnattendedSchema.Policy)(policy, { onExcessProperty: "error" })
  if (check._tag === "Failure")
    fail("policy", "internal: does not match the runtime's policy schema (this is a bug in job-spec.ts, not the spec file)")
  return policy
}

/**
 * Parses and validates a job spec (JSON only, unknown fields rejected at every level), resolving
 * `prompt_file` relative to `options.specDir` (the spec file's own directory) through
 * `options.deps`. Throws `SpecError` naming the first problem found — nothing is started or read
 * beyond what validation needs.
 */
export async function parse(text: string, options: { readonly specDir: string; readonly deps: Deps }): Promise<Spec> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    fail("$", `invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isPlainObject(raw)) fail("$", "must be a JSON object")
  checkExtraKeys(raw, TOP_LEVEL_KEYS, "")

  if (raw["version"] !== 1) fail("version", "must be 1")

  const hasPrompt = raw["prompt"] !== undefined
  const hasPromptFile = raw["prompt_file"] !== undefined
  if (!hasPrompt && !hasPromptFile) fail("prompt", "exactly one of prompt or prompt_file is required")
  if (hasPrompt && hasPromptFile) fail("prompt_file", "exactly one of prompt or prompt_file is required")

  let prompt: string
  if (hasPrompt) {
    const value = raw["prompt"]
    if (typeof value !== "string") fail("prompt", "must be a string")
    if (value.trim().length === 0) fail("prompt", "must not be empty")
    prompt = value
  } else {
    const value = raw["prompt_file"]
    if (typeof value !== "string" || value.trim().length === 0) fail("prompt_file", "must be a non-empty string")
    const resolved = path.resolve(options.specDir, value)

    // Containment: resolve symlinks on both sides, then require the file's real path to sit
    // inside the spec directory's real path — catches `..` segments, absolute paths, and a
    // symlink (inside the directory) pointing outside it alike. Everything after this reads the
    // checked real path, never `resolved`, so swapping a symlink after the check can't redirect
    // the read.
    const realSpecDir = await options.deps.realpath(options.specDir).catch((error: unknown) => {
      fail("prompt_file", `could not resolve the job spec's directory: ${error instanceof Error ? error.message : String(error)}`)
    })
    const realFile = await options.deps.realpath(resolved).catch(() => {
      fail("prompt_file", `not found: ${resolved}`)
    })
    const relative = path.relative(realSpecDir, realFile)
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
      fail("prompt_file", "must be inside the job spec's directory")

    const info = await options.deps.stat(realFile).catch(() => undefined)
    if (info === undefined) fail("prompt_file", `not found: ${resolved}`)
    if (!info.isFile()) fail("prompt_file", `not a regular file: ${resolved}`)
    if (info.size > MAX_PROMPT_FILE_BYTES) fail("prompt_file", `too large, over ${MAX_PROMPT_FILE_BYTES / 1024} KiB: ${resolved}`)
    const content = await options.deps.readFile(realFile).catch((error: unknown) => {
      fail("prompt_file", `failed to read ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
    })
    // The file may have grown between the stat and the read.
    if (Buffer.byteLength(content, "utf8") > MAX_PROMPT_FILE_BYTES)
      fail("prompt_file", `too large, over ${MAX_PROMPT_FILE_BYTES / 1024} KiB: ${resolved}`)
    if (content.trim().length === 0) fail("prompt_file", "must not be empty")
    prompt = content
  }

  let agent: string | undefined
  if (raw["agent"] !== undefined) {
    const value = raw["agent"]
    if (typeof value !== "string" || value.length === 0) fail("agent", "must be a non-empty string")
    agent = value
  }

  let model: string | undefined
  if (raw["model"] !== undefined) {
    const value = raw["model"]
    if (typeof value !== "string" || value.length === 0) fail("model", "must be a non-empty string")
    try {
      Model.Ref.parse(value)
    } catch (error) {
      fail("model", error instanceof Error ? error.message : "invalid model reference")
    }
    model = value
  }

  const policy = parsePolicy(raw)

  let branch: string | undefined
  if (raw["branch"] !== undefined) {
    const value = raw["branch"]
    if (typeof value !== "string" || value.length === 0) fail("branch", "must be a non-empty string")
    if (!validRefName(value)) fail("branch", "is not a valid git branch name")
    branch = value
  }

  let orchestration: KeteOrchestrationSpec.Spec | undefined
  if (raw["orchestration"] !== undefined) {
    const parsed = KeteOrchestrationSpec.parse(raw["orchestration"])
    if (!parsed.ok) fail(parsed.field, "is not a valid orchestration section (jobs-v1 JobSpecOrchestration)")
    orchestration = parsed.spec
    if (branch === undefined) fail("branch", "an orchestrated job always names its branch")
  }

  return { version: 1, prompt, agent, model, policy, branch, ...(orchestration ? { orchestration } : {}) }
}
