import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { KeteBudget } from "@opencode/core/kete/budget"
import { Permission } from "@opencode/core/permission"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { SessionSchema } from "@opencode/core/session/schema"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"

const decode = Schema.decodeUnknownSync(Info)
const agent = Agent.ID.make("build")
let asked: Permission.AssertInput[] = []
let answer: "approve" | "reject" | "decline" = "approve"

const permission = permissionLayer({
  assert: (input) => {
    asked.push(input)
    if (answer === "decline") return Effect.die(new Permission.DeclinedError())
    return answer === "approve"
      ? Effect.void
      : Effect.fail(
          new Permission.BlockedError({ rules: [], permission: input.action, resources: [...input.resources] }),
        )
  },
})

const withBudget = (session: number | undefined) =>
  testEffect(
    Layer.merge(
      permission,
      Config.testLayer(
        session === undefined
          ? []
          : [new Document({ type: "document", info: decode({ kete: { budget: { session } } }) })],
      ),
    ),
  )

// Each test uses its own session so process-local thresholds don't leak between tests.
let counter = 0
const session = () => SessionSchema.ID.make(`ses_budget_test_${++counter}`)

const reset = () => {
  asked = []
  answer = "approve"
}

describe("KeteBudget", () => {
  test("the kete section survives config normalization", () => {
    const result = ConfigNormalize.normalize({ kete: { budget: { session: 2.5 } } })
    expect(result).toMatchObject({
      type: "normalized",
      encoded: { kete: { budget: { session: 2.5 } } },
      diagnostics: [],
    })
    expect(ConfigNormalize.normalize({ kete: { budget: { session: -1 } } })).toMatchObject({
      encoded: {},
      diagnostics: [expect.objectContaining({ path: ["kete"] })],
    })
  })

  withBudget(undefined).effect("does nothing without a configured budget", () =>
    Effect.gen(function* () {
      reset()
      const check = yield* KeteBudget.make
      yield* check({ sessionID: session(), agent, cost: 1_000 })
      expect(asked).toEqual([])
    }),
  )

  withBudget(5).effect("asks once spend reaches the budget, then allows another budget-sized amount", () =>
    Effect.gen(function* () {
      reset()
      const check = yield* KeteBudget.make
      const sessionID = session()

      yield* check({ sessionID, agent, cost: 4.99 })
      expect(asked).toEqual([])

      yield* check({ sessionID, agent, cost: 5.2 })
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        sessionID,
        agent,
        action: "budget",
        resources: ["spent $5.20 of a $5.00 session budget; approve another $5.00"],
        save: ["*"],
      })

      // Approved at $5.20: the next prompt comes at $10.20.
      yield* check({ sessionID, agent, cost: 10.19 })
      expect(asked).toHaveLength(1)
      yield* check({ sessionID, agent, cost: 10.2 })
      expect(asked).toHaveLength(2)
      expect(asked[1]?.resources).toEqual(["spent $10.20 of a $10.20 session budget; approve another $5.00"])
    }),
  )

  withBudget(5).effect("ends the step with a budget error when the prompt is rejected", () =>
    Effect.gen(function* () {
      reset()
      answer = "reject"
      const check = yield* KeteBudget.make
      const sessionID = session()
      const error = yield* check({ sessionID, agent, cost: 6 }).pipe(Effect.flip)
      expect(error._tag).toBe("Session.StepFailedError")
      expect(error.error).toMatchObject({ type: "budget" })
      expect(error.message).toContain("reached its $5.00 budget (spent $6.00)")

      // Rejecting doesn't move the threshold: continuing the session asks again.
      answer = "approve"
      yield* check({ sessionID, agent, cost: 6 })
      expect(asked).toHaveLength(2)
    }),
  )

  withBudget(5).effect("reports a plain decline (raised as a defect) as a budget error", () =>
    Effect.gen(function* () {
      reset()
      answer = "decline"
      const check = yield* KeteBudget.make
      const error = yield* check({ sessionID: session(), agent, cost: 7 }).pipe(Effect.flip)
      expect(error.error).toMatchObject({ type: "budget" })
      expect(error.message).toContain("reached its $5.00 budget (spent $7.00)")
    }),
  )

  withBudget(5).effect("keeps budgets per session", () =>
    Effect.gen(function* () {
      reset()
      const check = yield* KeteBudget.make
      const first = session()
      yield* check({ sessionID: first, agent, cost: 5 })
      yield* check({ sessionID: session(), agent, cost: 4 })
      expect(asked.map((input) => input.sessionID)).toEqual([first])
    }),
  )
})
