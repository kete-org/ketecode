import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { Info } from "@opencode/schema/config"

function policies(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return { policies: Schema.decodeUnknownSync(Info)(result.encoded).policies, diagnostics: result.diagnostics }
}

describe("legacy permission policies", () => {
  test("a top-level permission deny keeps applying as tool.use", () => {
    const result = policies({ policies: [{ action: "permission", resource: "hooks:*", effect: "deny" }] })
    expect(result.policies).toEqual([{ action: "tool.use", resource: "hooks:*", effect: "deny" }])
    expect(result.diagnostics).toEqual([])
  })

  test("an experimental permission statement keeps its place among the others", () => {
    const result = policies({
      experimental: {
        policies: [
          { action: "tool.use", resource: "shell:*", effect: "allow" },
          { action: "permission", resource: "sandbox_off:*", effect: "deny" },
        ],
      },
    })
    expect(result.policies).toEqual([
      { action: "tool.use", resource: "shell:*", effect: "allow" },
      { action: "tool.use", resource: "sandbox_off:*", effect: "deny" },
    ])
  })

  test("other unknown actions are still dropped", () => {
    const result = policies({ policies: [{ action: "future.use", resource: "*", effect: "deny" }] })
    expect(result.policies).toEqual([])
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([["policies", "0"]])
  })
})
