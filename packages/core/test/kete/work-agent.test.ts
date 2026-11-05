import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteWorkAgent } from "@opencode/core/kete/work-agent"
import { Location } from "@opencode/core/location"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    Global.node.replace(
      Layer.succeed(Global.Service, Global.Service.of(Global.make({ data: "/data", config: "/config", tmp: "/tmp/kete" }))),
    ),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
    ),
  ]) as unknown as Layer.Layer<unknown, never>,
)

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

// The agent must not depend on the account: it exists signed in and signed out.
const signIn = Effect.promise(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-work-agent-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: undefined }
  await KeteAccount.save(
    options,
    {
      platform_url: "https://portal.example",
      gateway_url: "https://gateway.example",
      organization: { id: "573b7e15-80c5-4db4-9e43-a8841b97f055", name: "Kete Labs" },
      key_id: "3f1c2b7e-0000-4000-8000-000000000001",
      device_name: "test",
    },
    "kete_test_WORK0123456789abcdef",
  )
})

const start = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const pluginHost = host({ agent: agentHost(agents) })
  yield* AgentPlugin.Plugin.effect(pluginHost)
  yield* KeteWorkAgent.Plugin.effect(pluginHost)
  return agents
})

const id = Agent.ID.make(KeteWorkAgent.ID)

describe("KeteWorkAgent", () => {
  it.effect("exists as a hidden primary agent", () =>
    Effect.gen(function* () {
      const agent = yield* (yield* start).get(id)
      expect(agent?.hidden).toBe(true)
      expect(agent?.mode).toBe("primary")
      expect(agent?.system?.length ?? 0).toBeGreaterThan(50)
    }),
  )

  it.effect("exists when signed in to an organization too", () =>
    Effect.gen(function* () {
      yield* signIn
      const agent = yield* (yield* start).get(id)
      expect(agent?.hidden).toBe(true)
    }),
  )

  it.effect("is not the default and not first in the list", () =>
    Effect.gen(function* () {
      const agents = yield* start
      expect((yield* agents.select()).id).toBe(Agent.defaultID)
      expect((yield* agents.list())[0]?.id).not.toBe(id)
    }),
  )

  it.effect("a session created with its id resolves to it", () =>
    Effect.gen(function* () {
      const selected = yield* (yield* start).select(id)
      expect(selected.info?.id).toBe(id)
    }),
  )
})
