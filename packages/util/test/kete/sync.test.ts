import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteAccount } from "../../src/kete/account.js"
import type { KeteSecretStore } from "../../src/kete/secret-store.js"
import { KeteSyncCache } from "../../src/kete/sync/cache.js"
import { KeteSync } from "../../src/kete/sync/sync.js"

const key = "kete_test_SYNC0123456789abcdef"
const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"

const agent = (slug: string, version = 1, overrides: { delegable?: boolean } = {}) => ({
  id: `3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c${String(slug.length).padStart(2, "0")}`,
  slug,
  version,
  name: slug,
  description: `The ${slug} agent.`,
  mode: "primary" as const,
  model: { provider: "anthropic" as const, model_id: "claude-sonnet-4-5" },
  instructions: `You are ${slug}.`,
  tools: { edit: true, shell: false, web: false, skills: [], subagents: [], mcp: {} },
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ],
  budget: { monthly_micros: null, spent_micros: 0, period: "2026-09" },
  // v1 only gains optional fields: unknown ones are ignored.
  future_field: { anything: true },
  ...overrides,
})

type Reply = { status: number; etag?: string; body?: unknown }

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function platform(replies: Reply[]) {
  const seen: Array<{ authorization: string | null; ifNoneMatch: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({ authorization: request.headers.get("authorization"), ifNoneMatch: request.headers.get("if-none-match") })
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!
      const headers: Record<string, string> = { "x-kete-request-id": `req-${seen.length}` }
      if (reply.etag) headers.etag = reply.etag
      if (reply.status === 304) return new Response(null, { status: 304, headers })
      return Response.json(reply.body ?? {}, { status: reply.status, headers })
    },
  })
  cleanup.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const ok = (etag: string, agents: unknown[]): Reply => ({
  status: 200,
  etag,
  body: { organization: { id: org, name: "Kete Labs" }, generated_at: "2026-09-25T20:15:00Z", agents },
})

function memoryStore(): KeteSecretStore.Store {
  const entries = new Map<string, string>()
  return {
    kind: "keychain",
    description: "test keychain",
    set: async (name, value) => void entries.set(name, value),
    get: async (name) => entries.get(name),
    remove: async (name) => void entries.delete(name),
  }
}

async function home(platformURL?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-sync-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
  if (platformURL)
    await KeteAccount.save(
      options,
      {
        platform_url: platformURL,
        gateway_url: "https://gateway.example",
        organization: { id: org, name: "Kete Labs" },
        key_id: "3f1c2b7e-0000-4000-8000-000000000001",
        device_name: "test",
      },
      key,
    )
  return options
}

const cacheFile = (config: string) => KeteSyncCache.file(config, org)

describe("KeteSync", () => {
  test("not signed in: does nothing, no request", async () => {
    const fake = platform([ok('"e1"', [agent("developer")])])
    const options = await home()
    expect(await KeteSync.sync({ ...options })).toEqual({ kind: "signed-out" })
    expect(fake.seen).toEqual([])
    expect(await KeteSync.load(options)).toBeUndefined()
  })

  test("200: stores the agents with the ETag, authenticated with the account key", async () => {
    const fake = platform([ok('"e1"', [agent("developer"), agent("code-reviewer")])])
    const options = await home(fake.url)
    const outcome = await KeteSync.sync({ ...options, now: () => new Date("2026-09-25T20:16:00Z") })
    expect(outcome.kind).toBe("updated")
    if (outcome.kind !== "updated") return
    expect(outcome.changes).toEqual({ added: ["developer", "code-reviewer"], updated: [], removed: [] })
    expect(fake.seen).toEqual([{ authorization: `Bearer ${key}`, ifNoneMatch: null }])
    const loaded = await KeteSync.load(options)
    expect(loaded?.cached.etag).toBe('"e1"')
    expect(loaded?.cached.synced_at).toBe("2026-09-25T20:16:00.000Z")
    expect(loaded?.cached.response.agents.map((item) => item.slug)).toEqual(["developer", "code-reviewer"])
    // Stored apart from user-authored agents, private to the user, and without the key.
    expect(cacheFile(options.config)).toBe(path.join(options.config, "managed", org, "agents.json"))
    const text = await readFile(cacheFile(options.config), "utf8")
    expect(text).not.toContain(key)
    expect(text).not.toContain("future_field")
    if (process.platform !== "win32") expect((await stat(cacheFile(options.config))).mode & 0o777).toBe(0o600)
  })

  test("304: sends If-None-Match and leaves the cache untouched", async () => {
    const fake = platform([ok('"e1"', [agent("developer")]), { status: 304, etag: '"e1"' }])
    const options = await home(fake.url)
    await KeteSync.sync(options)
    const before = await readFile(cacheFile(options.config), "utf8")
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind).toBe("unchanged")
    expect(fake.seen[1]?.ifNoneMatch).toBe('"e1"')
    expect(await readFile(cacheFile(options.config), "utf8")).toBe(before)
  })

  test("an agent the platform no longer returns is removed; a new version is an update", async () => {
    const fake = platform([
      ok('"e1"', [agent("developer"), agent("code-reviewer")]),
      ok('"e2"', [agent("developer", 2)]),
    ])
    const options = await home(fake.url)
    await KeteSync.sync(options)
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind === "updated" && outcome.changes).toEqual({ added: [], updated: ["developer"], removed: ["code-reviewer"] })
    const loaded = await KeteSync.load(options)
    expect(loaded?.cached.response.agents.map((item) => [item.slug, item.version])).toEqual([["developer", 2]])
    expect(loaded?.cached.etag).toBe('"e2"')
  })

  test("offline, 401, 500 and bad responses keep the last copy", async () => {
    for (const failure of [
      { status: 500, body: { error: { code: "internal", message: "boom", request_id: "r" } } },
      { status: 401, body: { error: { code: "invalid_key", message: "revoked", request_id: "r" } } },
      { status: 200, etag: '"bad"', body: { agents: "nope" } },
      "offline",
    ] as const) {
      const fake = platform(failure === "offline" ? [ok('"e1"', [agent("developer")])] : [ok('"e1"', [agent("developer")]), failure])
      const options = await home(fake.url)
      await KeteSync.sync(options)
      const before = await readFile(cacheFile(options.config), "utf8")
      if (failure === "offline") fake.stop()
      const outcome = await KeteSync.sync(options)
      expect(outcome.kind).toBe("failed")
      if (outcome.kind !== "failed") continue
      expect(outcome.cached?.etag).toBe('"e1"')
      expect(outcome.error.message).not.toContain(key)
      expect(await readFile(cacheFile(options.config), "utf8")).toBe(before)
    }
  })

  test("a 401 says to sign in again", async () => {
    const fake = platform([{ status: 401, body: { error: { code: "invalid_key", message: "revoked", request_id: "r7" } } }])
    const options = await home(fake.url)
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind === "failed" && outcome.error.message).toContain("Run `kete login` again")
    expect(outcome.kind === "failed" && outcome.error.message).toContain("request r7")
  })

  test("delegable: absent decodes as before, true is kept, mode \"all\" is still rejected", async () => {
    const fake = platform([ok('"e1"', [agent("developer"), agent("security", 1, { delegable: true })])])
    const options = await home(fake.url)
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind).toBe("updated")
    const loaded = await KeteSync.load(options)
    const developer = loaded?.cached.response.agents.find((item) => item.slug === "developer")
    const security = loaded?.cached.response.agents.find((item) => item.slug === "security")
    expect(developer?.delegable).toBeUndefined()
    expect(security?.delegable).toBe(true)

    const rejecting = platform([ok('"e2"', [{ ...agent("bad"), mode: "all" }])])
    const rejectingOptions = await home(rejecting.url)
    const rejectingOutcome = await KeteSync.sync(rejectingOptions)
    expect(rejectingOutcome.kind).toBe("failed")
    expect(rejectingOutcome.kind === "failed" && rejectingOutcome.error.message).toContain("unexpected sync response")
  })

  test("a version-1 cache is used but refetched without If-None-Match; the new copy is version 2", async () => {
    const fake = platform([ok('"e2"', [agent("developer", 2)])])
    const options = await home(fake.url)
    const legacy: KeteSyncCache.Cached = {
      version: 1,
      etag: '"e1"',
      synced_at: "2026-09-25T20:00:00.000Z",
      response: {
        organization: { id: org, name: "Kete Labs" },
        generated_at: "2026-09-25T19:00:00Z",
        agents: [agent("developer", 1)] as unknown as KeteSyncCache.Cached["response"]["agents"],
      },
    }
    await KeteSyncCache.write(options.config, legacy)
    const before = await KeteSync.load(options)
    expect(before?.cached.version).toBe(1)
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind).toBe("updated")
    expect(fake.seen).toEqual([{ authorization: `Bearer ${key}`, ifNoneMatch: null }])
    const after = await KeteSync.load(options)
    expect(after?.cached.version).toBe(2)
  })
})

describe("KeteSync with a job's credential", () => {
  const jobKey = "kete_job_0123456789abcdef"

  test("syncs with the job key and no account; the cache is found again by the organization", async () => {
    const fake = platform([ok('"e1"', [agent("developer")]), { status: 304, etag: '"e1"' }])
    const options = { ...(await home()), native: undefined }
    // Neither the account file nor the key store is touched.
    const first = await KeteSync.sync({ ...options, credential: { platform: fake.url, key: jobKey } })
    expect(first.kind).toBe("updated")
    expect(fake.seen).toEqual([{ authorization: `Bearer ${jobKey}`, ifNoneMatch: null }])
    expect(await readFile(cacheFile(options.config), "utf8")).not.toContain(jobKey)

    const second = await KeteSync.sync({ ...options, credential: { platform: fake.url, key: jobKey, organization: org } })
    expect(second.kind).toBe("unchanged")
    expect(fake.seen[1]).toEqual({ authorization: `Bearer ${jobKey}`, ifNoneMatch: '"e1"' })

    expect(await KeteSync.load({ ...options, credential: { platform: fake.url, key: jobKey } })).toBeUndefined()
    const loaded = await KeteSync.load({ ...options, credential: { platform: fake.url, key: jobKey, organization: org } })
    expect(loaded?.account).toBeUndefined()
    expect(loaded?.cached.response.agents.map((item) => item.slug)).toEqual(["developer"])
  })

  test("a 401 names the job's key and gives no `kete login` advice", async () => {
    const fake = platform([{ status: 401, body: { error: { code: "invalid_key", message: "revoked", request_id: "r8" } } }])
    const options = { ...(await home()), native: undefined }
    const outcome = await KeteSync.sync({ ...options, credential: { platform: fake.url, key: jobKey } })
    expect(outcome.kind).toBe("failed")
    if (outcome.kind !== "failed") return
    expect(outcome.error.message).toContain("refused the job's key")
    expect(outcome.error.message).toContain("request r8")
    expect(outcome.error.message).not.toContain("kete login")
    expect(outcome.error.message).not.toContain(jobKey)
  })

  test("an organization other than the credential's removes the old copy", async () => {
    const other = "11111111-2222-4333-8444-555555555555"
    const fake = platform([ok('"e1"', [agent("developer")])])
    const options = { ...(await home()), native: undefined }
    await KeteSyncCache.write(options.config, {
      version: 2,
      etag: '"old"',
      synced_at: "2026-09-25T20:00:00.000Z",
      response: { organization: { id: other, name: "Old" }, generated_at: "2026-09-25T19:00:00Z", agents: [] },
    })
    await KeteSync.sync({ ...options, credential: { platform: fake.url, key: jobKey, organization: other } })
    expect(await KeteSyncCache.read(options.config, other)).toBeUndefined()
    expect((await KeteSyncCache.read(options.config, org))?.etag).toBe('"e1"')
  })
})

describe("KeteSyncCache", () => {
  test("writes atomically: no temporary files remain, and a failed write keeps the old copy", async () => {
    const fake = platform([ok('"e1"', [agent("developer")])])
    const options = await home(fake.url)
    await KeteSync.sync(options)
    const directory = path.dirname(cacheFile(options.config))
    expect(await readdir(directory)).toEqual(["agents.json"])
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const before = await readFile(cacheFile(options.config), "utf8")
    const loaded = await KeteSync.load(options)
    await chmod(directory, 0o500)
    cleanup.push(() => chmod(directory, 0o700))
    await expect(KeteSyncCache.write(options.config, { ...loaded!.cached, etag: '"e2"' })).rejects.toThrow()
    expect(await readFile(cacheFile(options.config), "utf8")).toBe(before)
  })

  test("only a GUID becomes a directory name", () => {
    for (const bad of ["../../etc", "..", "org/../x", "C:\\x", ""])
      expect(() => KeteSyncCache.directory("/config", bad)).toThrow("Invalid organization id")
  })

  test("Windows paths", () => {
    expect(KeteSyncCache.directory("C:\\Users\\me\\.config\\kete", org.toUpperCase(), path.win32.join)).toBe(
      `C:\\Users\\me\\.config\\kete\\managed\\${org}`,
    )
  })

  test("an invalid cache file is reported, not silently used", async () => {
    const options = await home()
    await Bun.write(cacheFile(options.config), "{ not json")
    await expect(KeteSyncCache.read(options.config, org)).rejects.toThrow("not a valid managed-agent cache")
  })
})
