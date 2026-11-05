import { describe, expect, test } from "bun:test"
import { declaresProvider } from "./electron"

describe("declaresProvider", () => {
  test("finds the provider in a config document, under either key", () => {
    expect(declaresProvider([{ source: "x", document: { provider: { "kete-e2e": {} } } }], "kete-e2e")).toBe(true)
    expect(declaresProvider([{ document: { providers: { "kete-e2e": {} } } }], "kete-e2e")).toBe(true)
  })

  test("a model name that mentions it, or no config, is not a declaration", () => {
    expect(declaresProvider([{ document: { model: "kete-e2e/fake" } }], "kete-e2e")).toBe(false)
    expect(declaresProvider(undefined, "kete-e2e")).toBe(false)
    expect(declaresProvider([], "kete-e2e")).toBe(false)
  })
})
