// Organization policies (sync v1 `policies`, docs/platform/sync-v1.md): what they decide for one
// permission request. Pure, so the runtime (core/src/kete/sync/plugin.ts) and tests agree.
//
// - Only `enforced` policies decide; `audit_only` ones are reported as "would" results.
// - A policy applies when its environment kinds are empty or include the runtime's (a local runtime
//   is `development`), and when it names no agents or names the session's agent.
// - Within a policy, rules are read in order: `deny` and `ask` accumulate (deny beats ask, whatever
//   the order, so a broader `ask` never weakens an earlier `deny`), and a matching `allow` clears
//   what came before it: an explicit exception. Across policies the most restrictive result wins.
//   Nothing here ever allows what an agent's own rules don't.

import type { SyncedPolicy } from "./contract.js"

export type Decision = {
  readonly effect: "deny" | "ask"
  readonly policy: SyncedPolicy
  readonly rule: SyncedPolicy["rules"][number]
  readonly resource: string
}

export type Result = {
  /** What enforced policies require; undefined when none restricts the request. */
  readonly enforced?: Decision
  /** What audit-only policies would have done. */
  readonly audit: readonly Decision[]
}

export type Request = {
  readonly action: string
  readonly resources: readonly string[]
  /** The session's agent (a synced agent's slug); undefined when unknown. */
  readonly agent?: string
  /** The runtime's environment kind: `development` for a local runtime. */
  readonly environment: string
}

export function evaluate(policies: readonly SyncedPolicy[], request: Request, match: (input: string, pattern: string) => boolean): Result {
  const applicable = policies.filter(
    (policy) =>
      (policy.environment_kinds.length === 0 || policy.environment_kinds.includes(request.environment)) &&
      (policy.agents === null || (request.agent !== undefined && policy.agents.includes(request.agent))),
  )
  const decide = (policy: SyncedPolicy): Decision | undefined => {
    const found = request.resources.flatMap((resource): Decision[] => {
      let current: SyncedPolicy["rules"][number] | undefined
      for (const rule of policy.rules) {
        if (!match(request.action, rule.action) || !match(resource, rule.resource)) continue
        if (rule.effect === "allow") current = undefined
        else if (rule.effect === "deny" || current?.effect !== "deny") current = rule
      }
      if (!current || current.effect === "allow") return []
      return [{ effect: current.effect, policy, rule: current, resource }]
    })
    return found.find((item) => item.effect === "deny") ?? found[0]
  }
  const strongest = (decisions: Decision[]) => decisions.find((item) => item.effect === "deny") ?? decisions[0]
  const enforced = applicable.filter((policy) => policy.enforcement === "enforced").flatMap((policy) => decide(policy) ?? [])
  const audit = applicable.filter((policy) => policy.enforcement === "audit_only").flatMap((policy) => decide(policy) ?? [])
  return { enforced: strongest(enforced), audit }
}

export * as KeteSyncPolicy from "./policy.js"
