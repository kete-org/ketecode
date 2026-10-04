import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteSyncMcp } from "@opencode/core/kete/sync/mcp"
import { KeteAgentSync } from "@opencode/core/kete/sync/plugin"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import type { Plugin } from "@opencode/plugin/effect"
import { Mcp } from "@opencode/schema/mcp"
import { Skill } from "@opencode/schema/skill"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { KeteSyncApprovals } from "@opencode/util/kete/sync/approvals"
import type { SyncedMcpServer } from "@opencode/util/kete/sync/contract"
import { KeteSync } from "@opencode/util/kete/sync/sync"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"
import { permissions, registries } from "./sync-fixture"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))
const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const server = (overrides: Partial<SyncedMcpServer> = {}): SyncedMcpServer => ({
  key: "github",
  name: "GitHub",
  description: "",
  transport: "http",
  url: "https://mcp.example/github",
  command: null,
  version: "1",
  credential: { type: "none", ref: null, expires_at: null },
  tools: [
    { name: "list_prs", description: "", risk: "read", requires_approval: false },
    { name: "create_pr", description: "", risk: "write", requires_approval: true },
  ],
  ...overrides,
})

describe("MCP server mapping", () => {
  test("http without a credential: a remote server that never starts OAuth", () => {
    const mapped = KeteSyncMcp.map(server(), {})
    expect(mapped.config).toBeInstanceOf(Mcp.RemoteConfig)
    expect(mapped.config).toMatchObject({ type: "remote", url: "https://mcp.example/github", oauth: false, disabled: false })
    expect(mapped.note).toBeUndefined()
  })

  test("OAuth: the runtime's MCP OAuth, and a pointer to kete mcp auth", () => {
    const mapped = KeteSyncMcp.map(server({ credential: { type: "oauth", ref: null, expires_at: null } }), {})
    expect(mapped.config).toMatchObject({ type: "remote", disabled: false })
    expect("oauth" in mapped.config && mapped.config.oauth).toBeFalsy()
    expect(mapped).toMatchObject({ needs: "oauth", note: "sign in with `kete mcp auth github`" })
  })

  test("SSE: registered, with a warning", () => {
    const mapped = KeteSyncMcp.map(server({ transport: "sse" }), {})
    expect(mapped.config).toMatchObject({ type: "remote", disabled: false })
    expect(mapped.note).toContain("SSE")
  })

  test("a key or service account: disabled, naming where it lives, never guessed", () => {
    for (const type of ["api_key", "service_account"] as const) {
      const mapped = KeteSyncMcp.map(server({ credential: { type, ref: "vault://team/github", expires_at: null } }), {})
      expect(mapped.config.disabled).toBe(true)
      expect(mapped.needs).toBe("credential")
      expect(mapped.note).toContain("vault://team/github")
      expect(JSON.stringify(mapped.config)).not.toContain("vault://")
    }
  })

  test("stdio: disabled until the exact command is approved", async () => {
    const command = `npx -y "@acme/mcp server" --flag='a b'`
    const stdio = server({ transport: "stdio", url: null, command })
    const pending = KeteSyncMcp.map(stdio, {})
    expect(pending.config).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@acme/mcp server", "--flag=a b"],
      disabled: true,
    })
    expect(pending).toMatchObject({ needs: "approval" })
    expect(pending.note).toContain(`\`${command}\``)
    expect(pending.note).toContain("kete sync --approve github")

    const approved = { github: KeteSyncApprovals.hash(command) }
    expect(KeteSyncMcp.map(stdio, approved).config.disabled).toBe(false)
    // A changed command needs approval again.
    expect(KeteSyncMcp.map(server({ transport: "stdio", url: null, command: `${command} --more` }), approved).config.disabled).toBe(true)
  })

  test("unusable servers are disabled, not guessed at", () => {
    expect(KeteSyncMcp.map(server({ transport: "stdio", url: null, command: `npx "unterminated` }), {}).needs).toBe("invalid")
    expect(KeteSyncMcp.map(server({ url: "file:///etc/passwd" }), {}).config.disabled).toBe(true)
    expect(KeteSyncMcp.map(server({ url: null }), {}).needs).toBe("invalid")
  })

  test("command splitting follows shell quoting without running a shell", () => {
    expect(KeteSyncMcp.split("node server.js")).toEqual(["node", "server.js"])
    expect(KeteSyncMcp.split(`a "b c" 'd e' f\\ g "h\\"i"`)).toEqual(["a", "b c", "d e", "f g", 'h"i'])
    expect(KeteSyncMcp.split("a  $(rm -rf ~) ; b")).toEqual(["a", "$(rm", "-rf", "~)", ";", "b"])
    expect(KeteSyncMcp.split(`"open`)).toBeUndefined()
    expect(KeteSyncMcp.split("trailing\\")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------------

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

const agent = {
  id: "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
  slug: "developer",
  version: 1,
  name: "Developer",
  description: "",
  mode: "primary",
  model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
  instructions: "",
  tools: { edit: true, shell: true, web: false, skills: ["release"], subagents: [], mcp: { github: "*" } },
  permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "github_list_prs", resource: "*", effect: "allow" }],
  budget: { monthly_micros: null, spent_micros: 0, period: "2026-09" },
}
const checklist = "- [ ] tag\n"
const release = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "release",
  name: "Release",
  description: "Cut a release.",
  version: "1.0.0",
  instructions: "# Release\n\nFollow checklist.md.",
  requires_mcp: ["github"],
  files: [{ path: "checklist.md", size_bytes: checklist.length, sha256: sha(checklist), executable: false }],
}

function platform() {
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname.endsWith("/files")
        ? Response.json({
            skill: { id: release.id, slug: "release" },
            files: [{ ...release.files[0], content: checklist }],
          })
        : Response.json(
            {
              organization: { id: org, name: "Kete Labs" },
              generated_at: "2026-09-26T10:00:00Z",
              agents: [agent],
              mcp_servers: [server()],
              skills: [release],
            },
            { headers: { etag: '"e1"' } },
          ),
  })
  cleanup.push(() => fake.stop(true))
  return `http://127.0.0.1:${fake.port}`
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

/** Signed in, and synced once (as `kete login` does), so the plugin starts from the cache. */
const synced = Effect.promise(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-skill-mcp-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
  await KeteAccount.save(
    options,
    {
      platform_url: platform(),
      gateway_url: "https://gateway.example",
      organization: { id: org, name: "Kete Labs" },
      key_id: "3f1c2b7e-0000-4000-8000-000000000001",
      device_name: "test",
    },
    "kete_test_SKILLMCP0123456789ab",
  )
  expect((await KeteSync.sync(options)).kind).toBe("updated")
  return options
})

describe("synced skills and MCP servers in the runtime", () => {
  it.live("registers managed skills and servers, replacing local ones with the same name", () =>
    Effect.gen(function* () {
      const options = yield* synced
      const agents = yield* Agent.Service
      const local = registries({
        skills: [
          Skill.Info.make({
            id: Skill.ID.make("release"),
            name: Skill.Name.make("My release"),
            path: AbsolutePath.make("/home/me/.config/kete/skills/release/SKILL.md"),
            content: "local",
          }),
        ],
        servers: { github: new Mcp.LocalConfig({ type: "local", command: ["my-github"] }) },
      })
      const pluginHost = host({ permission: permissions().host, agent: agentHost(agents), skill: local.host.skill, mcp: local.host.mcp, session: { hook: (() => Effect.void) as unknown as Plugin.Context["session"]["hook"] } })
      yield* AgentPlugin.Plugin.effect(pluginHost)
      yield* KeteAgentSync.make({ registration: false, interval: "1 hour", account: options }).effect(pluginHost).pipe(
        Effect.provide(Config.testLayer([])),
      )

      const skill = local.skills.get("release")
      expect(skill).toMatchObject({
        name: "Release",
        description: "Cut a release. · Managed by Kete Labs",
        content: "# Release\n\nFollow checklist.md.",
        path: path.join(options.config, "managed", org, "skills", "release", "SKILL.md"),
      })
      expect(local.servers.get("github")).toMatchObject({ type: "remote", url: "https://mcp.example/github", disabled: false })

      // The managed agent keeps the organization's rules for the server's tools.
      const developer = yield* agents.get(Agent.ID.make("developer"))
      expect(Permission.evaluate("github_list_prs", "*", developer!.permissions).effect).toBe("allow")
      expect(Permission.evaluate("github_create_pr", "*", developer!.permissions).effect).toBe("deny")
      // Local agents ask before the managed server's tools, where they'd otherwise run silently...
      const build = yield* agents.get(Agent.defaultID)
      expect(Permission.evaluate("github_create_pr", "*", build!.permissions).effect).toBe("ask")
      expect(Permission.evaluate("github_list_prs", "*", build!.permissions).effect).toBe("ask")
      // ...and a denial is never loosened.
      const explore = yield* agents.get(Agent.ID.make("explore"))
      expect(Permission.evaluate("github_create_pr", "*", explore!.permissions).effect).toBe("deny")
    }),
  )

  it.live("not signed in: skills and servers are exactly as configured", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "kete-skill-mcp-")))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const agents = yield* Agent.Service
      const local = registries({ servers: { github: new Mcp.LocalConfig({ type: "local", command: ["my-github"] }) } })
      const pluginHost = host({ permission: permissions().host, agent: agentHost(agents), skill: local.host.skill, mcp: local.host.mcp, session: { hook: (() => Effect.void) as unknown as Plugin.Context["session"]["hook"] } })
      yield* KeteAgentSync.make({ registration: false,
        interval: "1 hour",
        account: { config: path.join(root, "c"), data: path.join(root, "d"), native: memoryStore() },
      }).effect(pluginHost).pipe(Effect.provide(Config.testLayer([])))
      expect([...local.skills.keys()]).toEqual([])
      expect(local.servers.get("github")).toMatchObject({ type: "local", command: ["my-github"] })
    }),
  )
})
