import { expect, test } from "bun:test"
import { popularProviders } from "@/providers/catalog/order"

// OpenCode Go/Zen are opt-in in Kete Code (ADR 0003); moved here when upstream dropped order.test.ts in v2.1.4.
test("lists OpenCode Go and Zen after the other popular providers", () => {
  expect(popularProviders.slice(-2)).toEqual(["opencode-go", "opencode"])
  expect(popularProviders[0]).toBe("anthropic")
})
