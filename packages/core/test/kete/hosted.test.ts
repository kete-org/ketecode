import { describe, expect, test } from "bun:test"
import { KeteHosted } from "@opencode/core/kete/hosted"

// Behaviour is covered in test/plugin/provider-opencode.test.ts; this pins the default
// so re-enabling anonymous OpenCode Zen access is a deliberate, reviewed change.
describe("Kete hosted-service defaults", () => {
  test("OpenCode Zen is not enabled anonymously", () => {
    expect(KeteHosted.anonymousOpencodeZen).toBe(false)
  })
})
