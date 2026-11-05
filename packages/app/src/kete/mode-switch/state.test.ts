import { describe, expect, test } from "bun:test"
import { CODE_ONLY, choose, chosen, createFields, decodeModes, effective, fetchModes, step, type Mode } from "./state"

const code: Mode = { id: "code", name: "Code", description: "Edit code", agent: "build", available: true }
const work = (available: boolean): Mode => ({ id: "work", name: "Work", description: "Knowledge work", agent: "work-orchestrator", available })

describe("decodeModes", () => {
  test("keeps a valid list with Work unavailable", () => {
    expect(decodeModes([code, work(false)])).toEqual([code, work(false)])
  })
  test("garbage is Code only", () => {
    expect(decodeModes("nope")).toBe(CODE_ONLY)
    expect(decodeModes([{ id: "code" }])).toBe(CODE_ONLY)
  })
  test("a list without an available Code is Code only", () => {
    expect(decodeModes([work(true)])).toBe(CODE_ONLY)
    expect(decodeModes([{ ...code, available: false }, work(true)])).toBe(CODE_ONLY)
  })
})

describe("fetchModes", () => {
  const client = (call: () => Promise<{ output: unknown }>) => ({ rpc: { call } }) as never
  test("decodes the runtime's reply", async () => {
    expect(await fetchModes(client(async () => ({ output: [code, work(true)] })))).toEqual([code, work(true)])
  })
  test("a missing RPC, a network error and an undecodable reply are Code only", async () => {
    expect(await fetchModes(client(() => Promise.reject({ code: "rpc.method_not_found" })))).toBe(CODE_ONLY)
    expect(await fetchModes(client(() => Promise.reject(new Error("network"))))).toBe(CODE_ONLY)
    expect(await fetchModes(client(async () => ({ output: { not: "a list" } })))).toBe(CODE_ONLY)
  })
})

describe("effective", () => {
  test("the saved mode when it is listed and available", () => {
    expect(effective("work", [code, work(true)])).toBe("work")
  })
  test("Code when the saved mode is unavailable, unknown or missing", () => {
    expect(effective("work", [code, work(false)])).toBe("code")
    expect(effective("bogus", [code, work(true)])).toBe("code")
    expect(effective(undefined, [code, work(true)])).toBe("code")
  })
})

describe("createFields", () => {
  test("Code changes nothing and adds no key", () => {
    expect(createFields({ agent: "build", metadata: undefined, mode: "code" })).toEqual({ agent: "build", metadata: undefined })
    expect(createFields({ agent: "build", metadata: { a: 1 }, mode: undefined })).toEqual({ agent: "build", metadata: { a: 1 } })
  })
  test("Work leaves the agent to the runtime and keeps the permission mode", () => {
    expect(createFields({ agent: "build", metadata: { "kete.permissionMode": "ask" }, mode: "work" })).toEqual({
      agent: undefined,
      metadata: { "kete.permissionMode": "ask", "kete.sessionMode": "work" },
    })
  })
  test("Work without draft metadata", () => {
    expect(createFields({ agent: "build", metadata: undefined, mode: "work" }).metadata).toEqual({ "kete.sessionMode": "work" })
  })
})

describe("step", () => {
  test("skips unavailable modes and wraps", () => {
    expect(step([code, work(true)], "code", 1)).toBe("work")
    expect(step([code, work(true)], "work", 1)).toBe("code")
    expect(step([code, work(true)], "code", -1)).toBe("work")
    expect(step([code, work(false)], "code", 1)).toBe("code")
  })
})

describe("chosen", () => {
  test("differs by server and by directory, and is undefined when nothing was chosen", () => {
    expect(chosen("s1", "/a")).toBeUndefined()
    choose("s1", "/a", "work")
    choose("s1", "/b", "code")
    expect(chosen("s1", "/a")).toBe("work")
    expect(chosen("s1", "/b")).toBe("code")
    expect(chosen("s2", "/a")).toBeUndefined()
  })
})
