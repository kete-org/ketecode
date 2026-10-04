import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteAccount } from "@opencode/util/kete/account"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { AccountFlow } from "../../src/kete/account-flow"

const key = "kete_test_CLISYNC0123456789ab"
const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"

const agent = (slug: string, version = 1) => ({
  id: slug === "developer" ? "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01" : "7b2d9e4a-1c3f-4a5b-8d6e-0f1a2b3c4d5e",
  slug,
  version,
  name: slug,
  description: "",
  mode: "primary",
  model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
  instructions: "",
  tools: { edit: false, shell: false, web: false, skills: [], subagents: [], mcp: {} },
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
  budget: { monthly_micros: null, spent_micros: 0, period: "2026-09" },
})

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function platform(sync: Array<{ status: number; etag?: string; agents?: unknown[] }>) {
  const state = { challenge: "", syncs: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/v1/cli/token") {
        const body = (await request.json()) as { code_verifier: string }
        if (createHash("sha256").update(body.code_verifier).digest("base64url") !== state.challenge)
          return Response.json({ error: { code: "invalid_request", message: "PKCE", request_id: "r" } }, { status: 400 })
        return Response.json({
          api_key: key,
          key_id: "3f1c2b7e-0000-4000-8000-000000000009",
          organization: { id: org, name: "Kete Labs" },
          gateway_url: "https://gateway.example",
        })
      }
      if (url.pathname === "/api/v1/cli/logout") return new Response(null, { status: 204 })
      if (url.pathname === "/api/v1/sync") {
        const reply = sync[Math.min(state.syncs++, sync.length - 1)]!
        if (reply.status === 304) return new Response(null, { status: 304, headers: { etag: reply.etag ?? "" } })
        if (reply.status !== 200)
          return Response.json({ error: { code: "internal", message: "boom", request_id: "r9" } }, { status: reply.status })
        return Response.json(
          { organization: { id: org, name: "Kete Labs" }, generated_at: "2026-09-25T20:15:00Z", agents: reply.agents ?? [] },
          { headers: { etag: reply.etag ?? '"e"' } },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, state }
}

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

async function io(platformURL?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-cli-sync-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const output: string[] = []
  const reloads = { count: 0 }
  const account = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
  if (platformURL)
    await KeteAccount.save(
      account,
      {
        platform_url: platformURL,
        gateway_url: "https://gateway.example",
        organization: { id: org, name: "Kete Labs" },
        key_id: "3f1c2b7e-0000-4000-8000-000000000001",
        device_name: "test",
      },
      key,
    )
  const value = {
    print: (line: string) => void output.push(line),
    warn: (line: string) => void output.push(`Warning: ${line}`),
    account,
    environment: {},
    reload: async () => {
      reloads.count++
      return true
    },
  } satisfies AccountFlow.IO
  return { io: value, output, reloads }
}

const exists = (file: string) => stat(file).then(() => true, () => false)

describe("kete sync", () => {
  test("reports what changed, then up to date, and reloads the service only on a change", async () => {
    const fake = platform([
      { status: 200, etag: '"e1"', agents: [agent("developer"), agent("qa")] },
      { status: 304, etag: '"e1"' },
      { status: 200, etag: '"e2"', agents: [agent("developer", 2)] },
    ])
    const session = await io(fake.url)
    await AccountFlow.sync(session.io)
    await AccountFlow.sync(session.io)
    await AccountFlow.sync(session.io)
    expect(session.output).toEqual([
      "Synced 2 agents from Kete Labs: added developer, qa.",
      "The background service picked up the change.",
      "Managed agents are up to date: 2 agents from Kete Labs.",
      "Synced 1 agent from Kete Labs: updated developer; removed qa.",
      "The background service picked up the change.",
    ])
    expect(session.reloads.count).toBe(2)
    expect(session.output.join("\n")).not.toContain(key)
  })

  test("a failure says so, keeps the last copy, and names it", async () => {
    const fake = platform([{ status: 200, etag: '"e1"', agents: [agent("developer")] }, { status: 500 }])
    const session = await io(fake.url)
    await AccountFlow.sync(session.io)
    const error = await AccountFlow.sync(session.io).catch((error: unknown) => error)
    expect((error as Error).message).toContain("Could not sync managed agents: The platform is unavailable")
    expect((error as Error).message).toContain("Still using the last copy (1 agent")
    expect(await exists(KeteSyncCache.file(session.io.account.config, org))).toBe(true)
  })

  test("not signed in: nothing to do", async () => {
    const session = await io()
    expect((await AccountFlow.sync(session.io)).kind).toBe("signed-out")
    expect(session.output[0]).toContain("Not signed in")
  })
})

describe("kete login and logout", () => {
  test("login syncs the organization's agents; logout removes them", async () => {
    const fake = platform([{ status: 200, etag: '"e1"', agents: [agent("developer")] }])
    const session = await io()
    await AccountFlow.login(session.io, {
      platformURL: fake.url,
      ssh: false,
      open: async (url) => {
        const parsed = new URL(url)
        fake.state.challenge = parsed.searchParams.get("code_challenge") ?? ""
        setTimeout(
          () =>
            void fetch(
              `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=c&state=${parsed.searchParams.get("state")}`,
            ),
          10,
        )
      },
    })
    expect(session.output).toContain("Synced 1 agent managed by Kete Labs.")
    const cache = KeteSyncCache.file(session.io.account.config, org)
    expect(await exists(cache)).toBe(true)

    await AccountFlow.logout(session.io)
    expect(await exists(cache)).toBe(false)
    expect(await exists(path.dirname(cache))).toBe(false)
  })
})

test("a failure message ends with exactly one full stop", async () => {
  const fake = platform([{ status: 401 }])
  const session = await io(fake.url)
  const error = await AccountFlow.sync(session.io).catch((error: unknown) => error)
  expect((error as Error).message).not.toMatch(/\.\.$/)
  expect((error as Error).message).toMatch(/[^.]\.$/)
})
