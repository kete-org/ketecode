import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { KeteLoginChild } from "../../src/kete/login-child.js"

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
  const calls: string[][] = []
  return {
    child,
    calls,
    spawn: (command: string[]) => {
      calls.push(command)
      return child
    },
  }
}

const saved = process.env.OPENCODE_JOB_MODE
afterEach(() => {
  if (saved === undefined) delete process.env.OPENCODE_JOB_MODE
  else process.env.OPENCODE_JOB_MODE = saved
})

describe("login child", () => {
  test("passes the args, reports the URL line, then ok on exit 0", async () => {
    const { child, spawn, calls } = fake()
    const urls: string[] = []
    const run = KeteLoginChild.start({ args: ["login", "--no-browser"], spawn, command: ["kete"], onURL: (url) => urls.push(url) })
    child.stdout.emit("data", "Signing in at https://p.example\n  https://p.example/cli/authorize?state=s\n")
    child.emit("close", 0)
    expect(await run.result).toEqual({ kind: "ok" })
    expect(urls).toEqual(["https://p.example/cli/authorize?state=s"])
    expect(calls).toEqual([["kete", "login", "--no-browser"]])
  })

  test("cancel kills the child and reports cancelled", async () => {
    const { child, spawn } = fake()
    const run = KeteLoginChild.start({ args: ["login"], spawn, command: ["kete"] })
    run.cancel()
    expect(child.killed).toBe(true)
    expect(await run.result).toEqual({ kind: "cancelled" })
  })

  test("timeout kills the child", async () => {
    const { child, spawn } = fake()
    const run = KeteLoginChild.start({ args: ["login"], spawn, command: ["kete"], timeout: 10 })
    expect(await run.result).toEqual({ kind: "failed", reason: "Sign-in timed out." })
    expect(child.killed).toBe(true)
  })

  test("a non-zero exit carries only the sanitised last stderr line", async () => {
    const { child, spawn } = fake()
    const run = KeteLoginChild.start({ args: ["logout"], spawn, command: ["kete"] })
    child.stdout.emit("data", "secret-looking stdout\n")
    child.stderr.emit("data", "first\nWarning: bad \u001b[31mthing\n")
    child.emit("close", 1)
    expect(await run.result).toEqual({ kind: "failed", reason: "bad [31mthing" })
  })

  test("job mode refuses to spawn", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    const { spawn, calls } = fake()
    const run = KeteLoginChild.start({ args: ["login"], spawn, command: ["kete"] })
    const result = await run.result
    expect(result.kind).toBe("failed")
    expect(calls).toEqual([])
  })
})
