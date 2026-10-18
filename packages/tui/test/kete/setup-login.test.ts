import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { SetupLogin } from "../../src/kete/setup-login"

function fake() {
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill() {
      child.killed = true
      emitter.emit("close", null)
    },
  })
  return { child, spawn: () => child }
}

describe("setup sign-in child", () => {
  test("reports only the URL line, then ok on exit 0", async () => {
    const { child, spawn } = fake()
    const urls: string[] = []
    const run = SetupLogin.start({ spawn, command: ["kete"], onURL: (url) => urls.push(url) })
    child.stdout.emit("data", "Signing in to Kete Code at https://p.example\n\nOpen this URL")
    child.stdout.emit("data", " in your browser:\n  https://p.example/authorize?state=s\n")
    child.emit("close", 0)
    expect(await run.result).toEqual({ kind: "ok" })
    expect(urls).toEqual(["https://p.example/authorize?state=s"])
  })

  test("failure carries only the last stderr line without the Warning prefix", async () => {
    const { child, spawn } = fake()
    const run = SetupLogin.start({ spawn, command: ["kete"], onURL: () => {} })
    child.stdout.emit("data", "secret-looking stdout\n")
    child.stderr.emit("data", "first\nWarning: Approval was denied.\n")
    child.emit("close", 1)
    expect(await run.result).toEqual({ kind: "failed", reason: "Approval was denied." })
  })

  test("cancel kills the child", async () => {
    const { child, spawn } = fake()
    const run = SetupLogin.start({ spawn, command: ["kete"], onURL: () => {} })
    run.cancel()
    expect(child.killed).toBe(true)
    expect(await run.result).toEqual({ kind: "cancelled" })
  })

  test("timeout kills the child", async () => {
    const { child, spawn } = fake()
    const run = SetupLogin.start({ spawn, command: ["kete"], onURL: () => {}, timeout: 10 })
    expect(await run.result).toEqual({ kind: "failed", reason: "Sign-in timed out." })
    expect(child.killed).toBe(true)
  })

  test("the failure line has no control characters and is bounded; cancel after the end does nothing", async () => {
    const { child, spawn } = fake()
    const run = SetupLogin.start({ spawn, command: ["kete"], onURL: () => {} })
    child.stderr.emit("data", "Warning: bad \u001b[31mthing\u0007" + "x".repeat(400) + "\n")
    child.emit("close", 1)
    const result = await run.result
    expect(result.kind).toBe("failed")
    const reason = result.kind === "failed" ? result.reason : ""
    expect(reason.startsWith("bad [31mthing")).toBe(true)
    expect(reason.length).toBeLessThanOrEqual(300)
    run.cancel()
    expect(child.killed).toBe(false)
  })
})
