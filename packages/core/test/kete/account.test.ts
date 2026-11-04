// The `kete.account` plugin (core/src/kete/account.ts): status, login (one attempt, a validated approval
// URL, an event when it ends), cancel, logout, refusal offline and in job mode, and no secrets in what it
// sends. The child is the fixtures/fake-login.ts stand-in, never the real `kete login` (the real one
// writes the developer's OS keychain); logout uses the same stand-in for the same reason.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Config } from "@opencode/core/config"
import { KeteAccount } from "@opencode/core/kete/account"
import { Brand } from "@opencode/util/kete/brand"
import { host } from "../plugin/host"

const fixture = path.join(import.meta.dir, "fixtures", "fake-login.ts")

let dir: string
let saved: Record<string, string | undefined>
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kete-account-"))
  saved = { offline: process.env.OPENCODE_OFFLINE, job: process.env.OPENCODE_JOB_MODE }
})
afterEach(async () => {
  for (const [name, value] of [["OPENCODE_OFFLINE", saved.offline], ["OPENCODE_JOB_MODE", saved.job]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(dir, { recursive: true, force: true })
})

async function start(extra: Partial<KeteAccount.Options> = {}) {
  const emitted: Array<{ name: string; data: unknown }> = []
  let handlers: Record<string, (input: unknown) => Effect.Effect<any, any>> = {}
  const ctx: Plugin.Context = host({
    rpc: Object.assign(() => Effect.die("unused"), {
      register: (_definition: unknown, given: any) =>
        Effect.sync(() => {
          handlers = given
          return {
            dispose: Effect.void,
            events: { emit: (name: string, data: unknown) => Effect.sync(() => void emitted.push({ name, data })) },
          }
        }),
    }) as any,
  })
  const scope = Effect.runSync(Scope.make())
  const plugin = KeteAccount.make({
    config: dir,
    command: [process.execPath, fixture],
    env: { ...process.env, FAKE_LOGIN_CONFIG: dir },
    ...extra,
  })
  await Effect.runPromise(
    plugin.effect(ctx).pipe(
      Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) } as any)),
      Scope.provide(scope),
    ),
  )
  const call = (method: string) => Effect.runPromise(handlers[method]!({}))
  return { call, emitted, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("kete.account", () => {
  test("status reports signed out, then the organization and platform host without the key id", async () => {
    const h = await start()
    expect(await h.call("status")).toEqual({ signedIn: false, offline: false, signingIn: false })
    await writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        version: 1,
        platform_url: "https://platform.example/some/path",
        gateway_url: "https://gateway.example",
        organization: { id: "org_1", name: "Acme" },
        key_id: "key_1",
        device_name: "test",
        storage: "file",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    )
    const status = await h.call("status")
    expect(status).toEqual({ signedIn: true, organization: "Acme", platform: "platform.example", offline: false, signingIn: false })
    expect(JSON.stringify(status)).not.toContain("key_1")
    process.env.OPENCODE_OFFLINE = "1"
    expect((await h.call("status")).offline).toBe(true)
    await h.close()
  })

  test("login returns the approval URL, repeats it for a second call, and announces signed-in when the child ends", async () => {
    const h = await start()
    const first = await h.call("login")
    expect(first.kind).toBe("started")
    const url = new URL(first.url)
    expect(url.pathname).toBe("/cli/authorize")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(await h.call("login")).toEqual(first)
    expect((await h.call("status")).signingIn).toBe(true)
    await fetch(`http://127.0.0.1:${url.port}/cli/callback`)
    await until(() => h.emitted.length > 0, "the changed event")
    expect(h.emitted).toEqual([{ name: "changed", data: { state: "signed-in", message: undefined } }])
    expect((await h.call("status")).signingIn).toBe(false)
    expect((await h.call("status")).signedIn).toBe(true)
    await h.close()
  })

  test("login rejects an unexpected approval URL", async () => {
    const h = await start({ env: { ...process.env, FAKE_LOGIN_CONFIG: dir, FAKE_LOGIN_URL: "https://evil.example/steal" } })
    const result = await h.call("login")
    expect(result.kind).toBe("failed")
    expect(JSON.stringify(result)).not.toContain("evil.example")
    await h.close()
  })

  test("login fails when the child never prints a URL in time", async () => {
    const h = await start({ command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], urlTimeout: 100 })
    expect((await h.call("login")).kind).toBe("failed")
    await h.close()
  })

  test("cancel stops the attempt and announces cancelled", async () => {
    const h = await start()
    expect((await h.call("login")).kind).toBe("started")
    expect(await h.call("cancel")).toEqual({ cancelled: true })
    await until(() => h.emitted.length > 0, "the changed event")
    expect(h.emitted[0]).toEqual({ name: "changed", data: { state: "cancelled", message: undefined } })
    expect(await h.call("cancel")).toEqual({ cancelled: false })
    await h.close()
  })

  test("logout runs the child, removes the account and announces signed-out", async () => {
    const h = await start()
    await writeFile(path.join(dir, "account.json"), "{}")
    expect(await h.call("logout")).toEqual({ kind: "done" })
    await expect(readFile(path.join(dir, "account.json"), "utf8")).rejects.toThrow()
    expect(h.emitted).toEqual([{ name: "changed", data: { state: "signed-out", message: undefined } }])
    await h.close()
  })

  test("logout reports a failing child as failed", async () => {
    const h = await start({ command: [process.execPath, "-e", "process.exit(3)"] })
    expect((await h.call("logout")).kind).toBe("failed")
    expect(h.emitted).toEqual([])
    await h.close()
  })

  test("logout cancels a sign-in that is still waiting, so it can't sign back in", async () => {
    const h = await start()
    expect((await h.call("login")).kind).toBe("started")
    expect((await h.call("status")).signingIn).toBe(true)
    expect(await h.call("logout")).toEqual({ kind: "done" })
    expect((await h.call("status")).signingIn).toBe(false)
    // Only the sign-out is announced: the cancelled attempt stays silent.
    expect(h.emitted).toEqual([{ name: "changed", data: { state: "signed-out", message: undefined } }])
    expect((await h.call("login")).kind).toBe("started")
    await h.close()
  })

  test("logout carries a not-revoked warning as a message without the key id", async () => {
    const warn = "console.error('Warning: The platform could not revoke the key (503). Revoke key key_1 at https://p.example.')"
    const h = await start({ command: [process.execPath, "-e", warn] })
    const result = await h.call("logout")
    expect(result).toEqual({ kind: "done", message: KeteAccount.REVOKE_WARNING })
    expect(JSON.stringify([result, h.emitted])).not.toContain("key_1")
    await h.close()
  })

  test("login and logout are refused offline and in job mode, without starting a child", async () => {
    const h = await start({ command: [process.execPath, "-e", "throw new Error('must not run')"] })
    process.env.OPENCODE_OFFLINE = "1"
    for (const method of ["login", "logout"]) {
      const result = await h.call(method)
      expect(result).toMatchObject({ kind: "refused", reason: "offline" })
    }
    delete process.env.OPENCODE_OFFLINE
    process.env.OPENCODE_JOB_MODE = "1"
    for (const method of ["login", "logout"]) {
      const result = await h.call(method)
      expect(result).toMatchObject({ kind: "refused", reason: "job-mode" })
    }
    expect(h.emitted).toEqual([])
    await h.close()
  })

  // The real `kete login --no-browser` / `kete logout` from source, against a fake platform on 127.0.0.1.
  // The OS key store is made unusable with stub `security` / `secret-tool` commands (the only PATH entry), so
  // the key goes to the file store under the temp XDG_DATA_HOME and the developer's keychain is never touched.
  test.skipIf(process.platform === "win32")(
    "real CLI: login yields the platform's approval URL, approval signs in, logout revokes and signs out",
    async () => {
      const apiKey = "kete_sk_real_SECRET0123456789abcdefXYZ"
      const keyID = "3b9f7a5e-1111-4222-8333-444455556666"
      const seen = { challenge: "", logouts: [] as string[] }
      const platform = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url)
          if (url.pathname === "/api/v1/cli/token" && request.method === "POST") {
            const body = (await request.json()) as { code: string; code_verifier: string }
            const expected = new Bun.CryptoHasher("sha256").update(body.code_verifier).digest("base64url")
            if (body.code !== "one-time-code" || expected !== seen.challenge)
              return Response.json({ error: { code: "invalid_request", message: "PKCE mismatch" } }, { status: 400 })
            return Response.json({
              api_key: apiKey,
              key_id: keyID,
              organization: { id: "3b9f7a5e-aaaa-4bbb-8ccc-ddddeeeeffff", name: "Acme" },
              gateway_url: "https://gateway.example",
            })
          }
          if (url.pathname === "/api/v1/cli/logout" && request.method === "POST") {
            seen.logouts.push(`${request.method} ${url.pathname}`)
            return new Response(null, { status: 204 })
          }
          return new Response("not found", { status: 404 })
        },
      })
      const stubs = path.join(dir, "stubs")
      await mkdir(stubs)
      for (const name of ["security", "secret-tool"]) await writeFile(path.join(stubs, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const home = path.join(dir, "home")
      const cliDir = path.resolve(import.meta.dir, "../../../cli")
      const env: Record<string, string | undefined> = { ...process.env }
      for (const name of Object.keys(env)) if (/^(KETE|OPENCODE|BUN_)/i.test(name) || /PROXY$/i.test(name)) delete env[name]
      delete env.XDG_RUNTIME_DIR
      Object.assign(env, {
        PATH: stubs,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        KETE_PLATFORM_URL: `http://127.0.0.1:${platform.port}`,
        KETE_DISABLE_AUTOUPDATE: "true",
        KETE_DISABLE_MODELS_FETCH: "1",
      })
      const h = await start({
        config: path.join(home, "config", Brand.appDirectory),
        // --cwd: the CLI resolves its bunfig preload and JSX runtime from its own package.
        command: [process.execPath, "run", `--cwd=${cliDir}`, "src/index.ts"],
        env,
        urlTimeout: 45_000,
      })
      try {
        const seenByClient: unknown[] = []
        const started = await h.call("login")
        seenByClient.push(started)
        expect(started).toMatchObject({ kind: "started" })
        const url = new URL(started.url)
        expect(url.origin).toBe(`http://127.0.0.1:${platform.port}`)
        expect(url.pathname).toBe("/cli/authorize")
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        seen.challenge = url.searchParams.get("code_challenge") ?? ""
        // The browser: the platform approves and redirects to the CLI's loopback callback.
        await fetch(`http://127.0.0.1:${url.searchParams.get("port")}/callback?code=one-time-code&state=${url.searchParams.get("state")}`)
        await until(() => h.emitted.some((event: any) => event.data.state === "signed-in"), "signed-in")
        const status = await h.call("status")
        seenByClient.push(status)
        expect(status).toMatchObject({ signedIn: true, organization: "Acme", platform: `127.0.0.1:${platform.port}` })

        const out = await h.call("logout")
        seenByClient.push(out)
        expect(out.kind).toBe("done")
        expect(seen.logouts).toEqual(["POST /api/v1/cli/logout"])
        const after = await h.call("status")
        seenByClient.push(after)
        expect(after.signedIn).toBe(false)
        expect(h.emitted.at(-1)).toEqual({ name: "changed", data: { state: "signed-out", message: undefined } })

        const text = JSON.stringify([seenByClient, h.emitted])
        for (const secret of [apiKey, keyID]) expect(text).not.toContain(secret)
      } finally {
        await h.close()
        platform.stop(true)
      }
    },
    120_000,
  )

  test("secret values: no payload or event carries the key id, code or verifier", async () => {
    const h = await start()
    const seen: unknown[] = []
    const first = await h.call("login")
    seen.push(first, await h.call("status"))
    await fetch(`http://127.0.0.1:${new URL(first.url).port}/cli/callback`)
    await until(() => h.emitted.length > 0, "the changed event")
    seen.push(await h.call("status"), await h.call("logout"), h.emitted)
    const text = JSON.stringify(seen)
    for (const secret of ["key_1", "code_verifier", "code="]) expect(text).not.toContain(secret)
    await h.close()
  })
})
