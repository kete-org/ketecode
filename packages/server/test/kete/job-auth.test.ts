import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { KeteConstantTime } from "../../src/kete/constant-time"
import { authorizedRequest } from "../../src/middleware/authorization"

const config = { password: Option.some("secret"), username: "opencode" }
const basic = `Basic ${btoa("opencode:secret")}`
const token = encodeURIComponent(btoa("opencode:secret"))

const authorized = (url: string, headers: Record<string, string> = {}) =>
  Effect.runPromise(authorizedRequest(HttpServerRequest.fromWeb(new Request(url, { headers })), config))

const previous = process.env.OPENCODE_JOB_MODE
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_JOB_MODE
  else process.env.OPENCODE_JOB_MODE = previous
})

describe("?auth_token= (AC4)", () => {
  test("is accepted outside job mode", async () => {
    delete process.env.OPENCODE_JOB_MODE
    expect(await authorized(`http://localhost/api/info?auth_token=${token}`)).toBe(true)
  })

  test("is refused in job mode, even alongside a valid Basic header", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    expect(await authorized(`http://localhost/api/info?auth_token=${token}`)).toBe(false)
    expect(await authorized(`http://localhost/api/info?auth_token=${token}`, { authorization: basic })).toBe(false)
  })

  test("an invalid job-mode value fails closed (refused)", async () => {
    process.env.OPENCODE_JOB_MODE = "yes"
    expect(await authorized(`http://localhost/api/info?auth_token=${token}`)).toBe(false)
  })

  test("Basic auth alone still works in job mode", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    expect(await authorized("http://localhost/api/info", { authorization: basic })).toBe(true)
    expect(await authorized("http://localhost/api/info", { authorization: `Basic ${btoa("opencode:wrong")}` })).toBe(
      false,
    )
  })
})

describe("KeteConstantTime.equal", () => {
  test("equal strings", () => {
    expect(KeteConstantTime.equal("secret", "secret")).toBe(true)
    expect(KeteConstantTime.equal("", "")).toBe(true)
    expect(KeteConstantTime.equal("pässwörd", "pässwörd")).toBe(true)
  })

  test("different, prefix, longer, empty and non-ASCII", () => {
    expect(KeteConstantTime.equal("secreT", "secret")).toBe(false)
    expect(KeteConstantTime.equal("secre", "secret")).toBe(false)
    expect(KeteConstantTime.equal("secrets", "secret")).toBe(false)
    expect(KeteConstantTime.equal("", "secret")).toBe(false)
    expect(KeteConstantTime.equal("secret", "")).toBe(false)
    expect(KeteConstantTime.equal("pässwörd", "passwörd")).toBe(false)
    // A NUL-padded guess must not match a shorter password.
    expect(KeteConstantTime.equal("secret\0", "secret")).toBe(false)
  })
})
