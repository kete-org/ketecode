import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { AIError } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteAgentSync } from "@opencode/core/kete/sync/plugin"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { isRetryable } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import type { Plugin } from "@opencode/plugin/effect"
import type { SessionHttpResponse, SessionModelRequest, SessionRetry } from "@opencode/plugin/effect/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { testEffect } from "../lib/effect"
import { permissions, registries } from "./sync-fixture"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const developer = {
  id: "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
  slug: "developer",
  version: 4,
  name: "Developer",
  description: "",
  mode: "primary",
  model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
  instructions: "",
  tools: { edit: true, shell: true, web: false, skills: [], subagents: [], mcp: {} },
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  budget: { monthly_micros: 100_000_000, spent_micros: 100_000_000, period: "2026-09" },
}

const BUDGET_MESSAGE =
  "Agent budget reached: “Developer” has used its monthly budget. Ask an admin in your organization to raise it in the Kete Code portal."

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

/** The platform's sync endpoint; `agents()` decides what each sync returns. */
function platform(agents: () => unknown[]) {
  const state = { syncs: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      state.syncs++
      return Response.json(
        { organization: { id: org, name: "Kete Labs" }, generated_at: "2026-09-25T20:15:00Z", agents: agents() },
        { headers: { etag: `"e${state.syncs}"` } },
      )
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

const signedIn = (platformURL: string) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-agent-errors-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
    await KeteAccount.save(
      options,
      {
        platform_url: platformURL,
        gateway_url: "https://gateway.example",
        organization: { id: org, name: "Kete Labs" },
        key_id: "3f1c2b7e-0000-4000-8000-000000000001",
        device_name: "test",
      },
      "kete_test_AGENTERRORS0123456789",
    )
    return options
  })

type Registered = { name: string; callback: (evt: never) => Effect.Effect<void, unknown>; providerID?: string }

/** Starts the plugin with a session stand-in that records every hook and its provider scope. */
const start = (options: KeteAccount.Options) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const hooks: Registered[] = []
    const extra = registries()
    const pluginHost = host({
      permission: permissions().host,
      agent: agentHost(agents),
      skill: extra.host.skill,
      mcp: extra.host.mcp,
      session: {
        hook: ((name: string, callback: Registered["callback"], scope?: { providerID?: string }) => {
          hooks.push({ name, callback, providerID: scope?.providerID })
          return Effect.void
        }) as unknown as Plugin.Context["session"]["hook"],
      },
    })
    yield* AgentPlugin.Plugin.effect(pluginHost)
    yield* KeteAgentSync.make({ registration: false, interval: "1 hour", account: options }).effect(pluginHost).pipe(
      Effect.provide(Config.testLayer([])),
    )
    const run = <E extends object>(name: string, evt: E) =>
      Effect.forEach(
        hooks.filter((hook) => hook.name === name),
        (hook) => (hook.callback as (evt: E) => Effect.Effect<void, unknown>)(evt),
      ).pipe(Effect.as(evt))
    return { agents, hooks, run }
  })

const eventually = <A>(effect: Effect.Effect<A>, ready: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* effect
      if (ready(value)) return value
      yield* Effect.promise(() => Bun.sleep(10))
    }
    return yield* Effect.die(new Error("timed out"))
  })

const gatewayError = (status: number, code: string, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-kete-error-code": code, "x-kete-request-id": "req-1" },
  })

const responseEvent = (response: Response, providerID = "kete", agent = "developer") =>
  ({
    sessionID: "ses_1",
    agent,
    model: { id: "claude-sonnet-4-5", providerID },
    kind: "primary",
    request: new Request("https://gateway.example/anthropic/v1/messages", { method: "POST" }),
    response,
  }) as unknown as SessionHttpResponse

/** What the runtime makes of a response: the real HTTP executor, retry rule and session error. */
const surface = (response: Response) =>
  Effect.gen(function* () {
    const body = yield* Effect.promise(() => response.text())
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(body, { status: response.status, headers: response.headers }),
    })
    cleanup.push(() => server.stop(true))
    const executor = yield* RequestExecutor.Service
    const error = yield* executor
      .execute(HttpClientRequest.post(`http://127.0.0.1:${server.port}/v1/messages`))
      .pipe(Effect.flip)
    if (!(error instanceof AIError)) throw new Error("expected an AIError")
    return { error, session: toSessionError(error) }
  }).pipe(Effect.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))))

describe("gateway agent errors", () => {
  it.live("the hooks are scoped to the Kete gateway provider", () =>
    Effect.gen(function* () {
      const fake = platform(() => [developer])
      const { hooks } = yield* start(yield* signedIn(fake.url))
      expect(hooks.map((hook) => [hook.name, hook.providerID])).toEqual([
        ["model.request", "kete"],
        ["http.response", "kete"],
        ["retry", "kete"],
      ])
    }),
  )

  it.live("model requests carry the agent headers only for a managed agent on the gateway", () =>
    Effect.gen(function* () {
      const fake = platform(() => [developer])
      const { agents, run } = yield* start(yield* signedIn(fake.url))
      yield* eventually(agents.get(Agent.ID.make("developer")), (agent) => agent?.model?.providerID === "kete")
      const headers = (agent: string, providerID: string) =>
        run("model.request", {
          sessionID: "ses_1",
          agent,
          model: { id: "claude-sonnet-4-5", providerID },
          kind: "primary",
          headers: {} as Record<string, string>,
        } as unknown as SessionModelRequest).pipe(Effect.map((evt) => evt.headers))
      expect(yield* headers("developer", "kete")).toEqual({
        "x-kete-agent-id": developer.id,
        "x-kete-agent-version": "4",
      })
      // Own keys, local models, and a provider hand-pointed at the gateway: never.
      for (const providerID of ["anthropic", "ollama", "openai-compatible"])
        expect(yield* headers("developer", providerID)).toEqual({})
      // An agent that isn't managed: never.
      expect(yield* headers("build", "kete")).toEqual({})
    }),
  )

  it.live("a budget error reaches the user as a clear message and is not retried", () =>
    Effect.gen(function* () {
      const fake = platform(() => [developer])
      const { agents, run } = yield* start(yield* signedIn(fake.url))
      yield* eventually(agents.get(Agent.ID.make("developer")), (agent) => agent?.model?.providerID === "kete")

      // The same error in each provider format the gateway speaks.
      const formats = {
        anthropic: {
          type: "error",
          error: { type: "billing_error", code: "kete_agent_budget_exceeded", message: "gateway text" },
        },
        openai: { error: { type: "insufficient_quota", code: "kete_agent_budget_exceeded", message: "gateway text" } },
        gemini: {
          error: {
            code: 402,
            status: "RESOURCE_EXHAUSTED",
            message: "gateway text",
            details: [{ reason: "KETE_AGENT_BUDGET_EXCEEDED", domain: "kete.dev" }],
          },
        },
      }
      for (const [format, body] of Object.entries(formats)) {
        const evt = yield* run("http.response", responseEvent(gatewayError(402, "kete_agent_budget_exceeded", body)))
        expect(evt.response.status).toBe(402)
        expect(evt.response.headers.get("x-should-retry")).toBe("false")
        const surfaced = yield* surface(evt.response)
        expect(surfaced.error.message, format).toBe(BUDGET_MESSAGE)
        expect(surfaced.session.message, format).toBe(BUDGET_MESSAGE)
        expect(surfaced.error.reason._tag).toBe("QuotaExceeded")
        expect(isRetryable(surfaced.error)).toBe(false)
      }

      // The retry hook vetoes a retry even if something upstream wanted one.
      yield* run("http.response", responseEvent(gatewayError(402, "kete_agent_budget_exceeded", formats.openai)))
      const retry = yield* run("retry", {
        sessionID: "ses_1",
        agent: "developer",
        model: { id: "claude-sonnet-4-5", providerID: "kete" },
        attempt: 2,
        decision: { retry: true, delay: 1000 },
      } as unknown as SessionRetry)
      expect(retry.decision).toEqual({ retry: false })
      expect(fake.state.syncs).toBe(1)
    }),
  )

  it.live("a paused agent triggers one sync, after which it is gone", () =>
    Effect.gen(function* () {
      const state = { paused: false }
      const fake = platform(() => (state.paused ? [] : [developer]))
      const { agents, run } = yield* start(yield* signedIn(fake.url))
      yield* eventually(agents.get(Agent.ID.make("developer")), (agent) => agent?.model?.providerID === "kete")
      expect(fake.state.syncs).toBe(1)

      state.paused = true
      const paused = { error: { type: "invalid_request_error", code: "kete_agent_paused", message: "gateway text" } }
      // A burst of refusals starts one sync.
      for (let index = 0; index < 3; index++) {
        const evt = yield* run("http.response", responseEvent(gatewayError(403, "kete_agent_paused", paused)))
        const surfaced = yield* surface(evt.response)
        expect(surfaced.error.message).toBe(
          "Agent unavailable: “Developer” was paused or changed by your organization. It is being removed from your agents; choose another agent.",
        )
        expect(isRetryable(surfaced.error)).toBe(false)
      }
      const gone = yield* eventually(agents.get(Agent.ID.make("developer")), (agent) => agent === undefined)
      expect(gone).toBeUndefined()
      expect(fake.state.syncs).toBe(2)
    }),
  )

  it.live("other responses and other providers pass through untouched", () =>
    Effect.gen(function* () {
      const fake = platform(() => [developer])
      const { run } = yield* start(yield* signedIn(fake.url))
      const cases = [
        responseEvent(new Response("{}", { status: 200 })),
        responseEvent(new Response('{"error":{"message":"overloaded"}}', { status: 529 })),
        // Not from the gateway, even with the header.
        responseEvent(gatewayError(402, "kete_agent_budget_exceeded", { error: { message: "x" } }), "anthropic"),
        // A code the runtime doesn't know.
        responseEvent(gatewayError(403, "kete_something_new", { error: { message: "x" } })),
      ]
      for (const evt of cases) {
        const before = evt.response
        yield* run("http.response", evt)
        expect(evt.response).toBe(before)
      }
      yield* Effect.promise(() => Bun.sleep(700))
      expect(fake.state.syncs).toBe(1)
    }),
  )
})

describe("agent error text", () => {
  it.effect("keeps the rest of the provider body", () =>
    Effect.sync(() => {
      expect(
        JSON.parse(
          KeteAgentSync.rewriteErrorBody('{"type":"error","error":{"type":"billing_error","code":"c","message":"old"}}', "new"),
        ),
      ).toEqual({ type: "error", error: { type: "billing_error", code: "c", message: "new" } })
      expect(JSON.parse(KeteAgentSync.rewriteErrorBody("not json", "new"))).toEqual({ error: { message: "new" } })
      expect(KeteAgentSync.agentErrorMessage("kete_agent_budget_exceeded", undefined)).toContain("This agent has used")
      expect(KeteAgentSync.agentErrorMessage("kete_unknown", "X")).toBeUndefined()
    }),
  )
})
