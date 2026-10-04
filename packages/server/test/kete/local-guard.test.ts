import { describe, expect, test } from "bun:test"
import { request } from "node:http"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { it } from "../../../core/test/lib/effect"
import { KeteLocalGuard } from "../../src/kete/local-guard"
import { ServerProcess } from "../../src/process"

const options = { hostname: "127.0.0.1", cors: ["https://allowed.example"] }

describe("KeteLocalGuard.check", () => {
  test("accepts loopback names and IP literals", () => {
    for (const host of ["127.0.0.1:4096", "localhost:4096", "[::1]:4096", "192.168.1.10:4096", "LOCALHOST:1"])
      expect(KeteLocalGuard.check({ host }, options)).toEqual({ ok: true })
  })

  test("rejects other host names (DNS rebinding) and a missing Host", () => {
    expect(KeteLocalGuard.check({ host: "attacker.example:4096" }, options)).toEqual({
      ok: false,
      reason: "host attacker.example is not allowed",
    })
    expect(KeteLocalGuard.check({ host: "127.0.0.1.attacker.example" }, options).ok).toBe(false)
    expect(KeteLocalGuard.check({ host: "localhost.attacker.example" }, options).ok).toBe(false)
    expect(KeteLocalGuard.check({}, options)).toEqual({ ok: false, reason: "missing Host header" })
    expect(KeteLocalGuard.check({ host: "user@127.0.0.1" }, options).ok).toBe(false)
  })

  test("accepts the bound host name and explicitly allowed hosts", () => {
    expect(KeteLocalGuard.check({ host: "devbox.local:4096" }, { hostname: "devbox.local" }).ok).toBe(true)
    const forwarded = { hostname: "127.0.0.1", allowedHosts: [".app.github.dev", "tunnel.example"] }
    expect(KeteLocalGuard.check({ host: "space-4096.app.github.dev" }, forwarded).ok).toBe(true)
    expect(KeteLocalGuard.check({ host: "tunnel.example:8443" }, forwarded).ok).toBe(true)
    expect(KeteLocalGuard.check({ host: "evil-app.github.dev" }, forwarded).ok).toBe(false)
    expect(KeteLocalGuard.check({ host: "sub.tunnel.example" }, forwarded).ok).toBe(false)
  })

  test("accepts same-origin, --cors and desktop-app origins only", () => {
    const host = "127.0.0.1:4096"
    expect(KeteLocalGuard.check({ host, origin: "http://127.0.0.1:4096" }, options).ok).toBe(true)
    expect(KeteLocalGuard.check({ host, origin: "https://allowed.example" }, options).ok).toBe(true)
    expect(KeteLocalGuard.check({ host, origin: "oc://renderer" }, options).ok).toBe(true)
    for (const origin of [
      "http://127.0.0.1:3000",
      "http://localhost:4096",
      "https://app.opencode.ai",
      "https://attacker.example",
      "vscode-webview://abc123",
      "null",
    ])
      expect(KeteLocalGuard.check({ host, origin }, options)).toEqual({ ok: false, reason: `origin ${origin} is not allowed` })
  })

  test("reads allowed hosts from the environment", () => {
    expect(
      KeteLocalGuard.allowedHostsFromEnvironment({ [KeteLocalGuard.allowedHostsVariable]: " A.example, .b.example ,," }),
    ).toEqual(["a.example", ".b.example"])
    expect(KeteLocalGuard.allowedHostsFromEnvironment({})).toEqual([])
  })
})

// Raw HTTP, so the test controls the Host header exactly as a rebinding browser would send it.
function send(url: string, headers: Record<string, string>, method = "GET") {
  return new Promise<number>((resolve, reject) => {
    const target = new URL(url)
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, method, headers, setHost: !headers.host },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end()
  })
}

const auth = `Basic ${btoa("opencode:secret")}`

it.live("the running server enforces the password, Host and Origin", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test" },
      database: { path: ":memory:" },
    })
    const url = new URL("/api/info", HttpServer.formatAddress(server.address)).href
    const port = new URL(url).port
    const status = (headers: Record<string, string>, method?: string) =>
      Effect.promise(() => send(url, headers, method))

    // Unauthenticated: refused.
    expect(yield* status({})).toBe(401)
    expect(yield* status({ authorization: `Basic ${btoa("opencode:wrong")}` })).toBe(401)
    // Authenticated from this machine: accepted.
    expect(yield* status({ authorization: auth })).toBe(200)
    expect(yield* status({ authorization: auth, host: `localhost:${port}` })).toBe(200)
    // DNS rebinding: the attacker's name in Host, even with a (stolen) password.
    expect(yield* status({ authorization: auth, host: `attacker.example:${port}` })).toBe(403)
    // A web page elsewhere, including another local port and upstream's hosted app.
    for (const origin of [`http://127.0.0.1:${Number(port) + 1}`, "https://app.opencode.ai", "https://attacker.example"])
      expect(yield* status({ authorization: auth, origin })).toBe(403)
    // Its preflight is refused too, so it never learns what the API allows.
    expect(
      yield* status(
        { origin: "https://attacker.example", "access-control-request-method": "GET" },
        "OPTIONS",
      ),
    ).toBe(403)
    // The server's own web UI (same origin) works.
    expect(yield* status({ authorization: auth, origin: `http://127.0.0.1:${port}` })).toBe(200)
  }),
)
