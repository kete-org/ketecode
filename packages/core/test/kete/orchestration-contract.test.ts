// orchestrations-v1 vectors (docs/platform/test-vectors/orchestrations-v1/, copied byte for byte from
// kete-code-platform; the Go tests check SHA256SUMS, this file checks it too) against the runtime's
// mirror of the contract (core/src/kete/orchestration/contract.ts).
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import type { z } from "zod"
import * as C from "@opencode/core/kete/orchestration/contract"

const dir = path.join(import.meta.dir, "..", "..", "..", "..", "docs", "platform", "test-vectors", "orchestrations-v1")
const files = ["bundles.json", "dag.json", "messages.json", "naming.json", "plan-files.json"]
const load = (name: string): any => JSON.parse(readFileSync(path.join(dir, name), "utf8"))

describe("orchestrations-v1 vectors", () => {
  test("the copies match SHA256SUMS", () => {
    const sums = files
      .map(
        (name) =>
          `${createHash("sha256")
            .update(readFileSync(path.join(dir, name)))
            .digest("hex")}  ${name}\n`,
      )
      .join("")
    expect(readFileSync(path.join(dir, "SHA256SUMS"), "utf8")).toBe(sums)
    expect(readdirSync(dir).sort()).toEqual([...files, "SHA256SUMS"].sort())
  })

  const planFiles = load("plan-files.json")
  const bytesOf = (file: { text?: string; base64?: string }) =>
    file.text !== undefined ? new TextEncoder().encode(file.text) : Uint8Array.from(Buffer.from(file.base64!, "base64"))

  test("plan files: 38 files, 5 reads", () => {
    expect(planFiles.files.length).toBe(38)
    expect(planFiles.reads.length).toBe(5)
  })

  for (const file of planFiles.files) {
    test(`plan file: ${file.name}`, async () => {
      const read = C.parseOrchestrationPlanFile(bytesOf(file))
      expect(read.ok).toBe(file.valid)
      if (!file.valid) {
        expect(read.ok ? undefined : read.reason).toBe(file.reason)
        return
      }
      for (const [titles, want] of [
        ["send", file.proposal_send],
        ["omit", file.proposal_omit],
      ] as const) {
        const proposal = await C.orchestrationPlanProposal(bytesOf(file), titles)
        expect(proposal.ok).toBe(true)
        if (proposal.ok) expect(proposal.proposal).toEqual(want)
      }
    })
  }

  for (const read of planFiles.reads) {
    test(`worker read: ${read.name}`, async () => {
      const file = planFiles.files.find((f: { name: string }) => f.name === read.file)
      const result = await C.readOrchestrationNodePrompt(bytesOf(file), read.expect)
      expect(result).toEqual(read.result)
    })
  }

  // kete-code's additions (docs/kete-test-vectors/orchestrations-v1-additions/), checked by the Go reader too.
  const additions = JSON.parse(
    readFileSync(
      path.join(dir, "..", "..", "..", "kete-test-vectors", "orchestrations-v1-additions", "plan-files.json"),
      "utf8",
    ),
  )
  for (const file of additions.files) {
    test(`plan file (addition): ${file.name}`, () => {
      const read = C.parseOrchestrationPlanFile(bytesOf(file))
      expect(read.ok ? "valid" : read.reason).toBe(file.valid ? "valid" : file.reason)
    })
  }
  test("a deeply nested document is refused without deep recursion", () => {
    const deep = "[".repeat(9) + "]".repeat(9)
    expect(C.parseOrchestrationPlanFile(new TextEncoder().encode(deep))).toEqual({ ok: false, reason: "not_json" })
  })

  const dag = load("dag.json")
  for (const c of dag.cases) {
    test(`dag: ${c.name}`, () => {
      const limits = { ...{ nodes_per_plan: 8, nodes_total: 16, attempts_per_node: 3 }, ...(c.limits ?? {}) }
      expect(C.validateOrchestrationPlan(c.nodes, c.existing ?? [], limits, c.titles ?? "send")).toEqual(c.issues)
      expect(C.orchestrationPlanCost(c.nodes, c.existing ?? [])).toBe(c.plan_cost_micros)
    })
  }

  const schemas: Record<string, z.ZodType> = {
    CreateOrchestrationRequest: C.CreateOrchestrationRequest,
    OrchestrationDecisionRequest: C.OrchestrationDecisionRequest,
    OrchestrationPlanProposal: C.OrchestrationPlanProposal,
    OrchestrationCoordinatorResponse: C.OrchestrationCoordinatorResponse,
    OrchestrationErrorResponse: C.OrchestrationErrorResponse,
    OrchestrationResponse: C.OrchestrationResponse,
  }
  const messages = load("messages.json")
  test("messages: 43 cases", () => expect(messages.cases.length).toBe(43))
  for (const c of messages.cases) {
    test(`message: ${c.schema} / ${c.name}`, () => {
      const schema = schemas[c.schema]
      expect(schema).toBeDefined()
      expect(schema!.safeParse(c.value).success).toBe(c.valid)
    })
  }

  const bundles = load("bundles.json")
  for (const c of bundles.cases) {
    test(`bundle: ${c.name}`, () => {
      expect(C.checkOrchestrationBundle(c.entries, c.kind)).toBe(c.refusal)
    })
  }

  const naming = load("naming.json")
  test("naming: branches and node commit messages", () => {
    for (const b of naming.branches)
      expect(
        b.plan_rev !== undefined
          ? C.orchestrationPlanBranch(b.orchestration_id, b.plan_rev)
          : C.orchestrationNodeBranch(b.orchestration_id, b.node_key),
      ).toBe(b.branch)
    for (const m of naming.commit_messages) expect(C.orchestrationNodeCommitMessage(m.input)).toBe(m.message)
  })
})
