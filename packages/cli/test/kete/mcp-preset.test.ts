// `kete mcp add harness|slack` and `kete mcp presets` (docs/tasks/2026-10-05-mcp-presets): AC2 (the
// Harness key goes to the secret store, never config or output; --write), AC3 (Slack: client ID and
// sign-in, or the Slack app explanation), AC4 (offline). Fakes for the terminal, store and runtime.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { KeteMcpPresets } from "@opencode/schema/kete/mcp-presets"
import { KeteMcpPreset } from "../../src/kete/mcp-preset"
import { configuredSlackClientId } from "../../src/kete/mcp-preset-io"

const KEY = "pat.fakeAccount.fakeToken.0123456789"
const CONFIG = "/project/kete.jsonc"

type Options = {
  interactive?: boolean
  secret?: string | undefined
  environment?: Record<string, string | undefined>
  files?: Record<string, string>
  configured?: string
  synced?: string
  signIn?: KeteMcpPreset.SignInResult
  saveFails?: boolean
}

function fake(options: Options = {}) {
  const out: string[] = []
  const err: string[] = []
  const files = new Map(Object.entries(options.files ?? {}))
  const secrets = new Map<string, string>()
  const signIns: string[] = []
  const prompts: string[] = []
  const io: KeteMcpPreset.IO = {
    print: (line) => out.push(line),
    warn: (line) => err.push(line),
    environment: options.environment ?? {},
    interactive: options.interactive ?? true,
    promptSecret: async (message) => {
      prompts.push(message)
      return "secret" in options ? options.secret : KEY
    },
    saveSecret: async (server, secret) => {
      if (options.saveFails) throw new Error("Could not store the secret: macOS Keychain: locked")
      secrets.set(`mcp:${server}`, secret)
      return { description: "fake keychain", fallback: false }
    },
    readText: async (file) => files.get(file),
    writeText: async (file, text) => void files.set(file, text),
    configuredSlackClientId: async () => options.configured,
    syncedSlackClientId: async () => options.synced,
    signIn: async (server) => {
      signIns.push(server)
      return options.signIn ?? { status: "complete" }
    },
  }
  const config = () => parse(files.get(CONFIG) ?? "{}") as Record<string, any>
  const everything = () => [...out, ...err, ...files.values()].join("\n")
  return { io, out, err, files, secrets, signIns, prompts, config, everything }
}

const input = (name: KeteMcpPresets.Name, extra: Partial<KeteMcpPreset.Input> = {}): KeteMcpPreset.Input => ({
  name,
  configPath: CONFIG,
  write: false,
  ...extra,
})

describe("kete mcp add harness", () => {
  test("prompts (hidden), stores the key in the secret store, and config only refers to it", async () => {
    const world = fake()
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(0)
    expect(world.prompts).toHaveLength(1)
    expect(world.secrets.get("mcp:harness")).toBe(KEY)
    const server = world.config().mcp.servers.harness
    expect(server.command).toEqual(["npx", "-y", "harness-mcp-v2@3.2.32"])
    expect(server.environment.HARNESS_API_KEY).toBe("{kete-secret:mcp:harness}")
    expect(server.environment.HARNESS_READ_ONLY).toBe("true")
    // The key is nowhere but the store: not in the config file, not in any output.
    expect(world.everything()).not.toContain(KEY)
    expect(world.out.join("\n")).toContain("Read-only")
  })

  test("--write turns read-only off; write tools keep their ask rules", async () => {
    const world = fake()
    expect(await KeteMcpPreset.add(world.io, input("harness", { write: true, org: "default", project: "web" }))).toBe(0)
    const config = world.config()
    expect(config.mcp.servers.harness.environment).toMatchObject({ HARNESS_READ_ONLY: "false", HARNESS_ORG: "default", HARNESS_PROJECT: "web" })
    const rules = config.permissions as Array<{ action: string; effect: string }>
    for (const tool of KeteMcpPresets.harnessWriteTools)
      expect(rules.findLast((rule) => rule.action === `harness_${tool}`)?.effect).toBe("ask")
    expect(rules.findLast((rule) => rule.action === "harness_harness_list")?.effect).toBe("allow")
    expect(world.out.join("\n")).toContain("ask before each use")
  })

  test("keeps existing config, comments and rules; running it again doesn't duplicate rules", async () => {
    const existing = `{\n  // my settings\n  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],\n  "mcp": { "servers": { "docs": { "type": "remote", "url": "https://docs.example/mcp" } } }\n}\n`
    const world = fake({ files: { [CONFIG]: existing } })
    await KeteMcpPreset.add(world.io, input("harness"))
    const first = world.files.get(CONFIG)!
    await KeteMcpPreset.add(world.io, input("harness"))
    const second = world.files.get(CONFIG)!
    expect(second).toBe(first)
    expect(second).toContain("// my settings")
    const config = world.config()
    expect(config.mcp.servers.docs.url).toBe("https://docs.example/mcp")
    expect(config.permissions[0]).toEqual({ action: "shell", resource: "*", effect: "ask" })
    expect(config.permissions).toHaveLength(1 + KeteMcpPresets.permissions("harness").length)
  })

  test("bad flags are refused before the prompt; nothing is written", async () => {
    const world = fake()
    expect(await KeteMcpPreset.add(world.io, input("harness", { baseUrl: "not a url" }))).toBe(2)
    expect(world.prompts).toHaveLength(0)
    expect(world.files.size).toBe(0)
  })

  test("cancel and empty input change nothing", async () => {
    const cancelled = fake({ secret: undefined })
    expect(await KeteMcpPreset.add(cancelled.io, input("harness"))).toBe(130)
    expect(cancelled.files.size).toBe(0)
    const empty = fake({ secret: "   " })
    expect(await KeteMcpPreset.add(empty.io, input("harness"))).toBe(2)
    expect(empty.files.size + empty.secrets.size).toBe(0)
  })

  test("a store failure is reported without the key and nothing is written", async () => {
    const world = fake({ saveFails: true })
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(1)
    expect(world.files.size).toBe(0)
    expect(world.everything()).not.toContain(KEY)
  })

  test("without a terminal: HARNESS_API_KEY from the environment, as an {env:} reference", async () => {
    const world = fake({ interactive: false, environment: { HARNESS_API_KEY: KEY } })
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(0)
    expect(world.config().mcp.servers.harness.environment.HARNESS_API_KEY).toBe("{env:HARNESS_API_KEY}")
    expect(world.secrets.size).toBe(0)
    expect(world.everything()).not.toContain(KEY)
  })

  test("without a terminal or HARNESS_API_KEY it refuses", async () => {
    const world = fake({ interactive: false })
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(2)
    expect(world.err.join("\n")).toContain("needs a terminal")
    expect(world.files.size).toBe(0)
  })

  test("offline: configured, with a note that it's skipped (AC4)", async () => {
    const world = fake({ environment: { OPENCODE_OFFLINE: "1" } })
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(0)
    expect(world.out.join("\n")).toContain("Offline mode is on: the harness server is skipped")
  })
})

describe("kete mcp add slack", () => {
  test("writes the remote entry with the client ID and starts the sign-in", async () => {
    const world = fake()
    expect(await KeteMcpPreset.add(world.io, input("slack", { clientId: "1234.5678" }))).toBe(0)
    const server = world.config().mcp.servers.slack
    expect(server).toEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: { client_id: "1234.5678", redirect_uri: "http://127.0.0.1:34561/callback" },
    })
    expect(world.signIns).toEqual(["slack"])
    const rules = world.config().permissions as Array<{ action: string; effect: string }>
    expect(rules.findLast((rule) => rule.action === "slack_slack_send_message")?.effect).toBe("ask")
    expect(rules.findLast((rule) => rule.action === "slack_slack_search_public")?.effect).toBe("allow")
  })

  test("client ID: --client-id, then config, then the organization's synced app", async () => {
    const fromConfig = fake({ configured: "111.222", synced: "333.444" })
    await KeteMcpPreset.add(fromConfig.io, input("slack"))
    expect(fromConfig.config().mcp.servers.slack.oauth.client_id).toBe("111.222")
    const fromSync = fake({ synced: "333.444" })
    await KeteMcpPreset.add(fromSync.io, input("slack"))
    expect(fromSync.config().mcp.servers.slack.oauth.client_id).toBe("333.444")
    const fromFlag = fake({ configured: "111.222" })
    await KeteMcpPreset.add(fromFlag.io, input("slack", { clientId: "999.000" }))
    expect(fromFlag.config().mcp.servers.slack.oauth.client_id).toBe("999.000")
  })

  test("without a client ID it explains the Slack app requirement and writes nothing", async () => {
    const world = fake()
    expect(await KeteMcpPreset.add(world.io, input("slack"))).toBe(2)
    const text = world.out.join("\n")
    expect(text).toContain("Marketplace")
    expect(text).toContain("internal")
    expect(text).toContain("admin must approve")
    expect(text).toContain("--client-id")
    expect(world.files.size).toBe(0)
    expect(world.signIns).toHaveLength(0)
  })

  test("a failed sign-in keeps the config and says how to retry", async () => {
    const world = fake({ signIn: { status: "failed", message: "invalid_client" } })
    expect(await KeteMcpPreset.add(world.io, input("slack", { clientId: "1.2" }))).toBe(1)
    expect(world.config().mcp.servers.slack).toBeDefined()
    expect(world.out.join("\n")).toContain("kete mcp auth slack")
  })

  test("offline: configured, no sign-in, with the message (AC4)", async () => {
    const world = fake({ environment: { OPENCODE_OFFLINE: "1" } })
    expect(await KeteMcpPreset.add(world.io, input("slack", { clientId: "1.2" }))).toBe(0)
    expect(world.signIns).toHaveLength(0)
    expect(world.out.join("\n")).toContain("Offline mode is on: the slack server is skipped")
  })
})

describe("routing kete mcp add", () => {
  test("a preset name without --url or a command is the preset", () => {
    expect(KeteMcpPreset.route("harness", false, [])).toEqual({ kind: "preset", name: "harness" })
    expect(KeteMcpPreset.route("slack", false, ["--client-id"])).toEqual({ kind: "preset", name: "slack" })
  })
  test("with --url or a command it's upstream's own server entry", () => {
    expect(KeteMcpPreset.route("harness", true, [])).toEqual({ kind: "server" })
    expect(KeteMcpPreset.route("mine", true, [])).toEqual({ kind: "server" })
  })
  test("preset flags are never silently ignored", () => {
    expect(KeteMcpPreset.route("mine", true, ["--write"]).kind).toBe("error")
    expect(KeteMcpPreset.route("slack", false, ["--write"]).kind).toBe("error")
    expect(KeteMcpPreset.route("harness", false, ["--client-id"]).kind).toBe("error")
  })
})

describe("kete mcp presets", () => {
  test("lists both presets with the pinned version", () => {
    const out: string[] = []
    KeteMcpPreset.list({ print: (line) => out.push(line), environment: {} })
    const text = out.join("\n")
    expect(text).toContain("harness")
    expect(text).toContain("harness-mcp-v2@3.2.32")
    expect(text).toContain("slack")
    expect(text).not.toContain("offline")
  })
  test("offline marks them skipped", () => {
    const out: string[] = []
    KeteMcpPreset.list({ print: (line) => out.push(line), environment: { OPENCODE_OFFLINE: "1" } })
    expect(out.filter((line) => line.includes("[skipped: offline mode]"))).toHaveLength(2)
  })
})

describe("kete.integrations.slack.clientId from config files", () => {
  test("project first, then global; comments allowed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-preset-"))
    try {
      const project = path.join(root, "project")
      const global = path.join(root, "global")
      await Bun.write(path.join(global, "kete.json"), JSON.stringify({ kete: { integrations: { slack: { clientId: "g.1" } } } }))
      expect(await configuredSlackClientId([project, global])).toBe("g.1")
      await Bun.write(path.join(project, "kete.jsonc"), `{ // project\n "kete": { "integrations": { "slack": { "clientId": "p.1" } } } }`)
      expect(await configuredSlackClientId([project, global])).toBe("p.1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
