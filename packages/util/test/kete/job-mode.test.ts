import { describe, expect, test } from "bun:test"
import { KeteJobMode } from "../../src/kete/job-mode.js"

describe("KeteJobMode.endpoints", () => {
  test("normalises the entrypoint's URLs and drops anything that is not http(s)", () => {
    expect(
      KeteJobMode.endpoints({ OPENCODE_GATEWAY_URL: "https://gw.example/base/", OPENCODE_PLATFORM_URL: "http://localhost:3000///" }),
    ).toEqual({ gateway: "https://gw.example/base", platform: "http://localhost:3000" })
    expect(KeteJobMode.endpoints({ OPENCODE_GATEWAY_URL: "ftp://x", OPENCODE_PLATFORM_URL: "nope" })).toEqual({
      gateway: undefined,
      platform: undefined,
    })
    expect(KeteJobMode.endpoints({})).toEqual({ gateway: undefined, platform: undefined })
    expect(KeteJobMode.platformURLPublicName).toBe("KETE_PLATFORM_URL")
  })
})

describe("KeteJobMode.read / enabled", () => {
  test("unset or empty is off", () => {
    expect(KeteJobMode.read({})).toEqual({ kind: "off" })
    expect(KeteJobMode.read({ OPENCODE_JOB_MODE: "" })).toEqual({ kind: "off" })
    expect(KeteJobMode.enabled({})).toBe(false)
  })

  test('"1" is on', () => {
    expect(KeteJobMode.read({ OPENCODE_JOB_MODE: "1" })).toEqual({ kind: "on" })
    expect(KeteJobMode.enabled({ OPENCODE_JOB_MODE: "1" })).toBe(true)
  })

  test("anything else is invalid, and fails closed (enabled)", () => {
    expect(KeteJobMode.read({ OPENCODE_JOB_MODE: "true" })).toEqual({ kind: "invalid", value: "true" })
    expect(KeteJobMode.enabled({ OPENCODE_JOB_MODE: "0" })).toBe(true)
    expect(KeteJobMode.enabled({ OPENCODE_JOB_MODE: "yes" })).toBe(true)
  })

  test("an invalid value is truncated to 50 characters", () => {
    const long = "x".repeat(80)
    const flag = KeteJobMode.read({ OPENCODE_JOB_MODE: long })
    expect(flag).toEqual({ kind: "invalid", value: `${"x".repeat(50)}…` })
  })

  test("publicName reports KETE_JOB_MODE", () => {
    expect(KeteJobMode.publicName).toBe("KETE_JOB_MODE")
    expect(KeteJobMode.maxOutputTokensPublicName).toBe("KETE_JOB_MAX_OUTPUT_TOKENS")
  })
})

describe("KeteJobMode.refuseSpawn", () => {
  test("is a no-op when job mode is off", () => {
    expect(() => KeteJobMode.refuseSpawn("git", {})).not.toThrow()
  })

  test("throws the shared wording when job mode is on", () => {
    expect(() => KeteJobMode.refuseSpawn("git", { OPENCODE_JOB_MODE: "1" })).toThrow(
      "Job mode: tools run only through the job's tool runner; refused to start `git`.",
    )
  })

  test("throws when the value is invalid (fail closed)", () => {
    expect(() => KeteJobMode.refuseSpawn("git", { OPENCODE_JOB_MODE: "maybe" })).toThrow(KeteJobMode.SpawnRefusedError)
  })
})

describe("KeteJobMode.maxOutputTokens", () => {
  test("undefined when unset, empty, non-integer, zero or negative", () => {
    expect(KeteJobMode.maxOutputTokens({})).toBeUndefined()
    expect(KeteJobMode.maxOutputTokens({ OPENCODE_JOB_MAX_OUTPUT_TOKENS: "" })).toBeUndefined()
    expect(KeteJobMode.maxOutputTokens({ OPENCODE_JOB_MAX_OUTPUT_TOKENS: "abc" })).toBeUndefined()
    expect(KeteJobMode.maxOutputTokens({ OPENCODE_JOB_MAX_OUTPUT_TOKENS: "0" })).toBeUndefined()
    expect(KeteJobMode.maxOutputTokens({ OPENCODE_JOB_MAX_OUTPUT_TOKENS: "-5" })).toBeUndefined()
    expect(KeteJobMode.maxOutputTokens({ OPENCODE_JOB_MAX_OUTPUT_TOKENS: "3.5" })).toBeUndefined()
  })

  test("a positive integer", () => {
    expect(KeteJobMode.maxOutputTokens({ OPENCODE_JOB_MAX_OUTPUT_TOKENS: "32000" })).toBe(32000)
  })
})

describe("KeteJobMode.toolSocket", () => {
  test("unset or empty is unset", () => {
    expect(KeteJobMode.toolSocket({})).toEqual({ kind: "unset" })
    expect(KeteJobMode.toolSocket({ OPENCODE_JOB_TOOL_SOCKET: "" })).toEqual({ kind: "unset" })
  })

  test("an absolute path is path", () => {
    expect(KeteJobMode.toolSocket({ OPENCODE_JOB_TOOL_SOCKET: "/run/kete/tool.sock" })).toEqual({
      kind: "path",
      path: "/run/kete/tool.sock",
    })
  })

  test("a relative path is invalid", () => {
    expect(KeteJobMode.toolSocket({ OPENCODE_JOB_TOOL_SOCKET: "relative/tool.sock" })).toEqual({
      kind: "invalid",
      value: "relative/tool.sock",
    })
  })

  test("a value with a NUL byte is invalid", () => {
    expect(KeteJobMode.toolSocket({ OPENCODE_JOB_TOOL_SOCKET: "/run/kete/tool\0.sock" })).toEqual({
      kind: "invalid",
      value: "/run/kete/tool\0.sock",
    })
  })

  test("toolSocketPublicName reports KETE_JOB_TOOL_SOCKET", () => {
    expect(KeteJobMode.toolSocketPublicName).toBe("KETE_JOB_TOOL_SOCKET")
  })
})
