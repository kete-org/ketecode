import { expect, test } from "bun:test"
import { popularProviders } from "./order"

// kete_change start: OpenCode Go/Zen are opt-in in Kete Code (ADR 0003): listed after the other popular providers
test("lists OpenCode Go and Zen after the other popular providers", () => {
  expect(popularProviders.slice(-2)).toEqual(["opencode-go", "opencode"])
  expect(popularProviders[0]).toBe("anthropic")
})
// kete_change end
