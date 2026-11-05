import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FAKE_ANSWER, fakeProvider, writeProviderConfig } from "./fake-provider"

const stops: Array<() => unknown> = []
const dirs: string[] = []

afterEach(async () => {
  stops.splice(0).forEach((stop) => void stop())
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test("streams the answer as chat.completion.chunk events and ends with [DONE]", async () => {
  const fake = fakeProvider()
  stops.push(fake.stop)
  const response = await fetch(`${fake.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  const lines = (await response.text()).split("\n").filter((line) => line.startsWith("data: "))
  expect(lines.at(-1)).toBe("data: [DONE]")
  const events = lines.slice(0, -1).map((line) => JSON.parse(line.slice(6)))
  expect(events.length).toBeGreaterThan(1)
  expect(events.map((event) => event.choices[0].delta.content ?? "").join("")).toBe(FAKE_ANSWER)
  expect(events.at(-1).choices[0].finish_reason).toBe("stop")
  expect(events.at(-1).usage.total_tokens).toBe(7)
  expect(fake.requests).toEqual(["POST /v1/chat/completions"])
})

test("answers 404 on any other path", async () => {
  const fake = fakeProvider()
  stops.push(fake.stop)
  expect((await fetch(`${fake.baseURL}/models`)).status).toBe(404)
  expect((await fetch(`${fake.baseURL}/chat/completions`)).status).toBe(404)
})

test("writeProviderConfig writes kete.json under the test root's config dir only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kete-e2e-test-"))
  dirs.push(root)
  await writeProviderConfig(root, "http://127.0.0.1:9/v1")
  const config = await Bun.file(path.join(root, "config", "kete", "kete.json")).json()
  expect(config.model).toBe("kete-e2e/fake")
  expect(config.provider["kete-e2e"].options.baseURL).toBe("http://127.0.0.1:9/v1")
  expect(config.provider["kete-e2e"].models.fake.name).toBe("Fake")
  expect(await fs.readdir(root)).toEqual(["config"])
})
