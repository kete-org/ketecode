// Per-session spending limit (`kete.budget.session`, in USD).
//
// The runner builds the checker with `make` and calls it before each step's model
// request (session/runner/llm.ts).
// Once a session's recorded cost reaches the limit, the step asks the `budget`
// permission, which uses the normal permission prompt and rules:
// - approving allows another limit-sized amount before the next prompt;
// - "always" saves the approval, so this project stops asking;
// - rejecting, or a rule `{ action: "budget", resource: "*", effect: "deny" }`,
//   ends the run with a budget error;
// - the same rule with effect "allow" never asks.
// Approved thresholds are process-local: after a restart the session asks again.
//
// Built-in agents allow unmatched actions, so `kete/budget-rule.ts` adds a `budget: ask`
// rule to each of them; see there.

export * as KeteBudget from "./budget.js"

import { Cause, Effect, Result } from "effect"
import type { Agent } from "@opencode/schema/agent"
import { SessionError } from "@opencode/schema/session-error"
import { Config } from "../config.js"
import { KeteBudgetRule } from "./budget-rule.js"
import { Permission } from "../permission.js"
import { StepFailedError } from "../session/error.js"
import type { SessionSchema } from "../session/schema.js"

export const action = KeteBudgetRule.action

const thresholds = new Map<string, number>()

/** Resolves the services once; the returned checker runs before each step. */
export const make = Effect.gen(function* () {
  const config = yield* Config.Service
  const permission = yield* Permission.Service
  return Effect.fn("KeteBudget.check")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly cost: number
  }) {
    const limit = Config.latest(yield* config.entries(), "kete")?.budget?.session
    if (limit === undefined) return
    const threshold = thresholds.get(input.sessionID) ?? limit
    if (input.cost < threshold) return
    yield* permission
      .assert({
        sessionID: input.sessionID,
        agent: input.agent,
        action,
        // Shown in the permission prompt.
        resources: [`spent ${usd(input.cost)} of a ${usd(threshold)} session budget; approve another ${usd(limit)}`],
        save: ["*"],
      })
      .pipe(
        // A plain decline is raised as a defect (see Permission.assert); recover it like upstream's
        // executeTool does, so it ends the step with the budget error instead of an empty failure.
        Effect.catchCauseFilter(
          (cause) =>
            cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
            )
              ? Result.succeed(undefined)
              : Result.fail(cause),
          () => Effect.fail(stopped(threshold, input.cost)),
        ),
        Effect.catch((cause) =>
          Effect.fail(
            stopped(threshold, input.cost, cause._tag === "Permission.CorrectedError" ? cause.feedback : undefined),
          ),
        ),
      )
    thresholds.set(input.sessionID, input.cost + limit)
  })
})

function stopped(threshold: number, cost: number, feedback?: string) {
  return new StepFailedError({
    error: SessionError.Error.make({
      type: "budget",
      message: `Stopped: this session reached its ${usd(threshold)} budget (spent ${usd(cost)}). Raise kete.budget.session or continue the session to approve more.${feedback ? ` Feedback: ${feedback}` : ""}`,
    }),
  })
}

/** Location nodes the checker needs, for the runner's dependency list. */
export const nodes = [Config.node, Permission.node] as const

/** Dollars with cents, or four decimals for amounts under a cent. */
export function usd(amount: number) {
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`
}
