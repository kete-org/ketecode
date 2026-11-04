import { expect, beforeEach, test } from "bun:test"
import path from "node:path"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { bar } from "../../src/kete/context"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

test("/context is offered, opens the dialog (home has no session to measure) and esc closes it", async () => {
  const tmp = await tmpdir()
  await using _tmp = tmp
  const setup = await createAppFixture({ state: path.join(tmp.path, "state"), height: 50 })
  await using _setup = setup
  await setup.waitForFrame((frame) => frame.includes("╰"))
  await setup.mockInput.typeText("/cont")
  await setup.waitForFrame((frame) => frame.includes("/context"))
  await setup.mockInput.typeText("ext")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Context usage") && frame.includes("Open a session"))
  expect(frame).toContain("Close")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Context usage"))
})

test("bar: proportional, at least one cell for a non-empty part, empty for none", () => {
  expect(bar(50, 100, 10)).toBe("█████░░░░░")
  expect(bar(1, 1000, 10)).toBe("█░░░░░░░░░")
  expect(bar(0, 100, 10)).toBe("░░░░░░░░░░")
  expect(bar(5, 0, 10)).toBe("░░░░░░░░░░")
})
