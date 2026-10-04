import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteBudgetRule } from "@opencode/core/kete/budget-rule"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    Global.node.replace(
      Layer.succeed(
        Global.Service,
        Global.Service.of(Global.make({ data: "/data", config: "/config", tmp: "/tmp/kete" })),
      ),
    ),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
    ),
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("KeteBudgetRule.Plugin", () => {
  it.effect("makes built-in agents ask for budget while configuration rules still win", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const pluginHost = host({ agent: agentHost(agents) })
      yield* AgentPlugin.Plugin.effect(pluginHost)

      // Without the Kete rule, build's wildcard allow approves budget silently.
      const before = (yield* agents.get(Agent.defaultID))?.permissions ?? []
      expect(Permission.evaluate("budget", "*", before).effect).toBe("allow")

      yield* KeteBudgetRule.Plugin.effect(pluginHost)
      for (const agent of yield* agents.list())
        expect(Permission.evaluate("budget", "spent $5.00", agent.permissions).effect).toBe("ask")

      // Configuration rules are appended after (ConfigAgentPlugin runs in the post phase).
      const build = (yield* agents.get(Agent.defaultID))?.permissions ?? []
      for (const effect of ["allow", "deny"] as const)
        expect(
          Permission.evaluate("budget", "spent $5.00", [...build, { action: "budget", resource: "*", effect }]).effect,
        ).toBe(effect)
    }),
  )
})
