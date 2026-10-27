import { expect, beforeEach, mock, test } from "bun:test"
import path from "node:path"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

// /doctor reads only whether an account is signed in; that is faked, as for /feedback.
mock.module("../../src/kete/feedback-deps", () => ({
  openURL: async () => {},
  signedIn: async () => true,
  logTail: async () => undefined,
  save: async () => "/tmp/unused",
}))

const { collect } = await import("../../src/kete/doctor")

test("/doctor shows the grouped checks and a summary; esc closes it", async () => {
  const tmp = await tmpdir()
  await using _tmp = tmp
  const setup = await createAppFixture({ state: path.join(tmp.path, "state"), height: 50 })
  await using _setup = setup
  await setup.waitForFrame((frame) => frame.includes("╰"))
  await setup.mockInput.typeText("/doctor")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Check setup") && frame.includes("Install") && !frame.includes("Checking…"))
  expect(frame).toContain("Run again")
  expect(frame).toContain("Signed in to your Kete Code account")
  expect(frame).toMatch(/Everything looks fine\.|problem|warning/)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Check setup"))
})

test("collect: a malformed doctor answer is unknown, not trusted; no default model is null", async () => {
  const api = {
    provider: { list: async () => ({ data: [{ id: "ollama", activation: "auto" }] }) },
    model: { default: async () => ({ data: null }) },
    mcp: { list: async () => ({ data: [] }) },
    rpc: {
      call: async (input: { rpcID: string }) =>
        input.rpcID === "kete.doctor"
          ? { output: { files: "not a list" } }
          : { output: { state: "on", platform: "darwin", mode: "auto", network: "approved", ignored: [] } },
    },
  }
  const facts = await collect({
    api: api as never,
    location: undefined,
    version: "0.2.8",
    channel: "latest",
    home: "/home/alice",
    signedIn: async () => false,
  })
  expect(facts.runtime).toBe(true)
  expect(facts.report).toBeUndefined()
  expect(facts.defaultModel).toBeNull()
  expect(facts.providers).toEqual(["ollama"])
  expect(facts.sandbox?.state).toBe("on")
  expect(facts.signedIn).toBe("no")
})
