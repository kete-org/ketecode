import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseURL, Server, type Status } from "../src/server"

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

// An executable `kete` that runs test/fixture/fake-kete.ts with the given mode.
async function fakeKete(mode: string, extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-server-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, "kete")
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dir, "fixture/fake-kete.ts")}" "$@"\n`)
  await chmod(file, 0o755)
  const log = path.join(root, "starts.log")
  const statuses: Status[] = []
  const server = new Server({
    binary: async () => file,
    cwd: root,
    env: { FAKE_KETE_MODE: mode, FAKE_KETE_LOG: log, ...extra },
    onStatus: (status) => statuses.push(status),
    startTimeout: 2_000,
    backoff: { initial: 20, max: 80, maxFailures: 3, failureWindow: 10_000 },
  })
  cleanup.push(() => server.stop(500))
  const starts = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
  return { server, statuses, starts }
}

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const end = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe.skipIf(process.platform === "win32")("server lifecycle", () => {
  test("starts kete serve on 127.0.0.1, a random port and a per-session password", async () => {
    const { server, statuses, starts } = await fakeKete("ok")
    const [first, second] = await Promise.all([server.connection(), server.connection()])
    expect(first).toEqual(second)
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await starts()).toEqual(["serve --stdio --hostname 127.0.0.1 --port 0"])
    expect(statuses.map((status) => status.state)).toEqual(["starting", "running"])
    // The password is required.
    expect((await fetch(first.url)).status).toBe(401)
    const auth = `Basic ${btoa(`opencode:${first.password}`)}`
    expect((await fetch(first.url, { headers: { authorization: auth } })).status).toBe(200)
  })

  test("a new session gets a new password", async () => {
    const { server } = await fakeKete("ok")
    const first = await server.connection()
    const second = await server.restart()
    expect(second.password).not.toBe(first.password)
    expect(second.url).not.toBe(first.url)
  })

  test("stop closes stdin and the server exits", async () => {
    const { server, statuses } = await fakeKete("ok")
    const connection = await server.connection()
    await server.stop()
    expect(server.state).toEqual({ state: "stopped" })
    expect(statuses.at(-1)).toEqual({ state: "stopped" })
    await expect(fetch(connection.url)).rejects.toThrow()
  })

  test("restarts after a crash, with growing delays", async () => {
    const { server, statuses, starts } = await fakeKete("crash-after-start", { FAKE_KETE_DELAY: "100" })
    await server.connection()
    await until(async () => (await starts()).length >= 2)
    const restarting = statuses.filter((status) => status.state === "restarting")
    expect(restarting[0]).toMatchObject({ attempt: 1, delay: 20 })
    await until(() => statuses.filter((status) => status.state === "restarting").length >= 2)
    expect(statuses.filter((status) => status.state === "restarting")[1]).toMatchObject({ attempt: 2, delay: 40 })
  })

  test("gives up after repeated failures and reports why", async () => {
    const { server, statuses, starts } = await fakeKete("exit-early")
    await expect(server.connection()).rejects.toThrow("exited before it was ready")
    await until(() => server.state.state === "failed")
    expect(await starts()).toHaveLength(3)
    expect(server.state).toMatchObject({ state: "failed" })
    if (server.state.state === "failed") expect(server.state.reason).toContain("Stopped restarting after 3 failures")
    expect(statuses.filter((status) => status.state === "restarting")).toHaveLength(2)
    // A manual start tries again from scratch.
    await expect(server.connection()).rejects.toThrow()
  })

  test("a server that never reports its URL times out", async () => {
    const { server } = await fakeKete("hang")
    await expect(server.connection()).rejects.toThrow("did not start within 2 seconds")
  })

  test("a missing binary fails with a clear error", async () => {
    const server = new Server({ binary: async () => "/nonexistent/kete", cwd: os.tmpdir(), backoff: { initial: 10, max: 10, maxFailures: 1, failureWindow: 1_000 } })
    await expect(server.connection()).rejects.toThrow("The kete binary was not found")
    expect(server.state.state).toBe("failed")
  })

  test("a binary that can't be resolved fails without spawning anything", async () => {
    const server = new Server({ binary: async () => Promise.reject(new Error("no kete binary for this platform")), cwd: os.tmpdir() })
    await expect(server.connection()).rejects.toThrow("no kete binary for this platform")
    expect(server.state).toEqual({ state: "failed", reason: "no kete binary for this platform" })
  })
})

describe("start line", () => {
  test("accepts only a loopback http URL", () => {
    expect(parseURL('{"url":"http://127.0.0.1:4096"}')).toBe("http://127.0.0.1:4096")
    expect(parseURL('{"url":"http://localhost:4096/"}')).toBe("http://localhost:4096")
    expect(parseURL('{"url":"http://0.0.0.0:4096"}')).toBeUndefined()
    expect(parseURL('{"url":"http://attacker.example:4096"}')).toBeUndefined()
    expect(parseURL('{"url":"https://127.0.0.1:4096"}')).toBeUndefined()
    expect(parseURL("not json")).toBeUndefined()
    expect(parseURL('{"nope":1}')).toBeUndefined()
  })
})
