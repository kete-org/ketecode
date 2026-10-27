import { expect, beforeEach, test } from "bun:test"
import path from "node:path"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

test("/terminal-setup shows what this terminal needs, and Ctrl+J; esc closes it", async () => {
  const tmp = await tmpdir()
  await using _tmp = tmp
  const setup = await createAppFixture({ state: path.join(tmp.path, "state"), height: 40 })
  await using _setup = setup
  await setup.waitForFrame((frame) => frame.includes("╰"))
  await setup.mockInput.typeText("/terminal-setup")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Set up Shift+Enter"))
  expect(frame).toContain("Ctrl+J inserts a newline")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Set up Shift+Enter"))
})
