import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigKete } from "@opencode/schema/config/kete"
import { KeteWorkflows } from "@opencode/core/kete/workflows"

type StepFields = Partial<Pick<ConfigKete.WorkflowStep, "prompt" | "after" | "worktree" | "continue">>

const step = (id: string, fields: StepFields = {}) =>
  new ConfigKete.WorkflowStep({ id, agent: "general", prompt: `do ${id}`, ...fields })

const workflow = (...steps: ConfigKete.WorkflowStep[]) => new ConfigKete.Workflow({ steps })

const errors = (value: ConfigKete.Workflow) => {
  const checked = KeteWorkflows.validate("wf", value)
  return "errors" in checked ? checked.errors : []
}

const plan = (value: ConfigKete.Workflow) => {
  const checked = KeteWorkflows.validate("wf", value)
  if ("errors" in checked) throw new Error(checked.errors.join("; "))
  return checked.plan
}

describe("KeteWorkflows.validate", () => {
  test("orders steps after their dependencies", () => {
    const checked = plan(
      workflow(
        step("review", { after: ["implement", "test"] }),
        step("test", { after: ["implement"] }),
        step("implement", { after: ["analyze"] }),
        step("analyze"),
      ),
    )
    expect(checked.steps.map((item) => item.id)).toEqual(["analyze", "implement", "test", "review"])
    expect([...checked.dependencies.get("review")!].sort()).toEqual(["analyze", "implement", "test"])
  })

  test("reports every problem", () => {
    expect(errors(workflow())).toEqual(["it has no steps"])
    expect(errors(workflow(step("a"), step("a")))).toContain('step "a" is defined twice')
    expect(errors(workflow(step("a", { after: ["b"] })))).toContain('step "a" refers to "b", which isn\'t a step')
    expect(errors(workflow(step("a", { after: ["a"] })))).toContain('step "a" can\'t come after itself')
    expect(errors(workflow(step("a", { after: ["b"] }), step("b", { after: ["a"] })))[0]).toContain("cycle")
    expect(errors(workflow(step("a"), step("b", { continue: "a", worktree: true })))).toContain(
      'step "b" continues "a", so it can\'t also have its own worktree',
    )
  })

  test("templates may use only the input and earlier steps' answers", () => {
    expect(
      errors(workflow(step("a", { prompt: "{{input}}" }), step("b", { after: ["a"], prompt: "{{steps.a}}" }))),
    ).toEqual([])
    expect(errors(workflow(step("a"), step("b", { prompt: "{{steps.a}}" })))).toContain(
      'step "b" uses {{steps.a}} but doesn\'t come after "a"',
    )
    expect(errors(workflow(step("a", { prompt: "{{secret}}" })))[0]).toContain(
      "only {{input}} and {{steps.<id>}} exist",
    )
  })

  test("steps continuing the same session must be ordered", () => {
    expect(errors(workflow(step("a"), step("b", { continue: "a" }), step("c", { continue: "a" })))).toContain(
      'steps "b" and "c" continue the same session, so one must come after the other',
    )
    expect(errors(workflow(step("a"), step("b", { continue: "a" }), step("c", { continue: "b" })))).toEqual([])
  })
})

test("KeteWorkflows.render fills the input and earlier answers", () => {
  expect(KeteWorkflows.render("Do {{ input }} using {{steps.a}}.", "X", new Map([["a", "plan"]]))).toBe(
    "Do X using plan.",
  )
})

describe("KeteWorkflows.run", () => {
  const record = () => {
    const calls: { id: string; prompt: string; sessionID?: string; at: number }[] = []
    let clock = 0
    let active = 0
    let most = 0
    const run: KeteWorkflows.StepRun = ({ step, prompt, sessionID }) =>
      Effect.gen(function* () {
        active++
        most = Math.max(most, active)
        calls.push({ id: step.id, prompt, ...(sessionID === undefined ? {} : { sessionID }), at: clock++ })
        yield* Effect.sleep("5 millis")
        active--
        if (step.id.startsWith("fail")) return { id: step.id, state: "failed" as const, error: "boom" }
        if (step.id.startsWith("bg"))
          return { id: step.id, state: "backgrounded" as const, sessionID: `ses_${step.id}` }
        return { id: step.id, state: "completed" as const, sessionID: `ses_${step.id}`, output: `answer ${step.id}` }
      })
    return { calls, run, most: () => most }
  }

  test("runs independent steps together, feeds answers forward and continues sessions", async () => {
    const recorder = record()
    const results = await Effect.runPromise(
      KeteWorkflows.run(
        plan(
          workflow(
            step("analyze"),
            step("frontend", { after: ["analyze"], prompt: "front {{steps.analyze}}" }),
            step("backend", { after: ["analyze"], prompt: "back {{input}}" }),
            step("test", { continue: "backend", after: ["frontend"] }),
          ),
        ),
        "the feature",
        4,
        recorder.run,
      ),
    )
    expect(results.map((result) => result.state)).toEqual(["completed", "completed", "completed", "completed"])
    expect(recorder.most()).toBe(2)
    expect(recorder.calls.find((call) => call.id === "frontend")?.prompt).toBe("front answer analyze")
    expect(recorder.calls.find((call) => call.id === "backend")?.prompt).toBe("back the feature")
    expect(recorder.calls.find((call) => call.id === "test")?.sessionID).toBe("ses_backend")
  })

  test("keeps to the concurrency limit", async () => {
    const recorder = record()
    await Effect.runPromise(KeteWorkflows.run(plan(workflow(step("a"), step("b"), step("c"))), "", 1, recorder.run))
    expect(recorder.most()).toBe(1)
  })

  test("skips the steps after a failed or backgrounded one", async () => {
    const recorder = record()
    const results = await Effect.runPromise(
      KeteWorkflows.run(
        plan(
          workflow(
            step("fail-analyze"),
            step("implement", { after: ["fail-analyze"] }),
            step("bg-docs"),
            step("publish", { after: ["bg-docs"] }),
            step("other"),
          ),
        ),
        "",
        4,
        recorder.run,
      ),
    )
    expect(Object.fromEntries(results.map((result) => [result.id, result.state]))).toEqual({
      "fail-analyze": "failed",
      implement: "skipped",
      "bg-docs": "backgrounded",
      publish: "skipped",
      other: "completed",
    })
    expect(recorder.calls.map((call) => call.id)).not.toContain("implement")
    const text = KeteWorkflows.describe(plan(workflow(step("x"))), results)
    expect(text).toContain('<workflow name="wf" state="incomplete">')
    expect(text).toContain('Not run: "fail-analyze" didn\'t complete.')
    expect(text).toContain('Not run: "bg-docs" is still running in the background.')
  })
})
