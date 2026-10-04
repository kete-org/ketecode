import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteRoles } from "@opencode/core/kete/roles"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
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

const home = (signedIn: boolean) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-roles-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: undefined }
    if (signedIn)
      await KeteAccount.save(
        options,
        {
          platform_url: "https://portal.example",
          gateway_url: "https://gateway.example",
          organization: { id: "573b7e15-80c5-4db4-9e43-a8841b97f055", name: "Kete Labs" },
          key_id: "3f1c2b7e-0000-4000-8000-000000000001",
          device_name: "test",
        },
        "kete_test_ROLES0123456789abcdef",
      )
    return options
  })

const start = (signedIn: boolean) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const pluginHost = host({ agent: agentHost(agents) })
    yield* AgentPlugin.Plugin.effect(pluginHost)
    yield* KeteRoles.make({ account: yield* home(signedIn) }).effect(pluginHost)
    return agents
  })

const effect = (agent: Agent.Info | undefined, action: string, resource: string) =>
  Permission.evaluate(action, resource, agent?.permissions ?? []).effect

describe("KeteRoles", () => {
  it.effect("adds the starter roles when not signed in", () =>
    Effect.gen(function* () {
      const agents = yield* start(false)
      const list = yield* agents.list()
      const roles = list.filter((agent) => KeteRoles.roles.some((role) => role.id === agent.id))
      expect(roles.map((agent) => `${agent.id}:${agent.mode}`).toSorted()).toEqual([
        "code-reviewer:subagent",
        "devops:all",
        "docs-writer:subagent",
        "qa:subagent",
        "security:all",
      ])
      // The runtime's own Developer and Architect stay as they were.
      expect(list.some((agent) => agent.id === Agent.defaultID)).toBe(true)
      for (const role of roles) expect(role.system?.length ?? 0).toBeGreaterThan(50)
    }),
  )

  it.effect("each role can do what its job needs, and nothing more", () =>
    Effect.gen(function* () {
      const agents = yield* start(false)
      const get = (id: string) => agents.get(Agent.ID.make(id))
      const reviewer = yield* get("code-reviewer")
      expect(effect(reviewer, "read", "src/a.ts")).toBe("allow")
      expect(effect(reviewer, "shell", "git diff main")).toBe("allow")
      expect(effect(reviewer, "edit", "src/a.ts")).toBe("deny")
      expect(effect(reviewer, "shell", "npm install left-pad")).toBe("deny")
      expect(effect(reviewer, "read", ".env")).toBe("ask")

      const qa = yield* get("qa")
      expect(effect(qa, "shell", "bun test ./test")).toBe("allow")
      expect(effect(qa, "shell", "curl https://x")).toBe("ask")
      expect(effect(qa, "edit", "test/a.test.ts")).toBe("ask")
      expect(effect(qa, "subagent", "general")).toBe("deny")

      const docs = yield* get("docs-writer")
      expect(effect(docs, "edit", "README.md")).toBe("allow")
      expect(effect(docs, "edit", "docs/guide.txt")).toBe("allow")
      expect(effect(docs, "edit", "src/a.ts")).toBe("deny")

      const security = yield* get("security")
      expect(effect(security, "shell", "semgrep --config auto .")).toBe("allow")
      expect(effect(security, "shell", "npm audit fix --force")).toBe("ask")
      expect(effect(security, "edit", "src/a.ts")).toBe("deny")

      const devops = yield* get("devops")
      expect(effect(devops, "edit", ".github/workflows/ci.yml")).toBe("ask")
      expect(effect(devops, "shell", "terraform apply")).toBe("ask")
      expect(effect(devops, "shell", "git status")).toBe("allow")
      expect(effect(qa, "shell", "git log -3")).toBe("allow")
      for (const role of [reviewer, qa, docs, security, devops]) {
        expect(effect(role, "shell", "sudo rm -rf /")).toBe("deny")
        expect(effect(role, "external_directory", "/Users/me/.ssh/id_rsa")).toBe("ask")
      }
    }),
  )

  it.effect("signed in: the organization decides, so no starter roles are added", () =>
    Effect.gen(function* () {
      const agents = yield* start(true)
      const list = yield* agents.list()
      expect(list.filter((agent) => KeteRoles.roles.some((role) => role.id === agent.id))).toEqual([])
    }),
  )
})
