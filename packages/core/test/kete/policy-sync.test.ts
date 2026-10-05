// Organization policies from the platform, enforced by the runtime's sync plugin, fail-closed while
// they aren't loaded, and runtime registration (docs/platform/sync-v1.md).
import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Duration, Effect, Option, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteAgentSync } from "@opencode/core/kete/sync/plugin"
import { KeteUnattended } from "@opencode/core/kete/unattended"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import type { Plugin } from "@opencode/plugin/effect"
import { Document, type Entry, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import { KeteRuntimeRegistration } from "@opencode/util/kete/runtime-registration"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"
import { permissions, registries } from "./sync-fixture"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))

const key = "kete_test_POLICYSYNC0123456789"
const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"

const policies = [
  {
    id: "5d0c7e2a-3b1f-4c8e-9a6d-2f4b1c3e5a70",
    name: "No force pushes",
    description: "",
    category: "governance",
    enforcement: "enforced",
    environment_kinds: [],
    agents: null,
    rules: [
      { action: "shell", resource: "git push --force*", effect: "deny", description: "No force push" },
      { action: "edit", resource: ".github/workflows/*", effect: "ask", description: "CI changes need approval" },
    ],
    updated_at: "2026-09-27T09:00:00.000Z",
  },
  {
    id: "8e2a4c6b-1d3f-4a5b-8c7d-9e0f1a2b3c4d",
    name: "Watch lockfiles",
    description: "",
    category: "security",
    enforcement: "audit_only",
    environment_kinds: [],
    agents: null,
    rules: [{ action: "edit", resource: "*bun.lock", effect: "ask", description: "" }],
    updated_at: "2026-09-27T09:00:00.000Z",
  },
]

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function platform(options: { down?: boolean } = {}) {
  const registrations: unknown[] = []
  const authorizations: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/v1/sync") authorizations.push(request.headers.get("authorization"))
      if (request.method === "PUT" && url.pathname.startsWith("/api/v1/runtimes/")) {
        registrations.push({ path: url.pathname, body: await request.json() })
        return Response.json({})
      }
      if (options.down) return Response.json({ error: { code: "internal", message: "down" } }, { status: 500 })
      return Response.json(
        { organization: { id: org, name: "Kete Labs" }, generated_at: "2026-09-27T10:00:00Z", agents: [], policies },
        { headers: { etag: '"p1"' } },
      )
    },
  })
  cleanup.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, registrations, authorizations }
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
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-policy-sync-"))
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

const decodeInfo = Schema.decodeUnknownSync(Info)
/** A config document setting `kete.runtime`, for the entries `Config.testLayer` returns. */
const runtimeDocument = (runtime: unknown): Entry => new Document({ type: "document", info: decodeInfo({ kete: { runtime } }) })

const start = (
  options: KeteAccount.Options,
  registration: false | { every: Duration.Input } = false,
  extra: {
    entries?: Entry[]
    environment?: Record<string, string | undefined>
    job?: { key?: () => string | undefined; organization?: () => string | undefined }
    interval?: Duration.Input
    /** Receives the test config, so a test can change `kete.offline` while the plugin runs. */
    config?: (config: Config.TestInterface) => void
  } = {},
) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const extraHost = registries()
    const permission = permissions()
    const pluginHost = host({
      permission: permission.host,
      agent: agentHost(agents),
      skill: extraHost.host.skill,
      mcp: extraHost.host.mcp,
      session: { hook: (() => Effect.void) as unknown as Plugin.Context["session"]["hook"] },
      app: { name: "kete", version: "0.2.0-test", channel: "test" },
    })
    yield* AgentPlugin.Plugin.effect(pluginHost)
    yield* Effect.gen(function* () {
      extra.config?.(yield* Config.Test)
      yield* KeteAgentSync.make({
        registration,
        interval: extra.interval ?? "1 hour",
        account: options,
        environment: extra.environment,
        job: extra.job,
      }).effect(pluginHost)
    }).pipe(Effect.provide(Config.testLayer(extra.entries ?? [])))
    return permission
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

describe("organization policies in the runtime", () => {
  it.live("enforced policies deny or ask on top of what the agent allows; audit-only ones block nothing", () =>
    Effect.gen(function* () {
      const fake = platform()
      const permission = yield* start(yield* account(fake.url))
      const force = () => permission.evaluate({ action: "shell", resources: ["git push --force origin main"], effect: "allow", agent: "build" as never })
      const denied = yield* eventually(force(), (result) => result.effect === "deny")
      expect(denied.message).toBe("Blocked by Kete Labs's policy “No force pushes” (No force push).")
      expect(yield* permission.evaluate({ action: "shell", resources: ["git status"], effect: "allow" })).toEqual({ effect: "allow", message: undefined })
      const ci = yield* permission.evaluate({ action: "edit", resources: [".github/workflows/ci.yml"], effect: "allow" })
      expect(ci.effect).toBe("ask")
      expect(ci.message).toContain("needs your approval")
      // Already asking stays asking; an agent's deny is never reached (the service decides it first).
      expect((yield* permission.evaluate({ action: "edit", resources: [".github/workflows/ci.yml"], effect: "ask" })).effect).toBe("ask")
      // Audit-only: allowed as before.
      expect((yield* permission.evaluate({ action: "edit", resources: ["bun.lock"], effect: "allow" })).effect).toBe("allow")
    }),
  )

  it.live("fails closed: signed in without the organization's policies, edits, commands and web requests ask", () =>
    Effect.gen(function* () {
      const fake = platform({ down: true })
      const permission = yield* start(yield* account(fake.url))
      const edit = yield* permission.evaluate({ action: "edit", resources: ["src/a.ts"], effect: "allow" })
      expect(edit.effect).toBe("ask")
      expect(edit.message).toContain("hasn't loaded Kete Labs's policies yet")
      expect((yield* permission.evaluate({ action: "shell", resources: ["ls"], effect: "allow" })).effect).toBe("ask")
      expect((yield* permission.evaluate({ action: "webfetch", resources: ["https://x"], effect: "allow" })).effect).toBe("ask")
      // Reading isn't held back, and nothing is loosened.
      expect((yield* permission.evaluate({ action: "read", resources: ["src/a.ts"], effect: "allow" })).effect).toBe("allow")
      expect((yield* permission.evaluate({ action: "edit", resources: ["src/a.ts"], effect: "deny" })).effect).toBe("deny")
    }),
  )

  it.live("not signed in: policies play no part", () =>
    Effect.gen(function* () {
      const permission = yield* start(yield* account(undefined))
      expect((yield* permission.evaluate({ action: "edit", resources: ["src/a.ts"], effect: "allow" })).effect).toBe("allow")
    }),
  )

  it.live("registers the runtime installation with its version, once while nothing changes", () =>
    Effect.gen(function* () {
      const fake = platform()
      yield* start(yield* account(fake.url), { every: "1 hour" })
      yield* eventually(Effect.sync(() => fake.registrations.length), (count) => count === 1)
      expect(fake.registrations[0]).toMatchObject({ body: { runtime_type: "local", version: "0.2.0-test", device_name: "test" } })
    }),
  )

  it.live("registers the type set by kete.runtime.type in the config", () =>
    Effect.gen(function* () {
      const fake = platform()
      yield* start(yield* account(fake.url), { every: "1 hour" }, { entries: [runtimeDocument({ type: "kete_cloud" })] })
      yield* eventually(Effect.sync(() => fake.registrations.length), (count) => count === 1)
      expect(fake.registrations[0]).toMatchObject({ body: { runtime_type: "kete_cloud" } })
    }),
  )

  it.live("registers the type from KETE_RUNTIME_TYPE when the config doesn't set one", () =>
    Effect.gen(function* () {
      const fake = platform()
      yield* start(yield* account(fake.url), { every: "1 hour" }, { environment: { OPENCODE_RUNTIME_TYPE: "enterprise_private" } })
      yield* eventually(Effect.sync(() => fake.registrations.length), (count) => count === 1)
      expect(fake.registrations[0]).toMatchObject({ body: { runtime_type: "enterprise_private" } })
    }),
  )

  it.live("the configured type wins over KETE_RUNTIME_TYPE", () =>
    Effect.gen(function* () {
      const fake = platform()
      yield* start(
        yield* account(fake.url),
        { every: "1 hour" },
        { entries: [runtimeDocument({ type: "kete_cloud" })], environment: { OPENCODE_RUNTIME_TYPE: "enterprise_private" } },
      )
      yield* eventually(Effect.sync(() => fake.registrations.length), (count) => count === 1)
      expect(fake.registrations[0]).toMatchObject({ body: { runtime_type: "kete_cloud" } })
    }),
  )

  it.live("an unknown KETE_RUNTIME_TYPE registers nothing", () =>
    Effect.gen(function* () {
      const fake = platform()
      yield* start(yield* account(fake.url), { every: "1 hour" }, { environment: { OPENCODE_RUNTIME_TYPE: "moon_base" } })
      // Give the registration tick a chance to run; it never reaches the platform.
      yield* Effect.promise(() => Bun.sleep(200))
      expect(fake.registrations).toEqual([])
    }),
  )

  // AC6: job mode never registers, even signed in with an account due to register.
  it.live("job mode (KETE_JOB_MODE) registers nothing", () =>
    Effect.gen(function* () {
      const fake = platform()
      yield* start(yield* account(fake.url), { every: "1 hour" }, { environment: { OPENCODE_JOB_MODE: "1" } })
      yield* Effect.promise(() => Bun.sleep(200))
      expect(fake.registrations).toEqual([])
    }),
  )
})

// Offline mode (--offline / KETE_OFFLINE / kete.offline): no sync or registration request, but the
// copy synced earlier is loaded at startup and its policies are enforced exactly as online.
describe("organization policies in offline mode", () => {
  it.live("offline (environment): sends no sync or registration request, and the cached deny policy still applies", () =>
    Effect.gen(function* () {
      const fake = platform()
      const options = yield* account(fake.url)
      // Online first: this sync writes the cache.
      const online = yield* start(options)
      yield* eventually(
        online.evaluate({ action: "shell", resources: ["git push --force origin main"], effect: "allow", agent: "build" as never }),
        (result) => result.effect === "deny",
      )
      const syncs = fake.authorizations.length
      expect(syncs).toBeGreaterThan(0)

      const offline = yield* start(options, { every: "1 hour" }, { environment: { OPENCODE_OFFLINE: "1" } })
      yield* Effect.promise(() => Bun.sleep(200))
      expect(fake.authorizations.length).toBe(syncs)
      expect(fake.registrations).toEqual([])
      // The cached policies apply at once, with no sync to load them.
      const denied = yield* offline.evaluate({
        action: "shell",
        resources: ["git push --force origin main"],
        effect: "allow",
        agent: "build" as never,
      })
      expect(denied.effect).toBe("deny")
      expect(denied.message).toBe("Blocked by Kete Labs's policy “No force pushes” (No force push).")
      // Offline never loosens anything.
      expect((yield* offline.evaluate({ action: "edit", resources: ["src/a.ts"], effect: "deny" })).effect).toBe("deny")
    }),
  )

  it.live("offline (config kete.offline): sends no sync or registration request", () =>
    Effect.gen(function* () {
      const fake = platform()
      const options = yield* account(fake.url)
      const offlineConfig = new Document({ type: "document", info: decodeInfo({ kete: { offline: true } }) })
      yield* start(options, { every: "1 hour" }, { entries: [offlineConfig] })
      yield* Effect.promise(() => Bun.sleep(200))
      expect(fake.authorizations).toEqual([])
      expect(fake.registrations).toEqual([])
    }),
  )

  it.live("kete.offline turned on in config while running pauses sync from the next tick; turned off resumes it", () =>
    Effect.gen(function* () {
      const fake = platform()
      const options = yield* account(fake.url)
      const handle: { config?: Config.TestInterface } = {}
      yield* start(options, false, { interval: "40 millis", config: (config) => void (handle.config = config) })
      yield* eventually(Effect.sync(() => fake.authorizations.length), (count) => count >= 2)
      const offlineConfig = new Document({ type: "document", info: decodeInfo({ kete: { offline: true } }) })
      yield* handle.config!.setEntries([offlineConfig])
      // Let a tick that was already in flight finish, then nothing more is sent.
      yield* Effect.promise(() => Bun.sleep(120))
      const paused = fake.authorizations.length
      yield* Effect.promise(() => Bun.sleep(300))
      expect(fake.authorizations.length).toBe(paused)
      yield* handle.config!.setEntries([])
      yield* eventually(Effect.sync(() => fake.authorizations.length), (count) => count > paused)
    }),
  )

  it.live("runtime registration re-checks kete.offline on every tick", () =>
    Effect.gen(function* () {
      const fake = platform()
      const options = yield* account(fake.url)
      const handle: { config?: Config.TestInterface } = {}
      const offlineConfig = new Document({ type: "document", info: decodeInfo({ kete: { offline: true } }) })
      yield* start(options, { every: "40 millis" }, {
        entries: [offlineConfig],
        config: (config) => void (handle.config = config),
      })
      yield* Effect.promise(() => Bun.sleep(200))
      expect(fake.registrations).toEqual([])
      // Offline turned off in config: the next tick registers, with no restart.
      yield* handle.config!.setEntries([])
      yield* eventually(Effect.sync(() => fake.registrations.length), (count) => count > 0)
    }),
  )
})

// Job mode piece A2: the job's gateway key replaces the account; no policies means the guard holds.
describe("organization policies in job mode", () => {
  const jobKey = "kete_job_POLICYSYNC0123456789"
  const jobEnvironment = (url: string | undefined) => ({ OPENCODE_JOB_MODE: "1", OPENCODE_PLATFORM_URL: url })

  it.live("syncs with the job's key, never the account's, and enforces the policies", () =>
    Effect.gen(function* () {
      const jobPlatform = platform()
      const accountPlatform = platform()
      const permission = yield* start(
        yield* account(accountPlatform.url),
        false,
        { environment: jobEnvironment(jobPlatform.url), job: { key: () => jobKey, organization: () => undefined } },
      )
      const force = () =>
        permission.evaluate({ action: "shell", resources: ["git push --force origin main"], effect: "allow", agent: "build" as never })
      yield* eventually(force(), (result) => result.effect === "deny")
      expect(jobPlatform.authorizations[0]).toBe(`Bearer ${jobKey}`)
      expect(accountPlatform.authorizations).toEqual([])
    }),
  )

  it.live("fails closed without the policies: edit, shell and web ask, and unattended mode denies them", () =>
    Effect.gen(function* () {
      const jobPlatform = platform({ down: true })
      const permission = yield* start(
        yield* account(undefined),
        false,
        { environment: jobEnvironment(jobPlatform.url), job: { key: () => jobKey, organization: () => undefined } },
      )
      const unattended = Effect.fnUntraced(function* (action: string, resource: string) {
        const result = yield* permission.evaluate({ action, resources: [resource], effect: "allow" })
        const event = { sessionID: "ses_job", action, resources: [resource], effect: result.effect, message: result.message }
        const get = () => Effect.succeed(Option.some({ id: "ses_job", metadata: { "kete.unattended": { version: 1 } } } as never))
        yield* KeteUnattended.applyLate(get as never, event as never, { globalConfig: "/global-config" })
        return { asked: result, final: event.effect }
      })
      for (const [action, resource] of [["edit", "src/a.ts"], ["shell", "ls"], ["webfetch", "https://x"]] as const) {
        const outcome = yield* unattended(action, resource)
        expect(outcome.asked.effect).toBe("ask")
        expect(outcome.asked.message).toContain("hasn't loaded the job's organization's policies")
        expect(outcome.asked.message).not.toContain("kete sync")
        expect(outcome.final).toBe("deny")
      }
      expect((yield* unattended("read", "src/a.ts")).final).toBe("allow")
    }),
  )

  it.live("without a platform URL or key nothing is fetched and the guard still holds", () =>
    Effect.gen(function* () {
      const accountPlatform = platform()
      const permission = yield* start(yield* account(accountPlatform.url), false, {
        environment: jobEnvironment(undefined),
        job: { key: () => undefined, organization: () => undefined },
      })
      yield* Effect.promise(() => Bun.sleep(100))
      expect((yield* permission.evaluate({ action: "edit", resources: ["src/a.ts"], effect: "allow" })).effect).toBe("ask")
      expect(accountPlatform.authorizations).toEqual([])
    }),
  )
})

describe("resolveRuntimeType and the schema agree on the runtime type literals", () => {
  it.live("packages/schema/src/config/kete.ts ConfigKete.Runtime.type accepts every KeteRuntimeRegistration.runtimeTypes value, and nothing else", () =>
    Effect.gen(function* () {
      for (const type of KeteRuntimeRegistration.runtimeTypes)
        expect(() => decodeInfo({ kete: { runtime: { type } } })).not.toThrow()
      expect(() => decodeInfo({ kete: { runtime: { type: "moon_base" } } })).toThrow()
    }),
  )
})
