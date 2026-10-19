import { describe, expect, test } from "bun:test"
import { KeteEnv } from "../../src/kete/env.js"
import { KeteShareClient, ShareError } from "../../src/kete/share.js"

const key = "kete_secret_0123456789"
const created = { id: "s1", url: "https://portal.example/shares/s1", visibility: "org", expires_at: "2026-11-01T00:00:00Z", created_at: "2026-10-18T00:00:00Z" }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

function setup(respond: () => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = []
  const options = {
    platform: "https://portal.example",
    key,
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return respond()
    },
  }
  return { seen, options }
}

const failure = async (run: () => Promise<unknown>) => {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ShareError)
  return error as ShareError
}

describe("KeteShareClient", () => {
  test("create posts with the key and returns the share", async () => {
    const { seen, options } = setup(() => json(201, created))
    const result = await KeteShareClient.create(options, { session_id: "ses_1", title: "t", visibility: "org", snapshot: {} })
    expect(result.id).toBe("s1")
    expect(seen[0]!.url).toBe("https://portal.example/api/v1/shares")
    expect(seen[0]!.init.method).toBe("POST")
    expect(seen[0]!.init.redirect).toBe("error")
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`)
  })

  test("update puts to the share id", async () => {
    const { seen, options } = setup(() => json(200, created))
    await KeteShareClient.update(options, "s1", { title: "t", snapshot: {} })
    expect(seen[0]!.url).toBe("https://portal.example/api/v1/shares/s1")
    expect(seen[0]!.init.method).toBe("PUT")
  })

  test("remove resolves on 204 and reports 404 as not_found", async () => {
    await KeteShareClient.remove(setup(() => new Response(null, { status: 204 })).options, "s1")
    const error = await failure(() => KeteShareClient.remove(setup(() => json(404, { error: { code: "not_found", message: "gone" } })).options, "s1"))
    expect(error.code).toBe("not_found")
  })

  test.each([
    [401, "invalid_key", "unauthorized"],
    [403, "share_disabled", "share_disabled"],
    [403, "share_link_not_allowed", "share_link_not_allowed"],
    [404, "not_found", "not_found"],
    [413, "payload_too_large", "payload_too_large"],
    [429, "rate_limited", "rate_limited"],
    [503, "unavailable", "server"],
  ] as const)("%i %s maps to %s, keeps the request id, never the key", async (status, code, expected) => {
    const { options } = setup(() => json(status, { error: { code, message: `bad ${key}`.replace(key, "x"), request_id: "r7" } }))
    const error = await failure(() => KeteShareClient.create(options, { session_id: "ses_1", title: "t", visibility: "org", snapshot: { secret: key } }))
    expect(error.code).toBe(expected)
    expect(error.requestId).toBe("r7")
    expect(error.message).not.toContain(key)
  })

  test("a bad body or an unsafe url is invalid_response", async () => {
    const bad = await failure(() => KeteShareClient.create(setup(() => json(201, { id: "s1" })).options, { session_id: "a", title: "t", visibility: "org", snapshot: {} }))
    expect(bad.code).toBe("invalid_response")
    const http = await failure(() =>
      KeteShareClient.create(setup(() => json(201, { ...created, url: "http://evil.example/s" })).options, { session_id: "a", title: "t", visibility: "org", snapshot: {} }),
    )
    expect(http.code).toBe("invalid_response")
    const local = await KeteShareClient.create(setup(() => json(201, { ...created, url: "http://localhost:3000/shares/s1" })).options, { session_id: "a", title: "t", visibility: "org", snapshot: {} })
    expect(local.url).toContain("localhost")
  })

  test("a timeout and a refused redirect are typed and do not leak the key", async () => {
    const timeout = await failure(() =>
      KeteShareClient.remove(setup(() => Promise.reject(new DOMException("timed out", "TimeoutError"))).options, "s1"),
    )
    expect(timeout.code).toBe("timeout")
    const redirect = await failure(() =>
      KeteShareClient.remove(setup(() => Promise.reject(new TypeError(`redirect to https://x/${key}`))).options, "s1"),
    )
    expect(redirect.code).toBe("network")
    expect(redirect.message).not.toContain(key)
  })

  test("a url or expiry with control characters is invalid_response; error detail and request id lose them", async () => {
    const body = { session_id: "a", title: "t", visibility: "org" as const, snapshot: {} }
    for (const bad of [{ url: "https://portal.example/s\u001b[2J" }, { url: "https://portal.example/\u00e9" }, { expires_at: "soon\u001b[2J" }]) {
      const error = await failure(() => KeteShareClient.create(setup(() => json(201, { ...created, ...bad })).options, body))
      expect(error.code).toBe("invalid_response")
    }
    const rejected = await failure(() =>
      KeteShareClient.create(
        setup(() => json(400, { error: { code: "bad_request", message: "no\u001b]0;pwned\u0007 way", request_id: "r\u009b1" } })).options,
        body,
      ),
    )
    expect(rejected.message).toBe("The platform rejected the share request: no]0;pwned way (request r1)")
    expect(rejected.requestId).toBe("r1")
  })

  test("an agent shell is recognized before and after the env bridge", () => {
    const env: KeteEnv.Environment = { [KeteEnv.agentShell]: "1" }
    expect(KeteEnv.inAgentShell(env)).toBe(true)
    KeteEnv.bridge(env)
    expect(KeteEnv.inAgentShell(env)).toBe(true)
    expect(KeteEnv.inAgentShell({})).toBe(false)
  })

  test("policy defaults to org for 30 days", () => {
    expect(KeteShareClient.policy(undefined)).toEqual({ mode: "org", max_days: 30 })
    expect(KeteShareClient.policy({ share: { mode: "link", max_days: 7 } })).toEqual({ mode: "link", max_days: 7 })
  })
})
