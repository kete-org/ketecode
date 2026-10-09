// `spec.orchestration` of an orchestrated job (jobs-v1 `JobSpecOrchestration`; docs/platform/jobs-v1.md
// "Orchestrated jobs", orchestrations-v1; kete-code ADR 0012): the entrypoint copies it from the claim
// into the spec it gives `kete job run` (kete job spec v1's optional `orchestration`), and `kete job
// run` hands it to its server, where the `orchestrate` tool reads it (core/src/kete/orchestrate.ts).
// Hand-written strict checks, so the CLI (which can't use core's zod mirror) refuses exactly what the
// contract refuses: a strict discriminated union on `role`, unknown fields refused at every level.

export * as KeteOrchestrationSpec from "./orchestration-spec.js"

export const maxTurns = 6
export const maxAttempts = 3
export const jobBranchPrefix = "kete/job/"
export const planPath = ".kete-orchestration/plan.json"

export interface PlanRef {
  readonly rev: number
  readonly branch: string
  readonly sha: string
}

export interface Coordinator {
  readonly version: 1
  readonly id: string
  readonly role: "coordinator"
  readonly turn: number
  readonly final: boolean
  readonly plan: PlanRef | null
  readonly titles: "omit" | "send"
}

export interface Worker {
  readonly version: 1
  readonly id: string
  readonly role: "worker"
  readonly node: string
  readonly attempt: number
  readonly plan: PlanRef
  readonly prompt_digest: string
  readonly base_from: string | null
}

export type Spec = Coordinator | Worker

const orchestrationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const jobId = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const nodeKey = /^[a-z][a-z0-9-]{0,31}$/
const gitSha = /^[0-9a-f]{40}$/
const sha256 = /^[0-9a-f]{64}$/

/** OrchestrationId: a lowercase UUID. */
export const validId = (value: string) => orchestrationId.test(value)
/** A job id as the platform issues it (a UUID), for the coordinator routes' path. */
export const validJobId = (value: string) => jobId.test(value)
/** OrchestrationNodeKey: `^[a-z][a-z0-9-]{0,31}$`, never `plan` or `plan-…`. */
export const validNodeKey = (value: string) => nodeKey.test(value) && value !== "plan" && !value.startsWith("plan-")

/** isJobGitRef (jobs-v1): a conservative subset of git-check-ref-format. */
export function validGitRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]{1,255}$/.test(ref) && !/(^[-/.]|\/$|\.$|\/\/|\.\.|\/\.|\.lock(\/|$)|@\{)/.test(ref)
}
const validJobBranch = (b: string) =>
  b.startsWith(jobBranchPrefix) && b.length > jobBranchPrefix.length && validGitRef(b)

export const shortId = (id: string) => id.slice(0, 8)
export const planBranch = (id: string, rev: number) => `${jobBranchPrefix}${shortId(id)}-plan-${rev}`
export const nodeBranch = (id: string, key: string) => `${jobBranchPrefix}${shortId(id)}-${key}`

export type Parsed = { readonly ok: true; readonly spec: Spec } | { readonly ok: false; readonly field: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const own = Object.keys(value)
  return own.length === keys.length && own.every((k) => keys.includes(k))
}

function planRef(value: unknown): PlanRef | undefined {
  if (!isObject(value) || !exactKeys(value, ["rev", "branch", "sha"])) return undefined
  const { rev, branch, sha } = value
  if (
    !isInt(rev, 1, maxTurns) ||
    typeof branch !== "string" ||
    !validJobBranch(branch) ||
    typeof sha !== "string" ||
    !gitSha.test(sha)
  )
    return undefined
  return { rev, branch, sha }
}

/** Parses `spec.orchestration`; on failure names the first bad field (never a value). */
export function parse(value: unknown, base = "orchestration"): Parsed {
  const fail = (field: string): Parsed => ({ ok: false, field: `${base}.${field}` })
  if (!isObject(value)) return { ok: false, field: base }
  if (value.version !== 1) return fail("version")
  if (typeof value.id !== "string" || !validId(value.id)) return fail("id")
  if (value.role === "coordinator") {
    if (!exactKeys(value, ["version", "id", "role", "turn", "final", "plan", "titles"]))
      return fail("(unknown or missing field)")
    if (!isInt(value.turn, 1, maxTurns)) return fail("turn")
    if (typeof value.final !== "boolean") return fail("final")
    const plan = value.plan === null ? null : planRef(value.plan)
    if (plan === undefined) return fail("plan")
    if (plan !== null && plan.branch !== planBranch(value.id, plan.rev)) return fail("plan.branch")
    if (value.titles !== "omit" && value.titles !== "send") return fail("titles")
    return {
      ok: true,
      spec: {
        version: 1,
        id: value.id,
        role: "coordinator",
        turn: value.turn,
        final: value.final,
        plan,
        titles: value.titles,
      },
    }
  }
  if (value.role === "worker") {
    if (!exactKeys(value, ["version", "id", "role", "node", "attempt", "plan", "prompt_digest", "base_from"]))
      return fail("(unknown or missing field)")
    if (typeof value.node !== "string" || !validNodeKey(value.node)) return fail("node")
    if (!isInt(value.attempt, 1, maxAttempts)) return fail("attempt")
    const plan = planRef(value.plan)
    if (plan === undefined || plan.branch !== planBranch(value.id, plan.rev)) return fail("plan")
    if (typeof value.prompt_digest !== "string" || !sha256.test(value.prompt_digest)) return fail("prompt_digest")
    if (value.base_from !== null && (typeof value.base_from !== "string" || !validNodeKey(value.base_from)))
      return fail("base_from")
    return {
      ok: true,
      spec: {
        version: 1,
        id: value.id,
        role: "worker",
        node: value.node,
        attempt: value.attempt,
        plan,
        prompt_digest: value.prompt_digest,
        base_from: value.base_from as string | null,
      },
    }
  }
  return fail("role")
}
