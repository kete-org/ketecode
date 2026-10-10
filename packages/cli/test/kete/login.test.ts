import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { KeteAccount } from "@opencode/util/kete/account"
import { AccountFlow } from "../../src/kete/account-flow"
import { CliLogin } from "../../src/kete/cli-login"

const apiKey = "kete_sk_cli_SECRET0123456789abcdefXYZ"
const keyID = "3b9f7a5e-1111-4222-8333-444455556666"
const orgID = "3b9f7a5e-aaaa-4bbb-8ccc-ddddeeeeffff"

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

// ---------------------------------------------------------------------------------------------------
// Fakes: the platform, the browser, the OS credential store

type Mode = "ok" | "expired" | "invalid_request" | "down" | "unavailable" | "garbage"

function platform(options: { token?: Mode; logout?: Mode; me?: Mode } = {}) {
  const seen = { challenge: "", tokenBodies: [] as unknown[], logouts: [] as string[], me: 0 }
  const fail = (mode: Mode) =>
    mode === "expired"
      ? Response.json(
          { error: { code: "expired", message: "Code expired", request_id: "req_1" } },
          { status: 400, headers: { "x-kete-request-id": "req_1" } },
        )
      : mode === "invalid_request"
        ? Response.json({ error: { code: "invalid_request", message: "Bad verifier", request_id: "req_2" } }, { status: 400 })
        : mode === "unavailable"
          ? Response.json({ error: { code: "internal", message: "boom", request_id: "req_3" } }, { status: 503 })
          : Response.json({ nope: true })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/v1/cli/token" && request.method === "POST") {
        const body = (await request.json()) as { code: string; code_verifier: string; device_name: string }
        seen.tokenBodies.push(body)
        const mode = options.token ?? "ok"
        if (mode !== "ok") return fail(mode)
        const expected = createHash("sha256").update(body.code_verifier).digest("base64url")
        if (body.code !== "one-time-code" || expected !== seen.challenge)
          return Response.json({ error: { code: "invalid_request", message: "PKCE mismatch" } }, { status: 400 })
        return Response.json({
          api_key: apiKey,
          key_id: keyID,
          organization: { id: orgID, name: "Acme" },
          gateway_url: "https://gateway.example",
        })
      }
      if (url.pathname === "/api/v1/cli/logout" && request.method === "POST") {
        seen.logouts.push(request.headers.get("authorization") ?? "")
        const mode = options.logout ?? "ok"
        return mode === "ok" ? new Response(null, { status: 204 }) : fail(mode)
      }
      if (url.pathname === "/api/v1/me") {
        seen.me++
        const mode = options.me ?? "ok"
        if (mode !== "ok") return fail(mode)
        if (request.headers.get("authorization") !== `Bearer ${apiKey}`)
          return Response.json({ error: { code: "invalid_key", message: "Invalid key" } }, { status: 401 })
        return Response.json({
          key: { id: keyID, name: "CLI (laptop)", kind: "cli" },
          organization: { id: orgID, name: "Acme" },
          balance_micros: 12_500_000,
          currency: "USD",
          gateway_url: "https://gateway.example",
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  if (options.token === "down" || options.logout === "down" || options.me === "down") server.stop(true)
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

/** Plays the browser: approves (or denies) on the platform, which redirects to the loopback callback. */
function browser(fake: ReturnType<typeof platform>, outcome: "approve" | "deny" = "approve") {
  const visited: string[] = []
  return {
    visited,
    open: async (raw: string) => {
      visited.push(raw)
      const url = new URL(raw)
      fake.seen.challenge = url.searchParams.get("code_challenge") ?? ""
      const port = url.searchParams.get("port")
      const state = url.searchParams.get("state")
      const query = outcome === "approve" ? `code=one-time-code&state=${state}` : `error=access_denied&state=${state}`
      // Like a browser, this happens after the terminal has started waiting.
      setTimeout(() => void fetch(`http://127.0.0.1:${port}/callback?${query}`), 10)
    },
  }
}

function memoryStore(): KeteSecretStore.Store & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    kind: "keychain",
    description: "test keychain",
    set: async (name, value) => void entries.set(name, value),
    get: async (name) => entries.get(name),
    remove: async (name) => void entries.delete(name),
  }
}

async function io(environment: Record<string, string | undefined> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-login-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const native = memoryStore()
  const output: string[] = []
  const reloads = { count: 0 }
  const value = {
    print: (line: string) => void output.push(line),
    warn: (line: string) => void output.push(`Warning: ${line}`),
    account: { config: path.join(root, "config"), data: path.join(root, "data"), native },
    environment,
    reload: async () => {
      reloads.count++
      return true
    },
  } satisfies AccountFlow.IO
  return { io: value, output, native, reloads, root }
}

/** Every string that reached the user, plus thrown error messages. The key must appear in none. */
const leaked = (output: string[], error?: unknown) =>
  [...output, error instanceof Error ? error.message : ""].some((line) => line.includes(apiKey))

// ---------------------------------------------------------------------------------------------------

describe("PKCE and state", () => {
  test("S256 challenge matches RFC 7636 appendix B", () => {
    expect(CliLogin.challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  test("verifier, challenge and state fit the platform's rules and are random", () => {
    const first = CliLogin.pkce()
    const second = CliLogin.pkce()
    expect(first.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.challenge).toBe(CliLogin.challengeFor(first.verifier))
    expect(first.verifier).not.toBe(second.verifier)
    expect(CliLogin.state()).toMatch(/^[A-Za-z0-9._~-]{8,256}$/)
    expect(CliLogin.state()).not.toBe(CliLogin.state())
  })

  test("the authorize URL carries the platform's parameters", () => {
    const url = new URL(
      CliLogin.authorizeURL({ platform: "https://p.example/base", port: 49152, state: "s".repeat(43), challenge: "c".repeat(43), device: "my laptop" }),
    )
    expect(url.origin + url.pathname).toBe("https://p.example/base/cli/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      port: "49152",
      state: "s".repeat(43),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      device_name: "my laptop",
    })
  })

  test("device names are made printable and at most 100 characters", () => {
    expect(CliLogin.deviceName("laptop\u0000é.local")).toBe("laptop.local")
    expect(CliLogin.deviceName("x".repeat(300))).toHaveLength(100)
    expect(CliLogin.deviceName("éé")).toBe("unknown device")
  })

  test("platform URLs must be https unless they are on this machine", () => {
    expect(CliLogin.platformURL("https://p.example/", "--platform-url")).toBe("https://p.example")
    expect(CliLogin.platformURL("http://127.0.0.1:3000/", "--platform-url")).toBe("http://127.0.0.1:3000")
    expect(CliLogin.platformURL("http://localhost:3000", "--platform-url")).toBe("http://localhost:3000")
    expect(() => CliLogin.platformURL("http://p.example", "--platform-url")).toThrow("must use https")
    expect(() => CliLogin.platformURL("https://user:pw@p.example", "--platform-url")).toThrow("credentials")
    expect(() => CliLogin.platformURL("ftp://p.example", "--platform-url")).toThrow("https")
  })

  test("platform URLs with a stray character in the host are refused, not turned into a broken link", () => {
    expect(() => CliLogin.platformURL("https://ketecode-portal.vercel.app,", "--platform-url")).toThrow("trailing comma")
    expect(() => CliLogin.platformURL("https://p.example!", "--platform-url")).toThrow("invalid host")
    expect(() => CliLogin.platformURL("https://p..example", "--platform-url")).toThrow("invalid host")
    expect(CliLogin.platformURL("https://ketecode-portal.vercel.app", "--platform-url")).toBe("https://ketecode-portal.vercel.app")
    expect(CliLogin.platformURL("https://sub-1.p.example:8443/base/", "--platform-url")).toBe("https://sub-1.p.example:8443/base")
    expect(CliLogin.platformURL("http://[::1]:3000", "--platform-url")).toBe("http://[::1]:3000")
  })
})

describe("loopback callback", () => {
  const state = "state-0123456789abcdef"

  test("listens only on 127.0.0.1", async () => {
    const callback = CliLogin.listen({ state })
    cleanup.push(() => callback.close())
    callback.code.catch(() => undefined)
    expect(callback.port).toBeGreaterThanOrEqual(1024)
    const loopback = await fetch(`http://127.0.0.1:${callback.port}/other`)
    expect(loopback.status).toBe(404)
    // Not bound to IPv6 loopback or any other interface.
    await expect(fetch(`http://[::1]:${callback.port}/callback`)).rejects.toThrow()
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((item) => item?.family === "IPv4" && !item.internal)
    if (external) await expect(fetch(`http://${external.address}:${callback.port}/callback`)).rejects.toThrow()
  })

  test("refuses a mismatched state and keeps waiting for the real callback", async () => {
    const callback = CliLogin.listen({ state })
    const forged = await fetch(`http://127.0.0.1:${callback.port}/callback?code=evil&state=wrong`)
    expect(forged.status).toBe(400)
    const missing = await fetch(`http://127.0.0.1:${callback.port}/callback?code=evil`)
    expect(missing.status).toBe(400)
    const real = await fetch(`http://127.0.0.1:${callback.port}/callback?code=good&state=${state}`)
    expect(real.status).toBe(200)
    const page = await real.text()
    expect(page).toContain("Kete Code")
    // Kete Code's violet: #6E47F5 on light backgrounds, its tint #A38CFA on dark ones.
    expect(page).toContain("--brand: #6e47f5;")
    expect(page).toContain("--brand: #a38cfa;")
    expect(real.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await callback.code).toBe("good")
  })

  test("refuses requests with another Host header (DNS rebinding)", async () => {
    const callback = CliLogin.listen({ state })
    cleanup.push(() => callback.close())
    callback.code.catch(() => undefined)
    const response = await fetch(`http://127.0.0.1:${callback.port}/callback?code=x&state=${state}`, {
      headers: { host: `attacker.example:${callback.port}` },
    })
    expect(response.status).toBe(421)
  })

  test("closes the listener after the callback", async () => {
    const callback = CliLogin.listen({ state })
    await fetch(`http://127.0.0.1:${callback.port}/callback?code=good&state=${state}`)
    await callback.code
    await Bun.sleep(100)
    await expect(fetch(`http://127.0.0.1:${callback.port}/callback`)).rejects.toThrow()
  })

  test("times out and closes the listener", async () => {
    const callback = CliLogin.listen({ state, timeout: 60 })
    await expect(callback.code).rejects.toThrow("Timed out")
    await Bun.sleep(100)
    await expect(fetch(`http://127.0.0.1:${callback.port}/callback`)).rejects.toThrow()
  })

  test("reports a denied authorization", async () => {
    const callback = CliLogin.listen({ state })
    const response = await fetch(`http://127.0.0.1:${callback.port}/callback?error=access_denied&state=${state}`)
    expect(response.status).toBe(200)
    await expect(callback.code).rejects.toThrow("cancelled in the browser")
  })
})

describe("token exchange", () => {
  const exchange = (url: string) =>
    CliLogin.exchange({ platform: url, code: "one-time-code", verifier: "v".repeat(43), device: "laptop" })

  test("an expired or reused code", async () => {
    const fake = platform({ token: "expired" })
    const error = await exchange(fake.url).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CliLogin.PlatformError)
    expect((error as CliLogin.PlatformError).code).toBe("expired")
    expect((error as Error).message).toContain("expired or was already used")
    expect((error as Error).message).toContain("req_1")
  })

  test("a rejected request", async () => {
    const error = await exchange(platform({ token: "invalid_request" }).url).catch((error: unknown) => error)
    expect((error as CliLogin.PlatformError).code).toBe("rejected")
    expect((error as Error).message).toContain("Bad verifier")
  })

  test("the platform is down", async () => {
    const error = await exchange(platform({ token: "unavailable" }).url).catch((error: unknown) => error)
    expect((error as CliLogin.PlatformError).code).toBe("unavailable")
    expect((error as Error).message).toContain("HTTP 503")
  })

  test("a network failure", async () => {
    const error = await exchange(platform({ token: "down" }).url).catch((error: unknown) => error)
    expect((error as CliLogin.PlatformError).code).toBe("network")
    expect((error as Error).message).toContain("Could not reach")
  })

  test("an unexpected response", async () => {
    const error = await exchange(platform({ token: "garbage" }).url).catch((error: unknown) => error)
    expect((error as CliLogin.PlatformError).code).toBe("invalid_response")
  })
})

describe("kete login", () => {
  test("signs in: PKCE exchange, key in the credential store, details in account.json", async () => {
    const fake = platform()
    const session = await io()
    const open = browser(fake)
    await AccountFlow.login(session.io, { platformURL: fake.url, open: open.open, ssh: false })

    expect(fake.seen.tokenBodies).toEqual([
      { code: "one-time-code", code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), device_name: CliLogin.deviceName() },
    ])
    const account = await KeteAccount.read(session.io.account)
    expect(account).toMatchObject({
      platform_url: fake.url,
      gateway_url: "https://gateway.example",
      organization: { id: orgID, name: "Acme" },
      key_id: keyID,
      storage: "keychain",
    })
    expect(await KeteAccount.key(session.io.account, account!)).toBe(apiKey)
    expect(session.output).toContain("Signed in to Acme.")
    expect(session.output.some((line) => line.includes(open.visited[0]!))).toBe(true)
    expect(session.reloads.count).toBe(1)
    expect(leaked(session.output)).toBe(false)
  })

  test("reads the platform URL from KETE_PLATFORM_URL", async () => {
    const fake = platform()
    const session = await io({ [AccountFlow.platformVariable]: fake.url })
    await AccountFlow.login(session.io, { open: browser(fake).open, ssh: false })
    expect((await KeteAccount.read(session.io.account))?.platform_url).toBe(fake.url)
  })

  test("says that the account takes precedence over hand-configured gateway settings", async () => {
    const fake = platform()
    const session = await io({ OPENCODE_GATEWAY_KEY: "hand-key" })
    await Bun.write(
      path.join(session.io.account.config, "kete.json"),
      JSON.stringify({ providers: { kete: { settings: { baseURL: "http://localhost:8787" } } } }),
    )
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    const notice = session.output.find((line) => line.includes("takes precedence"))
    expect(notice).toContain("providers.kete in your config")
    expect(notice).toContain("KETE_GATEWAY_KEY")
    expect(notice).not.toContain("hand-key")
  })

  test("a denied authorization stores nothing", async () => {
    const fake = platform()
    const session = await io()
    const error = await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake, "deny").open, ssh: false }).catch(
      (error: unknown) => error,
    )
    expect((error as Error).message).toContain("cancelled in the browser")
    expect(await KeteAccount.read(session.io.account)).toBeUndefined()
    expect(fake.seen.tokenBodies).toEqual([])
  })

  test("a failed exchange stores nothing and never shows the key", async () => {
    const fake = platform({ token: "expired" })
    const session = await io()
    const error = await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false }).catch(
      (error: unknown) => error,
    )
    expect((error as Error).message).toContain("expired or was already used")
    expect(await KeteAccount.read(session.io.account)).toBeUndefined()
    expect(leaked(session.output, error)).toBe(false)
  })

  test("signing in again revokes and forgets the previous key", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    const first = await KeteAccount.read(session.io.account)
    // Make the second login issue a different key id by rewriting the stored one.
    await KeteAccount.save(session.io.account, { ...first!, key_id: "0ld00000-0000-4000-8000-000000000000" }, apiKey)
    await KeteAccount.removeKey(session.io.account, first!)
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    expect(fake.seen.logouts).toEqual([`Bearer ${apiKey}`])
    expect(session.native.entries.size).toBe(1)
    expect((await KeteAccount.read(session.io.account))?.key_id).toBe(keyID)
  })

  test("suggests --port in an SSH session", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: true })
    expect(session.output.some((line) => line.includes("ssh -L"))).toBe(true)
  })
})

describe("kete logout", () => {
  const signedIn = async (options: Parameters<typeof platform>[0] = {}) => {
    const fake = platform(options)
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    return { fake, session }
  }

  test("revokes the key on the platform and removes it locally", async () => {
    const { fake, session } = await signedIn()
    await AccountFlow.logout(session.io)
    expect(fake.seen.logouts).toEqual([`Bearer ${apiKey}`])
    expect(session.native.entries.size).toBe(0)
    expect(await KeteAccount.read(session.io.account)).toBeUndefined()
    expect(session.output[0]).toBe("Signed out of Acme. The key was removed from this device.")
    expect(leaked(session.output)).toBe(false)
  })

  test("clears local credentials even when the platform call fails, and says so", async () => {
    const { session } = await signedIn({ logout: "unavailable" })
    await AccountFlow.logout(session.io)
    expect(session.native.entries.size).toBe(0)
    expect(await KeteAccount.read(session.io.account)).toBeUndefined()
    const warning = session.output.find((line) => line.startsWith("Warning:"))
    expect(warning).toContain("could not revoke the key")
    expect(warning).toContain("HTTP 503")
    expect(warning).toContain(keyID)
    expect(leaked(session.output)).toBe(false)
  })

  test("clears local credentials when the platform is unreachable", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    for (const task of cleanup.splice(0, 1)) await task() // stop the platform
    await AccountFlow.logout(session.io)
    expect(await KeteAccount.read(session.io.account)).toBeUndefined()
    expect(session.native.entries.size).toBe(0)
    expect(session.output.some((line) => line.includes("Could not reach"))).toBe(true)
  })

  test("when not signed in", async () => {
    const session = await io()
    await AccountFlow.logout(session.io)
    expect(session.output).toEqual(["Not signed in."])
  })
})

describe("kete whoami", () => {
  test("shows the account, organization, platform and storage, never the key", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    expect(await AccountFlow.whoami(session.io)).toBe(true)
    const text = session.output.join("\n")
    expect(text).toContain("Organization: Acme")
    expect(text).toContain(`Platform:     ${fake.url}`)
    expect(text).toContain("stored in test keychain")
    expect(text).toContain("active (CLI (laptop), balance 12.50 USD)")
    expect(leaked(session.output)).toBe(false)
  })

  test("reports a revoked key", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    const account = await KeteAccount.read(session.io.account)
    await KeteAccount.save(session.io.account, account!, "kete_sk_revoked")
    session.output.length = 0
    await AccountFlow.whoami(session.io)
    expect(session.output.join("\n")).toContain("revoked or invalid")
  })

  test("when not signed in, mentions hand configuration", async () => {
    const session = await io({ OPENCODE_GATEWAY_URL: "http://localhost:8787" })
    expect(await AccountFlow.whoami(session.io)).toBe(false)
    expect(session.output.join("\n")).toContain("configured by hand (KETE_GATEWAY_URL)")
  })

  test("prints the runtime type from kete.runtime.type when it isn't local", async () => {
    const fake = platform()
    const session = await io()
    await Bun.write(path.join(session.io.account.config, "kete.json"), JSON.stringify({ kete: { runtime: { type: "kete_cloud" } } }))
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    await AccountFlow.whoami(session.io)
    expect(session.output.join("\n")).toContain("Runtime:      kete_cloud")
  })

  test("says nothing about the runtime when it is local", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    await AccountFlow.whoami(session.io)
    expect(session.output.join("\n")).not.toContain("Runtime:")
  })

  test("falls back to KETE_RUNTIME_TYPE when the config doesn't set kete.runtime.type", async () => {
    const fake = platform()
    const session = await io({ OPENCODE_RUNTIME_TYPE: "enterprise_private" })
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    await AccountFlow.whoami(session.io)
    expect(session.output.join("\n")).toContain("Runtime:      enterprise_private")
  })

  test("warns and skips registration on an unknown runtime type", async () => {
    const fake = platform()
    const session = await io({ OPENCODE_RUNTIME_TYPE: "moon_base" })
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    await AccountFlow.whoami(session.io)
    const warning = session.output.find((line) => line.startsWith("Warning:"))
    expect(warning).toContain("KETE_RUNTIME_TYPE")
    expect(warning).toContain("moon_base")
    expect(warning).toContain("registration is skipped")
  })
})

describe("kete whoami --format json", () => {
  test("describes the signed-in account without the key or a network request", async () => {
    const fake = platform()
    const session = await io()
    await AccountFlow.login(session.io, { platformURL: fake.url, open: browser(fake).open, ssh: false })
    session.output.length = 0
    const before = fake.seen.me
    expect(await AccountFlow.whoamiJSON(session.io)).toBe(true)
    expect(session.output).toHaveLength(1)
    expect(JSON.parse(session.output[0]!)).toMatchObject({
      signed_in: true,
      organization: { id: orgID, name: "Acme" },
      platform_url: fake.url,
      gateway_url: "https://gateway.example",
      key_id: keyID,
      storage: "keychain",
      storage_description: "test keychain",
      hand_configured: [],
    })
    expect(fake.seen.me).toBe(before)
    expect(leaked(session.output)).toBe(false)
  })

  test("when not signed in", async () => {
    const session = await io({ OPENCODE_GATEWAY_URL: "http://localhost:8787" })
    expect(await AccountFlow.whoamiJSON(session.io)).toBe(false)
    expect(JSON.parse(session.output[0]!)).toEqual({ signed_in: false, hand_configured: ["KETE_GATEWAY_URL"] })
  })
})
