import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { KeteDumpable } from "../../src/kete/dumpable"

describe("KeteDumpable.disable", () => {
  test("non-Linux platforms are unsupported and never call prctl", () => {
    let calls = 0
    const prctl: KeteDumpable.Prctl = () => {
      calls++
      return { result: 0, errno: 0 }
    }
    expect(KeteDumpable.disable("darwin", prctl)).toEqual({ kind: "unsupported" })
    expect(KeteDumpable.disable("win32", prctl)).toEqual({ kind: "unsupported" })
    expect(calls).toBe(0)
  })

  test("sets then reads back the flag", () => {
    const calls: Array<[number, number]> = []
    const prctl: KeteDumpable.Prctl = (option, arg) => {
      calls.push([option, arg])
      return { result: 0, errno: 0 }
    }
    expect(KeteDumpable.disable("linux", prctl)).toEqual({ kind: "ok" })
    expect(calls).toEqual([
      [4, 0],
      [3, 0],
    ])
  })

  test("a failing PR_SET_DUMPABLE is failed, with errno", () => {
    const result = KeteDumpable.disable("linux", () => ({ result: -1, errno: 1 }))
    expect(result).toMatchObject({ kind: "failed", errno: 1 })
    if (result.kind === "failed") expect(KeteDumpable.message(result)).toContain("errno 1")
  })

  test("still dumpable after the call is failed", () => {
    const result = KeteDumpable.disable("linux", (option) => ({ result: option === 3 ? 1 : 0, errno: 0 }))
    expect(result).toMatchObject({ kind: "failed", errno: 0 })
  })

  test("a throwing prctl (no libc, no Bun) is failed, not thrown", () => {
    const result = KeteDumpable.disable("linux", () => {
      throw new Error("no libc")
    })
    expect(result).toMatchObject({ kind: "failed", reason: "no libc" })
  })

  test.skipIf(process.platform !== "linux")("Linux: a real process becomes non-dumpable (its /proc files turn root-owned)", async () => {
    const module = path.join(import.meta.dir, "../../src/kete/dumpable.ts")
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { KeteDumpable } = await import(${JSON.stringify(module)});` +
          `const r = KeteDumpable.disable(); console.log(JSON.stringify(r)); await Bun.stdin.text()`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    )
    const reader = child.stdout.getReader()
    const first = await reader.read()
    const line = new TextDecoder().decode(first.value)
    expect(JSON.parse(line.trim())).toEqual({ kind: "ok" })
    // A non-dumpable process's /proc/<pid> files belong to root (proc(5)); as root that tells us
    // nothing, and the child's own PR_GET_DUMPABLE read-back (the "ok" above) is the evidence.
    if (process.getuid?.() !== 0) expect(fs.statSync(`/proc/${child.pid}/environ`).uid).toBe(0)
    child.stdin.end()
    expect(await child.exited).toBe(0)
  })
})
