// The `orchestrate` tool's plan step, pure: the plan file built from the model's nodes, the proposal it
// stands for (computed with the contract's own `orchestrationPlanProposal`, so `plan_digest` and every
// `prompt_digest` are the platform's), and the checks the platform would make, run first with the same
// rules (`validateOrchestrationPlan` against the nodes the platform holds, plus the platform-only checks
// the coordinator view lets the runtime make: worker agents, the budget, max_parallel).

export * as KeteOrchestrationPlan from "./plan.js"

import {
  OrchestrationPlanFile,
  orchestrationPlanCost,
  orchestrationPlanProposal,
  parseOrchestrationPlanFile,
  validateOrchestrationPlan,
  ORCHESTRATION_PLAN_FILE_MAX_BYTES,
  type OrchestrationCoordinatorView,
  type OrchestrationExistingNode,
  type OrchestrationPlanIssue,
  type OrchestrationPlanProposal,
  type OrchestrationTitles,
} from "./contract.js"

/** One node as the model gives it (money in USD, as people say it; the plan file holds micros). */
export interface NodeInput {
  readonly key: string
  readonly title?: string
  readonly prompt: string
  readonly depends_on?: ReadonlyArray<string>
  readonly base_from?: string | null
  readonly agent: string
  readonly budget_usd: number
  readonly timeout_minutes: number
  readonly max_attempts?: number
}

export interface PlanInput {
  readonly orchestrationID: string
  readonly rev: number
  readonly notes: string
  readonly maxParallel?: number
  readonly nodes: ReadonlyArray<NodeInput>
  /** A node's max_attempts when the model gives none: the limit in force. */
  readonly defaultAttempts: number
}

export type Built =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

const encoder = new TextEncoder()

/** The plan file's bytes (`.kete-orchestration/plan.json`), or every schema problem, named by path. */
export function build(input: PlanInput): Built {
  const file = {
    version: 1,
    orchestration_id: input.orchestrationID,
    rev: input.rev,
    notes: input.notes,
    ...(input.maxParallel === undefined ? {} : { max_parallel: input.maxParallel }),
    nodes: input.nodes.map((n) => ({
      key: n.key,
      ...(n.title === undefined ? {} : { title: n.title }),
      prompt: n.prompt,
      depends_on: [...(n.depends_on ?? [])],
      base_from: n.base_from ?? null,
      agent: n.agent,
      budget_micros: Math.round(n.budget_usd * 1_000_000),
      timeout_minutes: n.timeout_minutes,
      max_attempts: n.max_attempts ?? input.defaultAttempts,
    })),
  }
  const checked = OrchestrationPlanFile.safeParse(file)
  if (!checked.success)
    return {
      ok: false,
      errors: checked.error.issues.map((issue) => `${issue.path.map(String).join(".") || "plan"}: ${issue.message}`),
    }
  const bytes = encoder.encode(`${JSON.stringify(file, null, 2)}\n`)
  if (bytes.length > ORCHESTRATION_PLAN_FILE_MAX_BYTES)
    return {
      ok: false,
      errors: [
        `the plan file would be ${bytes.length} bytes; the limit is ${ORCHESTRATION_PLAN_FILE_MAX_BYTES} (shorten the prompts or notes)`,
      ],
    }
  const read = parseOrchestrationPlanFile(bytes)
  if (!read.ok) return { ok: false, errors: [`the plan file is refused by the shared reader (${read.reason})`] }
  return { ok: true, bytes }
}

/** The nodes the platform holds, as validateOrchestrationPlan needs them. */
export function existing(view: OrchestrationCoordinatorView): OrchestrationExistingNode[] {
  return view.nodes.map((n) => ({
    node: {
      key: n.key,
      depends_on: n.depends_on,
      base_from: n.base_from,
      agent: n.agent,
      budget_micros: n.budget_micros,
      timeout_minutes: n.timeout_minutes,
      max_attempts: n.max_attempts,
      prompt_digest: n.prompt_digest,
    },
    state: n.state,
    attempts: n.attempts,
  }))
}

export type Checked =
  | { readonly ok: true; readonly proposal: OrchestrationPlanProposal; readonly cost: number }
  | {
      readonly ok: false
      readonly issues: ReadonlyArray<OrchestrationPlanIssue>
      readonly errors: ReadonlyArray<string>
    }

/**
 * The proposal for `bytes` and the checks the platform makes. `titles` is what may leave: the claim's
 * setting narrowed by the runtime's own boundary.
 */
export async function check(
  bytes: Uint8Array,
  view: OrchestrationCoordinatorView,
  titles: OrchestrationTitles,
): Promise<Checked> {
  const made = await orchestrationPlanProposal(bytes, titles)
  if (!made.ok) return { ok: false, issues: [], errors: [`the plan file is refused (${made.reason})`] }
  const proposal = made.proposal
  const held = existing(view)
  const issues = [
    ...validateOrchestrationPlan(proposal.nodes, held, view.limits, titles === "omit" ? "omit" : view.titles),
  ]
  const cost = orchestrationPlanCost(proposal.nodes, held)
  for (const n of proposal.nodes)
    if (!view.worker_agents.includes(n.agent)) issues.push({ code: "agent_not_permitted", key: n.key })
  if (view.allocated_micros + cost + view.reserve_micros > view.budget_micros) issues.push({ code: "budget_exceeded" })
  if (proposal.max_parallel !== undefined && proposal.max_parallel > view.max_parallel)
    issues.push({ code: "max_parallel_too_high" })
  if (issues.length > 0) return { ok: false, issues, errors: [] }
  return { ok: true, proposal, cost }
}

const explanations: Record<string, string> = {
  attempts_exhausted: "this node has used all its attempts",
  base_from_not_ancestor: "base_from must be one of the node's (transitive) dependencies",
  cycle: "the dependencies form a cycle",
  duplicate_dependency: "a dependency is listed twice",
  duplicate_key: "two nodes have this key",
  inactive_dependency: "a dependency is neither listed in this plan nor succeeded",
  node_running: "this node is running; leave it out",
  node_succeeded_changed: "this node succeeded; repeat it exactly or leave it out",
  self_dependency: "a node can't depend on itself",
  too_many_nodes: "too many nodes in one plan",
  too_many_total_nodes: "too many nodes in the orchestration",
  title_not_permitted: "titles may not leave this zone; leave title out",
  unknown_dependency: "a dependency names no node",
  agent_not_permitted: "the agent isn't one of the orchestration's worker agents",
  budget_exceeded: "the nodes' budgets exceed what is left of the orchestration's budget",
  jobs_exceeded: "the orchestration would exceed its job limit",
  max_parallel_too_high: "max_parallel is above the orchestration's",
  timeout_exceeds_deadline: "a node's timeout doesn't fit before the deadline less the integration reserve",
}

/** Issues as the model reads them. */
export function describeIssues(issues: ReadonlyArray<OrchestrationPlanIssue>): string[] {
  return issues.map((i) => `${i.code}${i.key === undefined ? "" : ` (${i.key})`}: ${explanations[i.code] ?? "refused"}`)
}
