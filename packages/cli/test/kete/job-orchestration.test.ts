// `kete job run`'s check of an orchestrated job's section: job mode only, with the job's own id.
import { describe, expect, test } from "bun:test"
import { KeteJobOrchestration } from "../../src/kete/job-orchestration"

const spec = {
  version: 1,
  id: "ab12cd34-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  role: "coordinator",
  turn: 1,
  final: false,
  plan: null,
  titles: "send",
} as const
const job = "c3d8f1a2-6b4e-4f7a-9c2d-8e1f0a3b5c7d"

describe("KeteJobOrchestration.resolve", () => {
  test("job mode with the job's id", () => {
    expect(KeteJobOrchestration.resolve({ jobMode: true, spec, environment: { OPENCODE_JOB_ID: job } })).toEqual({
      kind: "ok",
      value: { jobID: job, spec },
    })
  })
  test("refused outside job mode", () => {
    const r = KeteJobOrchestration.resolve({ jobMode: false, spec, environment: { OPENCODE_JOB_ID: job } })
    expect(r.kind === "refused" && r.message).toContain("only in job mode")
  })
  test("refused without a valid job id", () => {
    for (const environment of [{}, { OPENCODE_JOB_ID: "../x" }]) {
      const r = KeteJobOrchestration.resolve({ jobMode: true, spec, environment })
      expect(r.kind === "refused" && r.message).toContain("KETE_JOB_ID is not set")
    }
  })
})
