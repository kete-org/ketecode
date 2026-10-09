// Kete mirror of kete-code-platform `packages/shared/src/api/v1/orchestrations.ts` (orchestrations-v1;
// standalone copy docs/platform/orchestrations-v1.md, whose schema block this file reproduces below the
// "jobs-v1, sync-v1 and errors pieces" section unchanged but for formatting). Kept field-for-field equal
// so a plan the platform would refuse is refused here first, with a local error, before anything is
// sent (CLAUDE.md §10); zod, not Effect Schema, so the two copies stay diffable. Checked against the
// shared vectors (docs/platform/test-vectors/orchestrations-v1/, test/kete/orchestration-contract.test.ts).
// When the platform changes its copy, change this one the same way (docs/context/contracts.md).
import { z } from "zod"
import { KeteDag } from "../dag.js"

// ---------------------------------------------------------------- jobs-v1, sync-v1 and errors pieces
// (kete-code-platform packages/shared/src/api/v1/{jobs,sync,errors}.ts; docs/platform/jobs-v1.md)

export const ErrorCode = z.enum([
  "invalid_request",
  "invalid_key",
  "forbidden",
  "not_found",
  "expired",
  "rate_limited",
  "internal",
  "insufficient_balance",
  "conflict",
  "not_permitted",
  "unavailable",
])
export const AgentSlug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(60)

export const JOB_PROMPT_MAX_BYTES = 262_144
export const JOB_BUDGET_MAX_MICROS = 25_000_000
export const JOB_TIMEOUT_MAX_MINUTES = 120
export const JOB_ALLOW_MAX_RULES = 50
export const JOB_LIST_PAGE_SIZE = 50
export const JOB_SUMMARY_MAX_BYTES = 4096

export const JobStatus = z.enum([
  "queued",
  "provisioning",
  "running",
  "finalizing",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
])
export const JobPushStatus = z.enum([
  "not_requested",
  "pending",
  "created",
  "no_changes",
  "refused",
  "failed",
  "incomplete",
])
export const JobOutcome = z.string().min(1).max(40)

const jobUtf8Bytes = (s: string) => new TextEncoder().encode(s).length
export const JobPrompt = z
  .string()
  .refine((s) => s.trim().length > 0, "The prompt is empty.")
  .refine((s) => jobUtf8Bytes(s) <= JOB_PROMPT_MAX_BYTES, "The prompt is larger than 256 KiB.")

/** A git ref the platform accepts: the database's `job_git_ref_valid`, a conservative subset of git-check-ref-format. */
export function isJobGitRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]{1,255}$/.test(ref) && !/(^[-/.]|\/$|\.$|\/\/|\.\.|\/\.|\.lock(\/|$)|@\{)/.test(ref)
}
export const JobGitRef = z.string().refine(isJobGitRef, "Not a valid branch name.")
export const JOB_BRANCH_PREFIX = "kete/job/"
/** Always `kete/job/<suffix>`. */
export const JobBranch = z
  .string()
  .refine((b) => b.startsWith(JOB_BRANCH_PREFIX) && b.length > JOB_BRANCH_PREFIX.length && isJobGitRef(b))
/** 8 hex digits, alone or followed by `-` (any case): the platform's namespace (jobs-v1, 2026-10-09). */
export function isReservedJobBranchSuffix(suffix: string): boolean {
  return /^[0-9a-f]{8}(?:-|$)/i.test(suffix)
}
export const JobBranchSuffix = z
  .string()
  .refine((s) => s.length > 0 && isJobGitRef(`${JOB_BRANCH_PREFIX}${s}`), "Not a valid branch suffix.")
  .refine((s) => !isReservedJobBranchSuffix(s), "This suffix is reserved for branches the platform names.")
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/)
export const JobAllowRule = z.strictObject({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
})

export const ORCHESTRATION_MAX_TURNS = 6
export const ORCHESTRATION_MAX_ATTEMPTS = 3
export const ORCHESTRATION_MAX_NODES = 16
export const ORCHESTRATION_MAX_FETCH = ORCHESTRATION_MAX_NODES + 1
export const OrchestrationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const OrchestrationNodeKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .refine((k) => k !== "plan" && !k.startsWith("plan-"), "Reserved node key.")
export type OrchestrationNodeKey = z.infer<typeof OrchestrationNodeKey>
export function orchestrationShortId(id: string): string {
  return id.slice(0, 8)
}
export function orchestrationPlanBranch(id: string, rev: number): string {
  return `${JOB_BRANCH_PREFIX}${orchestrationShortId(id)}-plan-${rev}`
}
export function orchestrationNodeBranch(id: string, key: string): string {
  return `${JOB_BRANCH_PREFIX}${orchestrationShortId(id)}-${key}`
}
export const OrchestrationRole = z.enum(["coordinator", "worker"])
export const OrchestrationTitles = z.enum(["omit", "send"])
export type OrchestrationTitles = z.infer<typeof OrchestrationTitles>
export const ORCHESTRATION_PLAN_PATH = ".kete-orchestration/plan.json"
export const OrchestrationPlanRef = z.strictObject({
  rev: z.number().int().min(1).max(ORCHESTRATION_MAX_TURNS),
  branch: JobBranch,
  sha: GitSha,
})
export type OrchestrationPlanRef = z.infer<typeof OrchestrationPlanRef>

// ---------------------------------------------------------------- orchestrations-v1 (the platform's file)

/**
 * Orchestration API v1 — orchestrated jobs (platform ADR 0026, kete-code ADR 0012; design: kete-code
 * docs/tasks/2026-10-07-cross-runner-orchestration/spec.md). An orchestration is one task split by a
 * coordinating agent into a DAG of nodes; every coordinator turn and every node attempt is an ordinary
 * job (jobs-v1, claim feature `orchestration_v1`). The platform holds metadata only — keys,
 * dependencies, budgets, states, branch names, SHAs, digests; prompts and notes live in the plan file
 * (`.kete-orchestration/plan.json`) on a plan branch in the zone's own repository.
 *
 * User routes (`POST/GET /api/v1/orchestrations`, `GET …/{id}`, `POST …/{id}/cancel`,
 * `POST …/{id}/nodes/{key}/cancel`) authenticate like jobs-v1's user routes (a portal session or a
 * `user`/`cli` key, never a `job` key). Coordinator routes (`GET /api/v1/jobs/{id}/orchestration`,
 * `PUT …/orchestration/plan`, `POST …/orchestration/decision`) authenticate with the coordinator
 * turn's own job key while that job is `running`. Request bodies are strict; responses only gain
 * fields. Money is integer USD micros. Standalone copy for the kete-code repo:
 * docs/contracts/orchestrations-v1.md.
 */

// ---------------------------------------------------------------- limits and defaults

/**
 * Contract maxima (spec Appendix E). The platform may configure lower values; it reports the ones in
 * force in `OrchestrationLimits`, and the runtime validates against those.
 */
export const ORCHESTRATION_MAX_NODES_PER_PLAN = 8
export const ORCHESTRATION_MAX_JOBS = 32
export const ORCHESTRATION_MAX_PARALLEL = 8
export const ORCHESTRATION_MAX_PARALLEL_DEFAULT = 4
export const ORCHESTRATION_MAX_WORKER_AGENTS = 8
/** A node depends on at most every other node. */
export const ORCHESTRATION_MAX_DEPENDENCIES = ORCHESTRATION_MAX_NODES - 1
/** The least a node may be given (each node's `budget_micros`). */
export const ORCHESTRATION_MIN_NODE_BUDGET_MICROS = 250_000
/**
 * The smallest budget that can fund anything: a running turn and the reserve (each at least 0.50 USD)
 * plus one node. Every creation also needs `budget ≥ 2 × reserve + ORCHESTRATION_MIN_NODE_BUDGET_MICROS`.
 */
export const ORCHESTRATION_BUDGET_MIN_MICROS = 1_250_000
export const ORCHESTRATION_BUDGET_DEFAULT_MICROS = 10_000_000
export const ORCHESTRATION_BUDGET_MAX_MICROS = 100_000_000
/** The coordinator-turn reserve: 15 % of the budget, at least 0.50 USD, at most a job's maximum. */
export const ORCHESTRATION_RESERVE_MIN_MICROS = 500_000
export const ORCHESTRATION_TIMEOUT_DEFAULT_MINUTES = 120
export const ORCHESTRATION_TIMEOUT_MAX_MINUTES = 480
export const ORCHESTRATION_INTEGRATION_RESERVE_MINUTES = 30
/** The plan file; one node's prompt; the coordinator's notes (UTF-8 bytes). */
export const ORCHESTRATION_PLAN_FILE_MAX_BYTES = 262_144
export const ORCHESTRATION_NODE_PROMPT_MAX_BYTES = 65_536
export const ORCHESTRATION_NOTES_MAX_BYTES = 32_768
export const ORCHESTRATION_TITLE_MAX_CHARS = 80
/** The directory no bundle but a plan bundle may touch. */
export const ORCHESTRATION_DIR = ".kete-orchestration"

/** The default coordinator-turn reserve for a budget. */
export function defaultCoordinatorTurnBudget(budgetMicros: number): number {
  return Math.min(
    JOB_BUDGET_MAX_MICROS,
    Math.max(ORCHESTRATION_RESERVE_MIN_MICROS, Math.floor((budgetMicros * 15) / 100)),
  )
}

// ---------------------------------------------------------------- enums

/** The orchestration's status (spec Appendix D). Only `orchestration_transition` writes it. */
export const OrchestrationStatus = z.enum([
  "queued",
  "coordinating",
  "running_nodes",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
])
export type OrchestrationStatus = z.infer<typeof OrchestrationStatus>
export const TERMINAL_ORCHESTRATION_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly OrchestrationStatus[]

/**
 * A node's state: `pending` (dependencies not done) → `ready` (waiting for capacity) → `running` (an
 * attempt's job is open) → `succeeded` | `succeeded_empty` (no changes) | `failed`; `pending` →
 * `blocked` (a dependency didn't succeed); `pending`/`ready`/`blocked` → `superseded` (a later plan
 * revision left it out) or `cancelled`. A coordinator retry moves `failed`/`blocked`/`cancelled` back
 * to `pending` with a new attempt.
 */
export const OrchestrationNodeState = z.enum([
  "pending",
  "ready",
  "running",
  "succeeded",
  "succeeded_empty",
  "failed",
  "blocked",
  "superseded",
  "cancelled",
])
export type OrchestrationNodeState = z.infer<typeof OrchestrationNodeState>
/** States a dependency may be in when a plan revision names it without redefining it. */
export const ORCHESTRATION_DONE_STATES = [
  "succeeded",
  "succeeded_empty",
] as const satisfies readonly OrchestrationNodeState[]

/** How a coordinator turn ends the orchestration: integrate this turn's change, or end it failed. */
export const OrchestrationDecision = z.enum(["integrated", "abandon"])
export type OrchestrationDecision = z.infer<typeof OrchestrationDecision>

/**
 * `outcome` of a terminal orchestration: a string (like `Job.outcome`), not an enum. These are the
 * values known today.
 */
export const ORCHESTRATION_OUTCOMES = [
  "integrated",
  "no_changes",
  "abandoned",
  "coordinator_no_decision",
  "coordinator_failed",
  "turn_limit",
  "budget_exhausted",
  "integration_refused",
  "deadline",
  "requested",
  "org_disabled",
  "flag_off",
  "requester_removed",
] as const

// ---------------------------------------------------------------- shared pieces

const encoder = new TextEncoder()
const utf8Bytes = (s: string) => encoder.encode(s).length
/** A lone UTF-16 surrogate: JSON can encode one (`\ud800`) but UTF-8 can't, so it is refused everywhere. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE.source, "g")
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001F\u007F]/
const Timestamp = z.iso.datetime({ offset: true })
const Micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/** A node's title: one line, 1–80 characters, not blank. Sent to the platform only where titles may leave. */
export const OrchestrationTitle = z
  .string()
  .min(1)
  .max(ORCHESTRATION_TITLE_MAX_CHARS)
  .refine((t) => t.trim().length > 0 && !CONTROL.test(t) && !LONE_SURROGATE.test(t), "Not a one-line title.")

/** A node's prompt: 1 byte to 64 KiB of UTF-8, not blank. In-zone only (the plan file). */
export const OrchestrationNodePrompt = z
  .string()
  .refine((s) => s.trim().length > 0, "The prompt is empty.")
  .refine((s) => !LONE_SURROGATE.test(s), "Not UTF-8.")
  .refine((s) => utf8Bytes(s) <= ORCHESTRATION_NODE_PROMPT_MAX_BYTES, "The prompt is larger than 64 KiB.")

/** The coordinator's notes for later turns: up to 32 KiB of UTF-8 (may be empty). In-zone only. */
export const OrchestrationNotes = z
  .string()
  .refine((s) => !LONE_SURROGATE.test(s), "Not UTF-8.")
  .refine((s) => utf8Bytes(s) <= ORCHESTRATION_NOTES_MAX_BYTES, "The notes are larger than 32 KiB.")

const NodeBudget = z.number().int().min(ORCHESTRATION_MIN_NODE_BUDGET_MICROS).max(JOB_BUDGET_MAX_MICROS)
const NodeTimeout = z.number().int().min(1).max(JOB_TIMEOUT_MAX_MINUTES)
const MaxAttempts = z.number().int().min(1).max(ORCHESTRATION_MAX_ATTEMPTS)
const MaxParallel = z.number().int().min(1).max(ORCHESTRATION_MAX_PARALLEL)
const PlanRev = z.number().int().min(1).max(ORCHESTRATION_MAX_TURNS)
const Dependencies = z.array(OrchestrationNodeKey).max(ORCHESTRATION_MAX_DEPENDENCIES)
const uniqueKeys = (nodes: readonly { key: string }[]) => new Set(nodes.map((n) => n.key)).size === nodes.length

// ---------------------------------------------------------------- the plan file (in-zone only)

/**
 * One node in the plan file. `prompt` is the node's whole instruction; `depends_on` orders it after
 * other nodes; `base_from` (an ancestor in the DAG, or null for the orchestration's base) is the node
 * whose branch it starts from. `agent`, `budget_micros`, `timeout_minutes` and `max_attempts` are the
 * coordinator's request; the platform's spec is what the node gets.
 */
export const OrchestrationPlanFileNode = z.strictObject({
  key: OrchestrationNodeKey,
  title: OrchestrationTitle.optional(),
  prompt: OrchestrationNodePrompt,
  depends_on: Dependencies,
  base_from: OrchestrationNodeKey.nullable(),
  agent: AgentSlug,
  budget_micros: NodeBudget,
  timeout_minutes: NodeTimeout,
  max_attempts: MaxAttempts,
})
export type OrchestrationPlanFileNode = z.infer<typeof OrchestrationPlanFileNode>

/**
 * `.kete-orchestration/plan.json` (≤ 256 KiB of UTF-8 JSON, no byte order mark): the one file of a
 * plan branch. `rev` is the revision it becomes when committed; `max_parallel` optionally lowers the
 * orchestration's. Node keys are unique.
 */
export const OrchestrationPlanFile = z
  .strictObject({
    version: z.literal(1),
    orchestration_id: OrchestrationId,
    rev: PlanRev,
    notes: OrchestrationNotes,
    max_parallel: MaxParallel.optional(),
    nodes: z.array(OrchestrationPlanFileNode).min(1).max(ORCHESTRATION_MAX_NODES_PER_PLAN),
  })
  .refine((p) => uniqueKeys(p.nodes), { path: ["nodes"], message: "Duplicate node key." })
export type OrchestrationPlanFile = z.infer<typeof OrchestrationPlanFile>

export type OrchestrationPlanFileRefusal = "too_large" | "not_utf8" | "not_json" | "not_canonical" | "invalid"

class PlanJsonError extends Error {
  constructor(readonly reason: "not_json" | "not_canonical") {
    super(reason)
  }
}

/**
 * Strict JSON (RFC 8259) for plan files, so every implementation reads the same bytes the same way:
 * syntax errors are `not_json`; a number that isn't a canonical non-negative integer (`0` or a
 * non-zero digit then digits: no sign, fraction, exponent or leading zero) and an object with two
 * members whose names are equal, or equal ignoring ASCII case, are `not_canonical`. Strings are
 * decoded by `JSON.parse` once their extent is known.
 */
const fail = (): never => {
  throw new PlanJsonError("not_json")
}

/** The deepest nesting a plan file may have (Kete addition, also in the Go reader). */
export const PLAN_JSON_MAX_DEPTH = 8

function parsePlanJson(text: string): unknown {
  let i = 0
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++
  }
  const string = (): string => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
    if (i >= text.length) fail()
    i++
    try {
      return JSON.parse(text.slice(start, i)) as string
    } catch {
      return fail()
    }
  }
  const inner = (): unknown => {
    ws()
    const c = text[i]
    if (c === "{") {
      i++
      const out: Record<string, unknown> = {}
      const seen = new Set<string>()
      ws()
      if (text[i] === "}") {
        i++
        return out
      }
      for (;;) {
        ws()
        if (text[i] !== '"') fail()
        const key = string()
        const folded = key.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
        if (seen.has(folded)) throw new PlanJsonError("not_canonical")
        seen.add(folded)
        ws()
        if (text[i] !== ":") fail()
        i++
        Object.defineProperty(out, key, { value: value(), enumerable: true, writable: true, configurable: true })
        ws()
        if (text[i] === ",") {
          i++
          continue
        }
        if (text[i] === "}") {
          i++
          return out
        }
        return fail()
      }
    }
    if (c === "[") {
      i++
      const out: unknown[] = []
      ws()
      if (text[i] === "]") {
        i++
        return out
      }
      for (;;) {
        out.push(value())
        ws()
        if (text[i] === ",") {
          i++
          continue
        }
        if (text[i] === "]") {
          i++
          return out
        }
        return fail()
      }
    }
    if (c === '"') return string()
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length
        return v
      }
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400))
    if (m === null) return fail()
    i += m[0].length
    if (!/^(?:0|[1-9][0-9]*)$/.test(m[0])) throw new PlanJsonError("not_canonical")
    return Number(m[0])
  }
  // Kete addition (both readers): nesting deeper than PLAN_JSON_MAX_DEPTH is not_json, so no reader
  // recurses without bound. A plan file needs 4 levels.
  let depth = 0
  const value = (): unknown => {
    ws()
    if (text[i] !== "{" && text[i] !== "[") return inner()
    if (++depth > PLAN_JSON_MAX_DEPTH) fail()
    try {
      return inner()
    } finally {
      depth--
    }
  }
  const v = value()
  ws()
  if (i !== text.length) fail()
  return v
}

/**
 * The safe reader every side uses for a plan file's bytes: size first, then strict UTF-8 (a byte order
 * mark is not JSON), then strict JSON (`not_json`; canonical integers only and no duplicate or
 * case-variant member names: `not_canonical`), then the strict schema (`invalid`; member names are
 * case-sensitive, so `"Prompt"` is an unknown field).
 */
export function parseOrchestrationPlanFile(
  bytes: Uint8Array,
): { ok: true; plan: OrchestrationPlanFile } | { ok: false; reason: OrchestrationPlanFileRefusal } {
  if (bytes.length > ORCHESTRATION_PLAN_FILE_MAX_BYTES) return { ok: false, reason: "too_large" }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { ok: false, reason: "not_utf8" }
  }
  let value: unknown
  try {
    value = parsePlanJson(text)
  } catch (e) {
    return { ok: false, reason: e instanceof PlanJsonError ? e.reason : "not_json" }
  }
  const parsed = OrchestrationPlanFile.safeParse(value)
  return parsed.success ? { ok: true, plan: parsed.data } : { ok: false, reason: "invalid" }
}

/**
 * A worker's prompt (the entrypoint, after fetching `refs/kete/plan` at its pinned SHA): the plan file
 * must be the orchestration's at the expected revision, name the node, and the node's prompt must have
 * the digest the platform committed (`spec.orchestration.prompt_digest`), else `prompt_mismatch`.
 */
export async function readOrchestrationNodePrompt(
  bytes: Uint8Array,
  expect: { orchestration_id: string; rev: number; key: string; prompt_digest: string },
): Promise<
  | { ok: true; prompt: string }
  | { ok: false; reason: OrchestrationPlanFileRefusal | "plan_mismatch" | "no_such_node" | "prompt_mismatch" }
> {
  const read = parseOrchestrationPlanFile(bytes)
  if (!read.ok) return read
  if (read.plan.orchestration_id !== expect.orchestration_id || read.plan.rev !== expect.rev)
    return { ok: false, reason: "plan_mismatch" }
  const node = read.plan.nodes.find((n) => n.key === expect.key)
  if (!node) return { ok: false, reason: "no_such_node" }
  return (await sha256Hex(encoder.encode(node.prompt))) === expect.prompt_digest
    ? { ok: true, prompt: node.prompt }
    : { ok: false, reason: "prompt_mismatch" }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// ---------------------------------------------------------------- coordinator routes

/**
 * A node as the platform sees it: the plan file's node without `prompt` (its SHA-256 instead) and
 * with `title` only where titles may leave.
 */
export const OrchestrationProposalNode = OrchestrationPlanFileNode.omit({ prompt: true }).extend({
  /** SHA-256 (lowercase hex) of the node's `prompt` in UTF-8. */
  prompt_digest: Sha256Hex,
})
export type OrchestrationProposalNode = z.infer<typeof OrchestrationProposalNode>

/**
 * PUT /api/v1/jobs/{id}/orchestration/plan body: the coordinator's plan revision, metadata only.
 * `plan_digest` is the SHA-256 of the plan file's bytes; the platform commits the revision only when
 * the plan turn's bundle is exactly that file with that digest, and the proposal derived from it
 * (`orchestrationPlanProposal`) equals this one. Re-sending in the same turn replaces the proposal.
 */
export const OrchestrationPlanProposal = z.strictObject({
  version: z.literal(1),
  rev: PlanRev,
  plan_digest: Sha256Hex,
  max_parallel: MaxParallel.optional(),
  nodes: z.array(OrchestrationProposalNode).min(1).max(ORCHESTRATION_MAX_NODES_PER_PLAN),
})
export type OrchestrationPlanProposal = z.infer<typeof OrchestrationPlanProposal>

/**
 * The proposal a plan file stands for: what the coordinator's tool sends, and what the platform (Kete
 * cloud) recomputes from the plan turn's bundle before committing the revision. `titles: 'omit'`
 * drops every title.
 */
export async function orchestrationPlanProposal(
  bytes: Uint8Array,
  titles: OrchestrationTitles,
): Promise<{ ok: true; proposal: OrchestrationPlanProposal } | { ok: false; reason: OrchestrationPlanFileRefusal }> {
  const read = parseOrchestrationPlanFile(bytes)
  if (!read.ok) return read
  const nodes: OrchestrationProposalNode[] = []
  for (const { prompt, title, ...rest } of read.plan.nodes) {
    const node: OrchestrationProposalNode = { ...rest, prompt_digest: await sha256Hex(encoder.encode(prompt)) }
    nodes.push(titles === "send" && title !== undefined ? { ...node, title } : node)
  }
  const proposal: OrchestrationPlanProposal = {
    version: 1,
    rev: read.plan.rev,
    plan_digest: await sha256Hex(bytes),
    nodes,
  }
  if (read.plan.max_parallel !== undefined) proposal.max_parallel = read.plan.max_parallel
  return { ok: true, proposal }
}

/** POST /api/v1/jobs/{id}/orchestration/decision body. Once per turn; it discards a proposal made earlier in the turn. */
export const OrchestrationDecisionRequest = z.strictObject({
  decision: OrchestrationDecision,
  /**
   * The coordinator's summary for the platform: only where the zone's boundary lets summaries leave
   * (`summary` `redacted` or `full`); redacted and cut to 4 KB before storing. The full summary stays
   * in-zone, in the integration PR/MR body.
   */
  summary: z
    .string()
    .refine((t) => utf8Bytes(t) <= JOB_SUMMARY_MAX_BYTES, "The summary is larger than 4 KB.")
    .refine((t) => !t.includes("\u0000") && !LONE_SURROGATE.test(t), "The summary has a NUL or is not UTF-8.")
    .optional(),
})
export type OrchestrationDecisionRequest = z.infer<typeof OrchestrationDecisionRequest>

/** The limits in force for one orchestration (≤ the contract maxima). */
export const OrchestrationLimits = z.object({
  nodes_per_plan: z.number().int().min(1).max(ORCHESTRATION_MAX_NODES_PER_PLAN),
  nodes_total: z.number().int().min(1).max(ORCHESTRATION_MAX_NODES),
  turns: z.number().int().min(1).max(ORCHESTRATION_MAX_TURNS),
  attempts_per_node: z.number().int().min(1).max(ORCHESTRATION_MAX_ATTEMPTS),
  jobs_total: z.number().int().min(1).max(ORCHESTRATION_MAX_JOBS),
  max_parallel: MaxParallel,
})
export type OrchestrationLimits = z.infer<typeof OrchestrationLimits>

/**
 * A node as the coordinator and members see it. `branch` is always `kete/job/<o8>-<key>`;
 * `commit_sha` is the commit recorded when its branch was created (null before, and for
 * `succeeded_empty`). `title` and `summary` (the last attempt's result text, redacted, ≤ 4 KB) are
 * present only where the zone's boundary lets them leave; otherwise null.
 */
export const OrchestrationNode = z.object({
  key: OrchestrationNodeKey,
  title: OrchestrationTitle.nullable(),
  state: OrchestrationNodeState,
  plan_rev: PlanRev,
  depends_on: Dependencies,
  base_from: OrchestrationNodeKey.nullable(),
  agent: AgentSlug,
  prompt_digest: Sha256Hex,
  budget_micros: NodeBudget,
  spent_micros: Micros,
  timeout_minutes: NodeTimeout,
  attempts: z.number().int().min(0).max(ORCHESTRATION_MAX_ATTEMPTS),
  max_attempts: MaxAttempts,
  branch: JobBranch,
  commit_sha: GitSha.nullable(),
  /** The last attempt's job outcome (`Job.outcome`), or null. */
  outcome: JobOutcome.nullable(),
  summary: z.string().nullable(),
})
export type OrchestrationNode = z.infer<typeof OrchestrationNode>

/** The integration result: the push of the turn that decided `integrated`. */
export const OrchestrationIntegration = z.object({
  decision: OrchestrationDecision,
  turn: z.number().int().min(1).max(ORCHESTRATION_MAX_TURNS),
  push_status: JobPushStatus,
  pr_url: z
    .string()
    .regex(/^https:\/\//)
    .max(500)
    .nullable(),
  commit_sha: GitSha.nullable(),
})
export type OrchestrationIntegration = z.infer<typeof OrchestrationIntegration>

/** Money of an orchestration: allocated = Σ(open jobs: max(budget, spent); ended jobs: spent). */
const OrchestrationMoney = {
  budget_micros: Micros.positive(),
  /** Never allocatable to nodes: one coordinator turn's budget, so a final turn can always run. */
  reserve_micros: Micros.positive(),
  allocated_micros: Micros,
  /** The gateway's measured spend over every job (or, without the gateway, the runner's report). */
  spent_micros: Micros,
}

/**
 * GET /api/v1/jobs/{id}/orchestration → 200 (and the 200 of `PUT …/plan` and `POST …/decision`): the
 * orchestration as its coordinator turn needs it. `proposal`: this turn's accepted proposal, if any;
 * `decision`: this turn's decision, if any.
 */
export const OrchestrationCoordinatorView = z.object({
  id: OrchestrationId,
  status: OrchestrationStatus,
  turn: z.number().int().min(1).max(ORCHESTRATION_MAX_TURNS),
  final: z.boolean(),
  plan: OrchestrationPlanRef.nullable(),
  proposal: z.object({ rev: PlanRev, plan_digest: Sha256Hex }).nullable(),
  decision: OrchestrationDecision.nullable(),
  ...OrchestrationMoney,
  deadline: Timestamp,
  max_parallel: MaxParallel,
  worker_agents: z.array(AgentSlug).min(1).max(ORCHESTRATION_MAX_WORKER_AGENTS),
  limits: OrchestrationLimits,
  titles: OrchestrationTitles,
  nodes: z.array(OrchestrationNode).max(ORCHESTRATION_MAX_NODES),
})
export type OrchestrationCoordinatorView = z.infer<typeof OrchestrationCoordinatorView>

export const OrchestrationCoordinatorResponse = z.object({ orchestration: OrchestrationCoordinatorView })
export type OrchestrationCoordinatorResponse = z.infer<typeof OrchestrationCoordinatorResponse>

// ---------------------------------------------------------------- plan validation (both sides)

/**
 * Why a plan revision is refused (`issues` of a 422 `plan_invalid`). The structural ones are
 * `validateOrchestrationPlan`'s, which the runtime runs before sending and the platform runs again
 * under the orchestration lock with the nodes it holds; the rest only the platform can check.
 */
export const OrchestrationPlanIssueCode = z.enum([
  // validateOrchestrationPlan
  "attempts_exhausted",
  "base_from_not_ancestor",
  "cycle",
  "duplicate_dependency",
  "duplicate_key",
  "inactive_dependency",
  "node_running",
  "node_succeeded_changed",
  "self_dependency",
  "too_many_nodes",
  "too_many_total_nodes",
  "title_not_permitted",
  "unknown_dependency",
  // platform only
  "agent_not_permitted",
  "budget_exceeded",
  "jobs_exceeded",
  "max_parallel_too_high",
  "timeout_exceeds_deadline",
])
export type OrchestrationPlanIssueCode = z.infer<typeof OrchestrationPlanIssueCode>

export const OrchestrationPlanIssue = z.object({
  code: OrchestrationPlanIssueCode,
  key: OrchestrationNodeKey.optional(),
})
export type OrchestrationPlanIssue = z.infer<typeof OrchestrationPlanIssue>

/** A node the orchestration already holds (from earlier revisions), as `validateOrchestrationPlan` needs it. */
export type OrchestrationExistingNode = {
  node: Omit<OrchestrationProposalNode, "title">
  state: OrchestrationNodeState
  /** Attempts already made. */
  attempts: number
}

/** Compares UTF-16 code units (not locale order), so every implementation sorts alike. */
const byUnits = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

const DEFAULT_PLAN_LIMITS = {
  nodes_per_plan: ORCHESTRATION_MAX_NODES_PER_PLAN,
  nodes_total: ORCHESTRATION_MAX_NODES,
  attempts_per_node: ORCHESTRATION_MAX_ATTEMPTS,
}

/**
 * What a plan revision asks to allocate: the sum of `budget_micros` over every listed node that will
 * run — new nodes, redefined `pending`/`ready`/`superseded` ones and retries — leaving out only exact
 * repeats of succeeded nodes. The platform refuses the revision (`budget_exceeded`) unless
 * `allocated_micros + cost + reserve_micros ≤ budget_micros`, where `allocated_micros` already counts
 * the running coordinator turn (an open job: the greater of its budget and its spend) and every other
 * job of the orchestration (open: that greater value; ended: its spend). Held `pending`/`ready` nodes
 * have no job yet, so they count only if listed (left out, they are superseded).
 */
export function orchestrationPlanCost(
  nodes: readonly OrchestrationProposalNode[],
  existing: readonly OrchestrationExistingNode[] = [],
): number {
  const held = new Map(existing.map((e) => [e.node.key, e]))
  const seen = new Set<string>()
  let cost = 0
  for (const n of nodes) {
    if (seen.has(n.key)) continue
    seen.add(n.key)
    const e = held.get(n.key)
    if (e !== undefined && (e.state === "succeeded" || e.state === "succeeded_empty") && sameContent(e.node, n))
      continue
    cost += n.budget_micros
  }
  return cost
}

const sameContent = (a: Omit<OrchestrationProposalNode, "title">, b: Omit<OrchestrationProposalNode, "title">) =>
  a.prompt_digest === b.prompt_digest &&
  a.base_from === b.base_from &&
  a.agent === b.agent &&
  a.budget_micros === b.budget_micros &&
  a.timeout_minutes === b.timeout_minutes &&
  a.max_attempts === b.max_attempts &&
  a.depends_on.length === b.depends_on.length &&
  a.depends_on.every((d, i) => d === b.depends_on[i])

/**
 * The DAG rules of one plan revision (`nodes`, already schema-valid) against the nodes the
 * orchestration holds. Listing an existing key redefines it (`pending`, `ready`, `superseded`), retries
 * it (`failed`, `blocked`, `cancelled`: a new attempt) or, for a succeeded node, must repeat it exactly
 * (then it is left as it is). A retry is refused (`attempts_exhausted`) when the attempts already made
 * reach the smallest of the held node's `max_attempts` (as first committed: a revision can lower it,
 * never raise it), the listed `max_attempts` and `limits.attempts_per_node` (the hard cap, ≤ 3).
 * Existing nodes not listed that are `pending`, `ready` or `blocked` become `superseded` when the
 * revision is committed. A dependency is a listed node or an existing `succeeded`/`succeeded_empty`
 * one; listed nodes form no cycle; `base_from` is an ancestor. Under `titles: 'omit'` a listed `title`
 * is refused (`title_not_permitted`). Returns every issue once, sorted by code, then key, comparing
 * UTF-16 code units (none: valid).
 */
export function validateOrchestrationPlan(
  nodes: readonly OrchestrationProposalNode[],
  existing: readonly OrchestrationExistingNode[] = [],
  limits: Pick<OrchestrationLimits, "nodes_per_plan" | "nodes_total" | "attempts_per_node"> = DEFAULT_PLAN_LIMITS,
  titles: OrchestrationTitles = "send",
): OrchestrationPlanIssue[] {
  const issues: OrchestrationPlanIssue[] = []
  const add = (code: OrchestrationPlanIssueCode, key?: string) => {
    if (!issues.some((i) => i.code === code && i.key === key)) issues.push(key === undefined ? { code } : { code, key })
  }
  const held = new Map(existing.map((e) => [e.node.key, e]))
  const listed = new Map<string, Omit<OrchestrationProposalNode, "title">>()
  if (nodes.length > limits.nodes_per_plan) add("too_many_nodes")
  for (const n of nodes) {
    if (listed.has(n.key)) add("duplicate_key", n.key)
    else listed.set(n.key, n)
  }
  if (new Set([...held.keys(), ...listed.keys()]).size > limits.nodes_total) add("too_many_total_nodes")

  for (const n of nodes) {
    const e = held.get(n.key)
    if (e?.state === "running") add("node_running", n.key)
    if ((e?.state === "succeeded" || e?.state === "succeeded_empty") && !sameContent(e.node, n))
      add("node_succeeded_changed", n.key)
    if (titles === "omit" && n.title !== undefined) add("title_not_permitted", n.key)
    if (
      (e?.state === "failed" || e?.state === "blocked" || e?.state === "cancelled") &&
      e.attempts >= Math.min(e.node.max_attempts, n.max_attempts, limits.attempts_per_node)
    )
      add("attempts_exhausted", n.key)
    if (new Set(n.depends_on).size !== n.depends_on.length) add("duplicate_dependency", n.key)
    for (const d of n.depends_on) {
      if (d === n.key) add("self_dependency", n.key)
      else if (listed.has(d)) continue
      else if (!held.has(d)) add("unknown_dependency", n.key)
      else if (!(ORCHESTRATION_DONE_STATES as readonly string[]).includes(held.get(d)!.state))
        add("inactive_dependency", n.key)
    }
  }

  // Kahn over the listed nodes' edges between listed nodes: whatever is left is on or behind a cycle.
  // (Kete: the one deviation from the platform's file — the shared KeteDag, which the `workflow` tool
  // uses too; same result, checked by dag.json.)
  for (const k of KeteDag.order([...listed.values()].map((n) => [n.key, n.depends_on] as const)).cycle) add("cycle", k)

  // Ancestors through listed dependencies, then held done nodes' recorded dependencies.
  const depsOf = (k: string): readonly string[] => listed.get(k)?.depends_on ?? held.get(k)?.node.depends_on ?? []
  for (const n of nodes) {
    if (n.base_from === null) continue
    const ancestors = new Set<string>()
    const stack = [...n.depends_on]
    while (stack.length > 0) {
      const k = stack.pop()!
      if (ancestors.has(k) || k === n.key) continue
      ancestors.add(k)
      stack.push(...depsOf(k))
    }
    if (!ancestors.has(n.base_from)) add("base_from_not_ancestor", n.key)
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- the package's lib (ES2022) has no `toSorted`; `issues` is local.
  return issues.sort((a, b) => byUnits(a.code, b.code) || byUnits(a.key ?? "", b.key ?? ""))
}

// ---------------------------------------------------------------- bundles (both validators)

/**
 * A change bundle's manifest entry as the validators see it (kete-code `internal/bundle`; the platform's
 * `lib/jobs/bundle`), with each file's decompressed size.
 */
export type OrchestrationBundleEntry =
  | { path: string; deleted: true }
  | { path: string; mode: "100644" | "100755"; size: number }
export type OrchestrationBundleRefusal = "plan_bundle_shape" | "plan_file_too_large" | "orchestration_path"

/** Code points HFS+ ignores when comparing names (as the bundle validator's fold). */
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g
/** The bundle validator's fold: strip HFS-ignorables and NTFS trailing dots and spaces, then case-fold. */
function foldComponent(component: string): string {
  return component
    .replace(HFS_IGNORABLE, "")
    .replace(/[. ]+$/, "")
    .toUpperCase()
    .toLowerCase()
}

/**
 * The orchestration rule, applied with (after) the bundle validator's own rules. A **plan** bundle (a
 * coordinator turn that committed a plan) is exactly one entry: `.kete-orchestration/plan.json`,
 * spelled exactly so, mode `100644`, ≤ 256 KiB (its content is then read with
 * `parseOrchestrationPlanFile` and its digest checked). **Every other** bundle — node attempts,
 * integrations, plain jobs — refuses any entry with a path component that folds to
 * `.kete-orchestration`, deletions included. null: acceptable.
 */
export function checkOrchestrationBundle(
  entries: readonly OrchestrationBundleEntry[],
  kind: "plan" | "other",
): OrchestrationBundleRefusal | null {
  if (kind === "plan") {
    const [only] = entries
    if (
      entries.length !== 1 ||
      only === undefined ||
      "deleted" in only ||
      only.path !== ORCHESTRATION_PLAN_PATH ||
      only.mode !== "100644"
    )
      return "plan_bundle_shape"
    return only.size > ORCHESTRATION_PLAN_FILE_MAX_BYTES ? "plan_file_too_large" : null
  }
  const dir = foldComponent(ORCHESTRATION_DIR)
  return entries.some((e) => e.path.split("/").some((c) => foldComponent(c) === dir)) ? "orchestration_path" : null
}

/**
 * The commit message of a node's branch (written in-zone: by the platform for Kete cloud, by the
 * runner's publisher for an enterprise): the job's usual first line, the **handoff note** and the
 * trailers, always the last paragraph. `note` is the attempt's result text, already redacted by the
 * caller; control characters other than newline and tab are removed, line ends become `\n`, and it is
 * trimmed and cut to 4 KB at a UTF-8 character boundary (absent when empty). The coordinator reads a
 * node's note from here (`refs/kete/nodes/<key>`), as untrusted input.
 */
export function orchestrationNodeCommitMessage(p: {
  jobId: string
  ciEnabled: boolean
  orchestrationId: string
  key: string
  attempt: number
  note: string
}): string {
  // oxlint-disable-next-line no-control-regex -- removing control characters is the point.
  let note = p.note
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(LONE_SURROGATE_ALL, "")
    .trim()
  const bytes = encoder.encode(note)
  if (bytes.length > JOB_SUMMARY_MAX_BYTES) {
    let end = JOB_SUMMARY_MAX_BYTES
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
    note = new TextDecoder().decode(bytes.slice(0, end)).trim()
  }
  const head = `Kete job ${p.jobId.slice(0, 8)}${p.ciEnabled ? "" : " [skip ci]"}`
  const trailers = `Job: ${p.jobId}\nOrchestration: ${p.orchestrationId}\nNode: ${p.key}\nAttempt: ${p.attempt}`
  return note === "" ? `${head}\n\n${trailers}` : `${head}\n\n${note}\n\n${trailers}`
}

// ---------------------------------------------------------------- user routes

/**
 * POST /api/v1/orchestrations body (header `Idempotency-Key` as jobs-v1). Needs `agents.run` and
 * `jobs.push` (an orchestration always pushes and opens a draft PR/MR). `agent` is the coordinator;
 * `worker_agents` (default: `[agent]`) the agents nodes may use. The integration branch is
 * `kete/job/<branch_suffix>`, default `kete/job/<o8>`; a suffix that starts like another
 * orchestration's branches (8 hex digits and `-`) is refused.
 */
export const CreateOrchestrationRequest = z
  .strictObject({
    project_id: z.guid(),
    repository_id: z.guid(),
    base_ref: JobGitRef.optional(),
    agent: AgentSlug,
    worker_agents: z.array(AgentSlug).min(1).max(ORCHESTRATION_MAX_WORKER_AGENTS).optional(),
    prompt: JobPrompt,
    allow: z.array(JobAllowRule).max(JOB_ALLOW_MAX_RULES).default([]),
    budget_micros: z
      .number()
      .int()
      .min(ORCHESTRATION_BUDGET_MIN_MICROS)
      .max(ORCHESTRATION_BUDGET_MAX_MICROS)
      .default(ORCHESTRATION_BUDGET_DEFAULT_MICROS),
    /**
     * Each coordinator turn's budget, and the reserve held back for a final turn. Default
     * `defaultCoordinatorTurnBudget(budget_micros)`. Refused unless `budget_micros ≥ 2 × this +
     * ORCHESTRATION_MIN_NODE_BUDGET_MICROS` (a running turn, the reserve and one node fit).
     */
    coordinator_turn_budget_micros: z
      .number()
      .int()
      .min(ORCHESTRATION_RESERVE_MIN_MICROS)
      .max(JOB_BUDGET_MAX_MICROS)
      .optional(),
    timeout_minutes: z
      .number()
      .int()
      .min(1)
      .max(ORCHESTRATION_TIMEOUT_MAX_MINUTES)
      .default(ORCHESTRATION_TIMEOUT_DEFAULT_MINUTES),
    max_parallel: MaxParallel.default(ORCHESTRATION_MAX_PARALLEL_DEFAULT),
    branch_suffix: JobBranchSuffix.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.worker_agents && new Set(r.worker_agents).size !== r.worker_agents.length)
      ctx.addIssue({ code: "custom", path: ["worker_agents"], message: "Duplicate agent." })
    if (
      2 * (r.coordinator_turn_budget_micros ?? defaultCoordinatorTurnBudget(r.budget_micros)) +
        ORCHESTRATION_MIN_NODE_BUDGET_MICROS >
      r.budget_micros
    )
      ctx.addIssue({
        code: "custom",
        path: ["coordinator_turn_budget_micros"],
        message: "The budget must cover a turn, the reserve and one node.",
      })
  })
export type CreateOrchestrationRequest = z.infer<typeof CreateOrchestrationRequest>

/** One job of an orchestration (detail view): links to jobs-v1's `GET /api/v1/jobs/{id}`. */
export const OrchestrationJob = z.object({
  id: z.guid(),
  role: OrchestrationRole,
  turn: z.number().int().min(1).max(ORCHESTRATION_MAX_TURNS).optional(),
  node_key: OrchestrationNodeKey.optional(),
  attempt: z.number().int().min(1).max(ORCHESTRATION_MAX_ATTEMPTS).optional(),
  status: JobStatus,
  outcome: JobOutcome.nullable(),
})
export type OrchestrationJob = z.infer<typeof OrchestrationJob>

/**
 * An orchestration as members see it (the "orchestrated job"). `base_sha` is pinned once (turn 1) and
 * used by every job. `partial`: integrated while some node ended `failed`, `blocked` or `cancelled`
 * (the PR/MR stays draft and says which). `reported.summary_text` is the coordinator's summary where
 * the boundary lets it leave. `nodes` and `jobs` only on `GET …/{id}`.
 */
export const Orchestration = z.object({
  id: OrchestrationId,
  status: OrchestrationStatus,
  outcome: JobOutcome.nullable(),
  partial: z.boolean(),
  project_id: z.guid(),
  repository: z.object({ id: z.guid(), full_name: z.string().min(1).max(200), base_ref: JobGitRef }),
  base_sha: GitSha.nullable(),
  execution_target: z.enum(["kete_cloud", "enterprise_private"]),
  agent: z.object({ id: z.guid(), slug: AgentSlug }),
  worker_agents: z.array(AgentSlug).min(1).max(ORCHESTRATION_MAX_WORKER_AGENTS),
  /** The integration branch, `kete/job/<suffix>`. */
  branch: JobBranch,
  ...OrchestrationMoney,
  timeout_minutes: z.number().int().min(1).max(ORCHESTRATION_TIMEOUT_MAX_MINUTES),
  deadline: Timestamp.nullable(),
  max_parallel: MaxParallel,
  turns: z.number().int().min(0).max(ORCHESTRATION_MAX_TURNS),
  plan: OrchestrationPlanRef.nullable(),
  integration: OrchestrationIntegration.nullable(),
  created_by: z.guid(),
  created_at: Timestamp,
  started_at: Timestamp.nullable(),
  ended_at: Timestamp.nullable(),
  reported: z.object({ summary_text: z.string().nullable() }),
  nodes: z.array(OrchestrationNode).max(ORCHESTRATION_MAX_NODES).optional(),
  jobs: z.array(OrchestrationJob).max(ORCHESTRATION_MAX_JOBS).optional(),
})
export type Orchestration = z.infer<typeof Orchestration>

/**
 * POST /api/v1/orchestrations → 201 (200 for an idempotent repeat); GET …/{id} → 200 (with `nodes`,
 * `jobs`, and `prompt` for the requester or `agents.write`); POST …/cancel and …/nodes/{key}/cancel →
 * 202.
 */
export const OrchestrationResponse = z.object({
  orchestration: Orchestration.extend({ prompt: z.string().optional() }),
})
export type OrchestrationResponse = z.infer<typeof OrchestrationResponse>

/** GET /api/v1/orchestrations query (`agents.read`). Newest first, 50 per page, no nodes, jobs or prompts. */
export const ListOrchestrationsQuery = z.strictObject({
  project_id: z.guid().optional(),
  status: OrchestrationStatus.optional(),
  cursor: z
    .string()
    .regex(/^[\x21-\x7E]{1,200}$/)
    .optional(),
})
export type ListOrchestrationsQuery = z.infer<typeof ListOrchestrationsQuery>

export const OrchestrationListResponse = z.object({
  orchestrations: z.array(Orchestration).max(JOB_LIST_PAGE_SIZE),
  next_cursor: z.string().nullable(),
})
export type OrchestrationListResponse = z.infer<typeof OrchestrationListResponse>

// ---------------------------------------------------------------- errors

/**
 * `error.reason` of an orchestration route's error (with jobs-v1's codes). 403 `forbidden`:
 * `not_coordinator` (a worker's key, or a job that isn't a coordinator turn). 409 `conflict`:
 * `job_not_running`, `decision_recorded` (the turn already decided), `final_turn` (a final turn may only
 * decide), `rev_mismatch` (`rev` isn't the next revision), `orchestration_ending` (cancelling or
 * terminal), `node_not_cancellable`. 422 `not_permitted`: `plan_invalid` (with `issues`).
 */
export const OrchestrationErrorReason = z.enum([
  "not_coordinator",
  "job_not_running",
  "decision_recorded",
  "final_turn",
  "rev_mismatch",
  "orchestration_ending",
  "node_not_cancellable",
  "plan_invalid",
])
export type OrchestrationErrorReason = z.infer<typeof OrchestrationErrorReason>

/** Every non-2xx body of an orchestration route: `ErrorResponse` plus `reason` and, for `plan_invalid`, `issues`. */
export const OrchestrationErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    request_id: z.string(),
    reason: OrchestrationErrorReason.optional(),
    issues: z.array(OrchestrationPlanIssue).max(64).optional(),
  }),
})
export type OrchestrationErrorResponse = z.infer<typeof OrchestrationErrorResponse>
