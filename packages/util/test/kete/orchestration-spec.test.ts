// `spec.orchestration` (jobs-v1 JobSpecOrchestration): the jobs-v1 orchestration vector's specs are
// accepted, and every way the contract refuses one is refused.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { KeteOrchestrationSpec } from "../../src/kete/orchestration-spec.js"

const vector = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "kete-job-entrypoint",
      "internal",
      "fakeplatform",
      "testdata",
      "jobs-v1",
      "orchestration.json",
    ),
    "utf8",
  ),
)

describe("KeteOrchestrationSpec.parse", () => {
  test("accepts every spec of the vector's claims", () => {
    for (const [name, response] of Object.entries<any>(vector.responses)) {
      const parsed = KeteOrchestrationSpec.parse(response.spec.orchestration)
      expect({ name, ok: parsed.ok }).toEqual({ name, ok: true })
    }
    expect(KeteOrchestrationSpec.parse(vector.runtime.response.spec.orchestration).ok).toBe(true)
  })

  test("refuses what the contract refuses, naming the field", () => {
    const worker = vector.responses.worker_on_node.spec.orchestration
    const coordinator = vector.responses.coordinator_turn_1.spec.orchestration
    const cases: Array<[unknown, string]> = [
      [{ ...worker, prompt_digest: undefined }, "orchestration.(unknown or missing field)"],
      [{ ...worker, prompt_digest: "A".repeat(64) }, "orchestration.prompt_digest"],
      [{ ...worker, attempt: 4 }, "orchestration.attempt"],
      [{ ...worker, node: "plan-2" }, "orchestration.node"],
      [{ ...worker, extra: 1 }, "orchestration.(unknown or missing field)"],
      [{ ...worker, plan: { ...worker.plan, branch: "kete/job/ffffffff-plan-1" } }, "orchestration.plan"],
      [{ ...coordinator, turn: 7 }, "orchestration.turn"],
      [{ ...coordinator, titles: "maybe" }, "orchestration.titles"],
      [{ ...coordinator, id: coordinator.id.toUpperCase() }, "orchestration.id"],
      [{ ...coordinator, role: "observer" }, "orchestration.role"],
      [{ ...coordinator, version: 2 }, "orchestration.version"],
      ["coordinator", "orchestration"],
    ]
    for (const [value, field] of cases) {
      const parsed = KeteOrchestrationSpec.parse(JSON.parse(JSON.stringify(value ?? null)))
      expect(parsed.ok ? "accepted" : parsed.field).toBe(field)
    }
  })

  test("branch names", () => {
    const id = "ab12cd34-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
    expect(KeteOrchestrationSpec.planBranch(id, 2)).toBe("kete/job/ab12cd34-plan-2")
    expect(KeteOrchestrationSpec.nodeBranch(id, "sdk-core")).toBe("kete/job/ab12cd34-sdk-core")
  })
})
