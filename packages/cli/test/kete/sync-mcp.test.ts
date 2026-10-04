import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteAccount } from "@opencode/util/kete/account"
import type { KeteSecretStore } from "@opencode/util/kete/secret-store"
import { KeteSyncApprovals } from "@opencode/util/kete/sync/approvals"
import { AccountFlow } from "../../src/kete/account-flow"

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const command = "npx -y @acme/mcp-jira"

const mcp = (key: string, overrides: Record<string, unknown>) => ({
  key,
  name: key.toUpperCase(),
  description: "",
  transport: "http",
  url: `https://mcp.example/${key}`,
  command: null,
  version: "1",
  credential: { type: "none", ref: null, expires_at: null },
  tools: [{ name: "search", description: "", risk: "read", requires_approval: false }],
  ...overrides,
})

const servers = [
  mcp("docs", {}),
  mcp("github", { credential: { type: "oauth", ref: null, expires_at: null } }),
  mcp("jira", { transport: "stdio", url: null, command }),
  mcp("sentry", { credential: { type: "api_key", ref: "1password://eng/sentry", expires_at: null } }),
]

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function platform() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.headers.get("if-none-match") === '"e1"') return new Response(null, { status: 304, headers: { etag: '"e1"' } })
      return Response.json(
        {
          organization: { id: org, name: "Kete Labs" },
          generated_at: "2026-09-26T10:00:00Z",
          agents: [],
          mcp_servers: servers,
          skills: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              slug: "release",
              name: "Release",
              description: "",
              version: "1.0.0",
              instructions: "# Release",
              requires_mcp: [],
              files: [],
            },
          ],
        },
        { headers: { etag: '"e1"' } },
      )
    },
  })
  cleanup.push(() => server.stop(true))
  return `http://127.0.0.1:${server.port}`
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

async function io() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-cli-mcp-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const account = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
  await KeteAccount.save(
    account,
    {
      platform_url: platform(),
      gateway_url: "https://gateway.example",
      organization: { id: org, name: "Kete Labs" },
      key_id: "3f1c2b7e-0000-4000-8000-000000000001",
      device_name: "test",
    },
    "kete_test_CLIMCP0123456789abcd",
  )
  const output: string[] = []
  const reloads = { count: 0 }
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

describe("kete sync: skills and MCP servers", () => {
  test("reports skills, and what each MCP server needs before it runs", async () => {
    const session = await io()
    await AccountFlow.sync(session.io)
    expect(session.output).toEqual([
      "Synced 0 agents from Kete Labs.",
      "Skills: 1 skill; written release.",
      "MCP servers: docs, github, jira (off), sentry (off).",
      "  github: sign in with `kete mcp auth github`.",
      `  jira: runs \`${command}\` on this machine; approve it with \`kete sync --approve jira\`.`,
      "  sentry: it needs a key (1password://eng/sentry), which Kete Code can't supply yet.",
      "The background service picked up the change.",
    ])
  })

  test("--approve lets exactly that command run, and says a change needs approval again", async () => {
    const session = await io()
    await AccountFlow.sync(session.io)
    session.output.length = 0
    await AccountFlow.sync(session.io, { approve: "jira" })
    expect(session.output).toEqual([
      "Approved JIRA (jira) to run on this machine:",
      `  ${command}`,
      "If Kete Labs changes this command, it will need your approval again.",
      "The background service picked up the change.",
    ])
    const approvals = await KeteSyncApprovals.read(session.io.account.config, org)
    expect(KeteSyncApprovals.approved(approvals, "jira", command)).toBe(true)

    session.output.length = 0
    await AccountFlow.sync(session.io)
    expect(session.output).toContain("MCP servers: docs, github, jira, sentry (off).")
    expect(session.output.join("\n")).not.toContain("approve it with")
  })

  test("--approve refuses anything that isn't a synced command", async () => {
    const session = await io()
    const before = await AccountFlow.sync(session.io, { approve: "jira" }).catch((error: unknown) => error)
    expect((before as Error).message).toContain("sign in and run `kete sync` first")
    await AccountFlow.sync(session.io)
    for (const [key, message] of [
      ["nope", "has no synced MCP server named nope"],
      ["docs", "doesn't run a command on this machine"],
    ] as const) {
      const error = await AccountFlow.sync(session.io, { approve: key }).catch((error: unknown) => error)
      expect((error as Error).message).toContain(message)
    }
  })

  test("--approve --command approves only the command that was reviewed", async () => {
    const session = await io()
    await AccountFlow.sync(session.io)
    const changed = await AccountFlow.sync(session.io, { approve: "jira", command: "npx -y @evil/other" }).catch(
      (error: unknown) => error,
    )
    expect((changed as Error).message).toContain("changed since you reviewed it; nothing was approved")
    expect(KeteSyncApprovals.approved(await KeteSyncApprovals.read(session.io.account.config, org), "jira", command)).toBe(false)
    await AccountFlow.sync(session.io, { approve: "jira", command })
    expect(KeteSyncApprovals.approved(await KeteSyncApprovals.read(session.io.account.config, org), "jira", command)).toBe(true)
    const alone = await AccountFlow.sync(session.io, { command }).catch((error: unknown) => error)
    expect((alone as Error).message).toContain("--command only goes with --approve")
  })

  test("--status --format json lists what each server needs, without a network request", async () => {
    const session = await io()
    await AccountFlow.syncStatus(session.io, { json: true })
    expect(JSON.parse(session.output[0]!)).toEqual({ signed_in: true, synced: false, servers: [] })
    await AccountFlow.sync(session.io)
    session.output.length = 0
    await AccountFlow.syncStatus(session.io, { json: true })
    const status = JSON.parse(session.output[0]!)
    expect(status.organization).toEqual({ id: org, name: "Kete Labs" })
    expect(status.servers.map((item: { key: string; enabled: boolean; needs: string | null }) => [item.key, item.enabled, item.needs])).toEqual([
      ["docs", true, null],
      ["github", true, "oauth"],
      ["jira", false, "approval"],
      ["sentry", false, "credential"],
    ])
    expect(status.servers.find((item: { key: string }) => item.key === "jira").command).toBe(command)
    // The credential reference is a pointer, not a secret; no key material is ever in the output.
    expect(session.output[0]).not.toContain("kete_test_")
  })
})
