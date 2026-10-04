// What the runner checks before every step (session/runner/llm.ts): an interactive family gets
// KeteBudget exactly as before; an unattended family (kete/unattended-policy.ts) gets the audit
// log's `run started` line (kete/audit.ts — refuses the step if the log can't be written) and then
// KeteUnattended's required budget, required time limit, deadline and family-cost checks instead —
// an unattended run never asks the `budget` permission (a `budget: allow` rule would otherwise
// remove the cap ADR 0008 requires).
//
// Job mode implies unattended (docs/jobs.md "Job mode"): an interactive family in a job-mode build
// (KETE_JOB_MODE) refuses the step outright, before a tool or a model request can run, rather than
// falling through to KeteBudget — there's no one to ask a budget permission of in a job.

export * as KeteRunChecks from "./run-checks.js"

import { Effect, Option } from "effect"
import type { Agent } from "@opencode/schema/agent"
import { KeteUnattendedSchema } from "@opencode/schema/kete/unattended"
import { SessionError } from "@opencode/schema/session-error"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import type { SessionSchema } from "../session/schema.js"
import { Config } from "../config.js"
import { StepFailedError } from "../session/error.js"
import { SessionStore } from "../session/store.js"
import { KeteAudit } from "./audit.js"
import { KeteBudget } from "./budget.js"
import { KeteUnattended } from "./unattended.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

/** Resolves the services once; the returned checker runs before each step. */
export const make = Effect.gen(function* () {
  const store = yield* SessionStore.Service
  const config = yield* Config.Service
  const budgetCheck = yield* KeteBudget.make
  const unattendedCheck = yield* KeteUnattended.make
  const auditBegin = yield* KeteAudit.make
  const get: KeteUnattendedPolicy.Get = (id) => store.get(id).pipe(Effect.map(Option.fromNullishOr))
  return Effect.fn("KeteRunChecks.check")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly cost: number
  }) {
    const state = yield* KeteUnattendedPolicy.resolve(get, input.sessionID)
    if (state.kind === "interactive") {
      if (KeteJobMode.enabled())
        return yield* Effect.fail(
          new StepFailedError({ error: SessionError.Error.make({ type: "unattended", message: KeteUnattendedSchema.jobMode() }) }),
        )
      return yield* budgetCheck(input)
    }
    const kete = yield* Effect.map(config.entries(), (entries) => Config.latest(entries, "kete"))
    yield* auditBegin(state, input.sessionID, KeteUnattended.limits(state.policy, kete))
    return yield* unattendedCheck(input)
  })
})

/** Location nodes the checker needs, for the runner's dependency list. */
export const nodes = [...KeteBudget.nodes, ...KeteAudit.nodes, SessionStore.node, Config.node] as const
