import { expect, beforeEach, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// Other app tests can leave a home draft in the process-wide stash (as test/prompt-paste.test.tsx notes).
beforeEach(() => void takeDraft(undefined))

const TITLE = "Set up Kete Code"

type Answers = { signedIn?: boolean; syncFails?: boolean; ollamaModels?: number }

async function app(state: string, answers: Answers = {}) {
  await mkdir(state, { recursive: true })
  const asked = { rediscover: 0 }
  const setup = await createAppFixture({
    state,
    config: { animations: false, tips: false },
    fetch: (url) => {
      if (url.pathname === "/api/rpc/kete.sync/status") {
        if (answers.syncFails) return json({ message: "boom" }, { status: 500 })
        return json({ output: { signedIn: answers.signedIn ?? false, managedAgents: 0, offline: false } })
      }
      if (url.pathname === "/api/rpc/kete.local-models/status" && answers.ollamaModels !== undefined)
        return json({
          output: {
            offline: false,
            providers: [
              {
                id: "ollama",
                state: "reachable",
                source: "default",
                url: "http://127.0.0.1:11434/v1",
                models: answers.ollamaModels,
                insecure: false,
                hint: "Start it with `ollama serve`.",
              },
            ],
          },
        })
    },
  })
  return Object.assign(setup, { asked })
}

const doneFile = (state: string) => path.join(state, "test", "tui", "kete-setup.json")

test("setup: shows once with nothing set up, and Esc records it as done", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  {
    await using setup = await app(state)
    const frame = await setup.waitForFrame((frame) => frame.includes(TITLE))
    expect(frame).toContain("Sign in to Kete Code")
    expect(frame).toContain("Use my own API key")
    expect(frame).toContain("Use a local model")
    expect(frame).toContain("Skip for now")
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes(TITLE))
    await setup.waitFor(async () => (await readFile(doneFile(state), "utf8").catch(() => "")).includes("true"))
  }
  expect(JSON.parse(await readFile(doneFile(state), "utf8"))).toEqual({ done: true })

  // A restart on the same state: the screen does not come back.
  await using again = await app(state)
  await Bun.sleep(300)
  await again.renderOnce()
  expect(again.captureCharFrame()).not.toContain(TITLE)
})

test("setup: does not show when an account is signed in", async () => {
  await using tmp = await tmpdir()
  await using setup = await app(path.join(tmp.path, "state"), { signedIn: true })
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain(TITLE)
})

test("setup: does not show when the account state can't be read", async () => {
  await using tmp = await tmpdir()
  await using setup = await app(path.join(tmp.path, "state"), { syncFails: true })
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain(TITLE)
})

test("setup: the local row lists the reachable server with its model count", async () => {
  await using tmp = await tmpdir()
  await using setup = await app(path.join(tmp.path, "state"), { ollamaModels: 2 })
  await setup.waitForFrame((frame) => frame.includes("1 local server found"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Ollama · 2 models"))
  expect(frame).toContain("Check again")
})
