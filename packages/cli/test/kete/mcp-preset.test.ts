// `kete mcp add harness|slack` and `kete mcp presets` (docs/tasks/2026-10-05-mcp-presets): AC2 (the
// Harness key goes to the secret store, never config or output; --write), AC3 (Slack: client ID and
// sign-in, or the Slack app explanation), AC4 (offline). Fakes for the terminal, store and runtime.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { KeteMcpPresets } from "@opencode/schema/kete/mcp-presets"
import { KeteMcpSecret } from "@opencode/util/kete/mcp-secret"
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
  stored?: string
}

function fake(options: Options = {}) {
  const out: string[] = []
  const err: string[] = []
  const files = new Map(Object.entries(options.files ?? {}))
  const secrets = new Map<string, string>(options.stored ? [["mcp:harness", options.stored]] : [])
  const definitions = new Map<string, KeteMcpSecret.LocalDefinition>()
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
    saveSecret: async (server, secret, definition) => {
      if (options.saveFails) throw new Error("Could not store the secret: macOS Keychain: locked")
      secrets.set(`mcp:${server}`, secret)
      definitions.set(`mcp:${server}`, definition)
      return { description: "fake keychain", fallback: false }
    },
    storedSecret: async (server) => secrets.get(`mcp:${server}`),
    readText: async (file) => files.get(file),
    writeText: async (file, text) => void files.set(file, text),
    configuredSlackClientId: async () =>
      options.configured === undefined ? undefined : { clientId: options.configured, scope: "project", file: CONFIG },
    syncedSlackClientId: async () => options.synced,
    signIn: async (server) => {
      signIns.push(server)
      return options.signIn ?? { status: "complete" }
    },
  }
  const config = () => parse(files.get(CONFIG) ?? "{}") as Record<string, any>
  const everything = () => [...out, ...err, ...files.values()].join("\n")
  return { io, out, err, files, secrets, definitions, signIns, prompts, config, everything }
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

  test("the key is bound to exactly the server definition written to config", async () => {
    const world = fake()
    expect(await KeteMcpPreset.add(world.io, input("harness", { org: "default" }))).toBe(0)
    const written = world.config().mcp.servers.harness
    const bound = world.definitions.get("mcp:harness")!
    expect(KeteMcpSecret.fingerprint("harness", bound)).toBe(KeteMcpSecret.fingerprint("harness", written))
    expect(written.environment.HARNESS_BASE_URL).toBe("https://app.harness.io")
  })

  test("re-running with another option reuses the stored key (no prompt) and re-binds it", async () => {
    const world = fake({ stored: KEY })
    expect(await KeteMcpPreset.add(world.io, input("harness", { org: "other" }))).toBe(0)
    expect(world.prompts).toHaveLength(0)
    expect(world.secrets.get("mcp:harness")).toBe(KEY)
    const written = world.config().mcp.servers.harness
    expect(written.environment.HARNESS_ORG).toBe("other")
    expect(KeteMcpSecret.fingerprint("harness", world.definitions.get("mcp:harness")!)).toBe(
      KeteMcpSecret.fingerprint("harness", written),
    )
    expect(world.out.join("\n")).toContain("Reusing the API key")
    expect(world.everything()).not.toContain(KEY)
  })

  test("--new-key asks again even with a stored key", async () => {
    const world = fake({ stored: "pat.old.key", secret: KEY })
    expect(await KeteMcpPreset.add(world.io, input("harness", { newKey: true }))).toBe(0)
    expect(world.prompts).toHaveLength(1)
    expect(world.secrets.get("mcp:harness")).toBe(KEY)
  })

  test("a user's deny and narrower rules on preset actions survive a re-run; a replaced allow is warned about", async () => {
    const existing = JSON.stringify({
      permissions: [
        { action: "harness_harness_delete", resource: "*", effect: "deny" },
        { action: "harness_harness_get", resource: "secrets/*", effect: "deny" },
        { action: "harness_harness_create", resource: "*", effect: "allow" },
      ],
    })
    const world = fake({ files: { [CONFIG]: existing } })
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(0)
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(0)
    const rules = world.config().permissions as Array<{ action: string; resource: string; effect: string }>
    // Last match wins, so the user's rules must still come last for their actions.
    expect(rules.findLast((rule) => rule.action === "harness_harness_delete")).toEqual({
      action: "harness_harness_delete",
      resource: "*",
      effect: "deny",
    })
    expect(rules.findLast((rule) => rule.action === "harness_harness_get")).toEqual({
      action: "harness_harness_get",
      resource: "secrets/*",
      effect: "deny",
    })
    expect(rules.filter((rule) => rule.action === "harness_harness_delete" && rule.effect === "deny")).toHaveLength(1)
    expect(rules.findLast((rule) => rule.action === "harness_harness_create")?.effect).toBe("ask")
    expect(world.err.join("\n")).toContain("Replaced your permission rule allowing harness_harness_create")
  })

  test("an invalid permissions entry is refused rather than dropped", async () => {
    const world = fake({ files: { [CONFIG]: JSON.stringify({ permissions: [{ action: "x" }] }) } })
    expect(await KeteMcpPreset.add(world.io, input("harness"))).toBe(1)
    expect(world.err.join("\n")).toContain("isn't a valid rule")
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

  test("prints the client ID and where it came from before writing and signing in", async () => {
    const sources: Array<[Options, Partial<KeteMcpPreset.Input>, string]> = [
      [{}, { clientId: "999.000" }, "Slack app client ID: 999.000 (from --client-id)"],
      [{ configured: "111.222" }, {}, `Slack app client ID: 111.222 (from project config ${CONFIG})`],
      [{ synced: "333.444" }, {}, "Slack app client ID: 333.444 (synced from your organization)"],
    ]
    for (const [options, extra, line] of sources) {
      const world = fake(options)
      const order: string[] = []
      const write = world.io.writeText
      const io: KeteMcpPreset.IO = {
        ...world.io,
        print: (text) => {
          order.push(text)
          world.io.print(text)
        },
        writeText: async (file, text) => {
          order.push("<write>")
          await write(file, text)
        },
      }
      expect(await KeteMcpPreset.add(io, input("slack", extra))).toBe(0)
      expect(order.indexOf(line)).toBeGreaterThanOrEqual(0)
      expect(order.indexOf(line)).toBeLessThan(order.indexOf("<write>"))
    }
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
      const directories = [
        { path: project, scope: "project" as const },
        { path: global, scope: "global" as const },
      ]
      expect(await configuredSlackClientId(directories)).toEqual({ clientId: "g.1", scope: "global", file: path.join(global, "kete.json") })
      await Bun.write(path.join(project, "kete.jsonc"), `{ // project\n "kete": { "integrations": { "slack": { "clientId": "p.1" } } } }`)
      expect(await configuredSlackClientId(directories)).toEqual({ clientId: "p.1", scope: "project", file: path.join(project, "kete.jsonc") })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
