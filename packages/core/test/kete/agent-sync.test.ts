import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Duration, Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteAgentSync } from "@opencode/core/kete/sync/plugin"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import type { Plugin } from "@opencode/plugin/effect"
import type { SessionModelRequest } from "@opencode/plugin/effect/session"
import { Document, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { KeteSync } from "@opencode/util/kete/sync/sync"
import { testEffect } from "../lib/effect"
import { permissions, registries } from "./sync-fixture"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))
const decode = Schema.decodeUnknownSync(Info)

const key = "kete_test_AGENTSYNC0123456789"
const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"

const managed = (slug: string, overrides: Record<string, unknown> = {}) => ({
  id: slug === "developer" ? "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01" : "7b2d9e4a-1c3f-4a5b-8d6e-0f1a2b3c4d5e",
  slug,
  version: 4,
  name: slug === "developer" ? "Developer" : "Code Reviewer",
  description: `The ${slug}.`,
  mode: slug === "developer" ? "primary" : "subagent",
  model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
  instructions: `You are the ${slug} agent.`,
  tools: { edit: true, shell: true, web: false, skills: [], subagents: [], mcp: {} },
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "git status*", effect: "allow" },
  ],
  budget: { monthly_micros: null, spent_micros: 0, period: "2026-09" },
  ...overrides,
})

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function platform(replies: Array<{ status: number; etag?: string; agents?: unknown[] }>) {
  const seen: Array<string | null> = []
  const authorizations: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push(request.headers.get("if-none-match"))
      authorizations.push(request.headers.get("authorization"))
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!
      if (reply.status === 304) return new Response(null, { status: 304, headers: { etag: reply.etag ?? "" } })
      if (reply.status !== 200)
        return Response.json({ error: { code: "internal", message: "boom", request_id: "r" } }, { status: reply.status })
      return Response.json(
        { organization: { id: org, name: "Kete Labs" }, generated_at: "2026-09-25T20:15:00Z", agents: reply.agents ?? [] },
        { headers: { etag: reply.etag ?? '"e"' } },
      )
    },
  })
  cleanup.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, seen, authorizations, stop: () => server.stop(true) }
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

const account = (platformURL: string | undefined) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-agent-sync-"))
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
  })

// A local agent with the same slug as a managed one, a local-only agent, and a global rule.
const localConfig = [
  new Document({
    type: "document",
    info: decode({
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      agents: {
        developer: { description: "My local developer", system: "local prompt", color: "#112233" },
        mine: { description: "Only local" },
      },
    }),
  }),
]

type ModelRequest = SessionModelRequest

/** Built-in agents, config agents, then managed ones: the runtime's registration order. */
const start = (
  options: KeteAccount.Options,
  interval: Duration.Input = "1 hour",
  job: Pick<Parameters<typeof KeteAgentSync.make>[0] & {}, "environment" | "job"> = {},
) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const hooks: Array<(evt: ModelRequest) => Effect.Effect<void, unknown>> = []
    const extra = registries()
    const pluginHost = host({
      permission: permissions().host,
      agent: agentHost(agents),
      skill: extra.host.skill,
      mcp: extra.host.mcp,
      session: {
        // A stand-in that only records model.request hooks, so the test can call them directly.
        hook: ((name: string, callback: (evt: ModelRequest) => Effect.Effect<void, unknown>) => {
          if (name === "model.request") hooks.push(callback)
          return Effect.void
        }) as unknown as Plugin.Context["session"]["hook"],
      },
    })
    yield* AgentPlugin.Plugin.effect(pluginHost)
    yield* ConfigAgentPlugin.Plugin.effect(pluginHost).pipe(Effect.provide(Config.testLayer(localConfig)))
    yield* KeteAgentSync.make({ registration: false, interval, account: options, ...job }).effect(pluginHost).pipe(
      Effect.provide(Config.testLayer(localConfig)),
    )
    return { agents, hooks }
  })

const eventually = <A>(effect: Effect.Effect<A>, ready: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = yield* effect
      if (ready(value)) return value
      yield* Effect.promise(() => Bun.sleep(10))
    }
    return yield* Effect.die(new Error("timed out"))
  })

describe("KeteAgentSync", () => {
  it.live("not signed in: agents are exactly as today, and nothing is requested", () =>
    Effect.gen(function* () {
      const fake = platform([{ status: 200, agents: [managed("developer")] }])
      const options = yield* account(undefined)
      const { agents } = yield* start(options)
      yield* Effect.promise(() => Bun.sleep(100))
      const developer = yield* agents.get(Agent.ID.make("developer"))
      expect(developer?.description).toBe("My local developer")
      expect(developer?.system).toBe("local prompt")
      expect(fake.seen).toEqual([])
    }),
  )

  it.live("a managed agent replaces a local one with the same slug, with the organization's rules last", () =>
    Effect.gen(function* () {
      const fake = platform([{ status: 200, etag: '"e1"', agents: [managed("developer"), managed("code-reviewer")] }])
      const options = yield* account(fake.url)
      const { agents } = yield* start(options)
      const developer = yield* eventually(agents.get(Agent.ID.make("developer")), (agent) =>
        agent?.description?.includes("Managed by") ?? false,
      )
      expect(developer).toMatchObject({
        name: "Developer",
        description: "The developer. · Managed by Kete Labs",
        system: "You are the developer agent.",
        mode: "primary",
        model: { id: "claude-sonnet-4-5", providerID: "kete" },
      })
      // Nothing of the local definition survives.
      expect(developer?.color).toBeUndefined()
      // The local global rule allows edit, but the managed rules come later and deny it.
      expect(Permission.evaluate("edit", "src/app.ts", developer!.permissions).effect).toBe("deny")
      expect(Permission.evaluate("shell", "git status", developer!.permissions).effect).toBe("allow")
      expect(Permission.evaluate("shell", "rm -rf build", developer!.permissions).effect).toBe("deny")
      expect(developer!.permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" })
      expect(developer!.permissions.at(-1)).toEqual({ action: "shell", resource: "git status*", effect: "allow" })
      // Subagents keep their mode; local-only agents are untouched.
      expect((yield* agents.get(Agent.ID.make("code-reviewer")))?.mode).toBe("subagent")
      expect((yield* agents.get(Agent.ID.make("mine")))?.description).toBe("Only local")
      // The cache is on disk for the next start.
      const cached = JSON.parse(yield* Effect.promise(() => readFile(KeteSyncCache.file(options.config, org), "utf8")))
      expect(cached.etag).toBe('"e1"')
    }),
  )

  it.live("a delegable managed agent becomes mode \"all\"; without it stays primary; a subagent is unchanged", () =>
    Effect.gen(function* () {
      const fake = platform([
        {
          status: 200,
          etag: '"e1"',
          agents: [
            managed("developer"),
            managed("code-reviewer"),
            managed("security", {
              id: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
              mode: "primary",
              delegable: true,
            }),
          ],
        },
      ])
      const options = yield* account(fake.url)
      const { agents } = yield* start(options)
      const security = yield* eventually(agents.get(Agent.ID.make("security")), (agent) => agent !== undefined)
      expect(security?.mode).toBe("all")
      const developer = yield* agents.get(Agent.ID.make("developer"))
      expect(developer?.mode).toBe("primary")
      const reviewer = yield* agents.get(Agent.ID.make("code-reviewer"))
      expect(reviewer?.mode).toBe("subagent")
    }),
  )

  it.live("model calls by a managed agent through the gateway carry its id and version", () =>
    Effect.gen(function* () {
      const fake = platform([{ status: 200, agents: [managed("developer")] }])
      const options = yield* account(fake.url)
      const { agents, hooks } = yield* start(options)
      yield* eventually(agents.get(Agent.ID.make("developer")), (agent) => agent?.model?.providerID === "kete")
      const call = (agent: string, providerID: string) => {
        const evt = {
          agent,
          model: { id: "claude-sonnet-4-5", providerID },
          headers: {} as Record<string, string>,
        } as unknown as ModelRequest
        return Effect.forEach(hooks, (hook) => hook(evt)).pipe(Effect.as(evt.headers))
      }
      expect(yield* call("developer", "kete")).toEqual({
        [KeteAgentSync.agentIDHeader]: "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
        [KeteAgentSync.agentVersionHeader]: "4",
      })
      expect(yield* call("developer", "anthropic")).toEqual({})
      expect(yield* call("mine", "kete")).toEqual({})
    }),
  )

  it.live("offline at startup: the last cached copy is used and kept", () =>
    Effect.gen(function* () {
      const fake = platform([{ status: 200, etag: '"e1"', agents: [managed("developer")] }])
      const options = yield* account(fake.url)
      // A first run caches the agents; then the platform goes away.
      const first = yield* start(options)
      yield* eventually(first.agents.get(Agent.ID.make("developer")), (agent) => agent?.model?.providerID === "kete")
      fake.stop()
      const before = yield* Effect.promise(() => readFile(KeteSyncCache.file(options.config, org), "utf8"))

      const second = yield* start(options)
      const developer = yield* second.agents.get(Agent.ID.make("developer"))
      expect(developer?.description).toBe("The developer. · Managed by Kete Labs")
      yield* Effect.promise(() => Bun.sleep(200))
      expect(yield* Effect.promise(() => readFile(KeteSyncCache.file(options.config, org), "utf8"))).toBe(before)
    }),
  )

  it.live("a platform error keeps the cache; an agent the platform drops disappears", () =>
    Effect.gen(function* () {
      const fake = platform([
        { status: 200, etag: '"e1"', agents: [managed("developer"), managed("code-reviewer")] },
        { status: 500 },
        { status: 200, etag: '"e2"', agents: [managed("developer", { version: 5 })] },
      ])
      const options = yield* account(fake.url)
      // One runtime, syncing every 50 ms: 200 (both agents), then 500, then 200 without code-reviewer.
      const { agents } = yield* start(options, "50 millis")
      yield* eventually(agents.get(Agent.ID.make("code-reviewer")), (agent) => agent?.mode === "subagent")
      yield* eventually(Effect.sync(() => fake.seen.length), (count) => count >= 2)
      // After the 500: still both agents, and the next request carries the cached ETag.
      expect((yield* agents.get(Agent.ID.make("code-reviewer")))?.mode).toBe("subagent")
      expect(fake.seen[1]).toBe('"e1"')
      const reviewer = yield* eventually(agents.get(Agent.ID.make("code-reviewer")), (agent) => agent === undefined)
      expect(reviewer).toBeUndefined()
      expect((yield* agents.get(Agent.ID.make("developer")))?.description).toContain("Managed by Kete Labs")
  }),
  )
})

// Job mode piece A2: the cache is the one `kete job run`'s first sync wrote with the job's key; the
// plugin loads it by the organization id and never reads the account.
describe("KeteAgentSync in job mode", () => {
  const jobKey = "kete_job_AGENTSYNC0123456789"

  it.live("serves the first sync's agent, tags its model calls, and syncs with the job's key only", () =>
    Effect.gen(function* () {
      const jobPlatform = platform([{ status: 200, etag: '"j1"', agents: [managed("developer")] }, { status: 304, etag: '"j1"' }])
      const accountPlatform = platform([{ status: 200, etag: '"a1"', agents: [managed("code-reviewer")] }])
      // An account pointing at the *other* platform exists: job mode must not use it.
      const options = yield* account(accountPlatform.url)
      const first = yield* Effect.promise(() =>
        KeteSync.sync({ ...options, native: undefined, credential: { platform: jobPlatform.url, key: jobKey } }),
      )
      expect(first.kind).toBe("updated")
      // `make` loads the cache inline: no wait for a sync.
      const { agents, hooks } = yield* start(options, "1 hour", {
        environment: { OPENCODE_JOB_MODE: "1", OPENCODE_PLATFORM_URL: jobPlatform.url },
        job: { key: () => jobKey, organization: () => org },
      })
      const developer = yield* agents.get(Agent.ID.make("developer"))
      expect(developer).toMatchObject({
        description: "The developer. · Managed by Kete Labs",
        model: { id: "claude-sonnet-4-5", providerID: "kete" },
      })
      const evt = {
        agent: "developer",
        model: { id: "claude-sonnet-4-5", providerID: "kete" },
        headers: {} as Record<string, string>,
      } as unknown as ModelRequest
      yield* Effect.forEach(hooks, (hook) => hook(evt))
      expect(evt.headers).toEqual({
        [KeteAgentSync.agentIDHeader]: "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
        [KeteAgentSync.agentVersionHeader]: "4",
      })
      // The startup sync is a conditional request with the job's key; the account's platform is never called.
      yield* eventually(Effect.sync(() => jobPlatform.seen.length), (count) => count >= 2)
      expect(jobPlatform.seen[1]).toBe('"j1"')
      expect(jobPlatform.authorizations).toEqual([`Bearer ${jobKey}`, `Bearer ${jobKey}`])
      expect(accountPlatform.seen).toEqual([])
    }),
  )
})
