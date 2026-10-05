// Stored MCP secrets (docs/tasks/2026-10-05-mcp-presets, AC2): references, saving to the first store
// that keeps the value, reading back with the fallback, and the synced Slack app client ID.
import { describe, expect, test } from "bun:test"
import { KeteMcpSecret } from "../../src/kete/mcp-secret.js"
import type { KeteSecretStore } from "../../src/kete/secret-store.js"
import { KeteSyncIntegrations } from "../../src/kete/sync/integrations.js"
import { SyncResponse } from "../../src/kete/sync/contract.js"
import { Schema } from "effect"

function memory(kind: KeteSecretStore.Kind, options: { broken?: boolean; failing?: boolean } = {}) {
  const entries = new Map<string, string>()
  const store: KeteSecretStore.Store = {
    kind,
    description: `fake ${kind}`,
    set: async (name, secret) => {
      if (options.failing) throw new Error(`${kind} is locked`)
      if (!options.broken) entries.set(name, secret)
    },
    get: async (name) => {
      if (options.failing) throw new Error(`${kind} is locked`)
      return entries.get(name)
    },
    remove: async (name) => void entries.delete(name),
  }
  return { store, entries }
}

describe("KeteMcpSecret", () => {
  test("reference and parse", () => {
    expect(KeteMcpSecret.reference("harness")).toBe("{kete-secret:mcp:harness}")
    expect(KeteMcpSecret.parse("{kete-secret:mcp:harness}")).toEqual({ kind: "secret", entry: "mcp:harness" })
    expect(KeteMcpSecret.parse("plain")).toEqual({ kind: "plain" })
    expect(KeteMcpSecret.parse("prefix {kete-secret:mcp:harness}")).toEqual({ kind: "plain" })
    expect(KeteMcpSecret.parse("{kete-secret:host/key}").kind).toBe("invalid")
    expect(() => KeteMcpSecret.entry("../x")).toThrow()
  })

  test("saves in the OS store and reads it back", async () => {
    const native = memory("keychain")
    const file = memory("file")
    const stores = { candidates: [native.store, file.store] }
    const saved = await KeteMcpSecret.save(stores, "harness", "pat.abc.def")
    expect(saved.store.kind).toBe("keychain")
    expect(native.entries.get("mcp:harness")).toBe("pat.abc.def")
    expect(file.entries.size).toBe(0)
    expect(await KeteMcpSecret.read(stores, "mcp:harness")).toBe("pat.abc.def")
  })

  test("falls back to the file when the OS store doesn't keep the value", async () => {
    const native = memory("secret-service", { broken: true })
    const file = memory("file")
    const stores = { candidates: [native.store, file.store] }
    const saved = await KeteMcpSecret.save(stores, "harness", "pat.abc.def")
    expect(saved.store.kind).toBe("file")
    expect(await KeteMcpSecret.read(stores, "mcp:harness")).toBe("pat.abc.def")
  })

  test("errors never contain the secret", async () => {
    const stores = { candidates: [memory("keychain", { failing: true }).store] }
    const error = await KeteMcpSecret.save(stores, "harness", "pat.very-secret").catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("pat.very-secret")
    expect(String(error)).not.toContain("account key")
    await expect(KeteMcpSecret.save(stores, "harness", "has space")).rejects.toThrow("can't store")
    await expect(KeteMcpSecret.read(stores, "mcp:harness")).rejects.toThrow("Could not read")
  })

  test("resolve: missing and foreign entries fail; plain values pass", async () => {
    const lookup = async (name: string) => (name === "mcp:harness" ? "pat.x" : undefined)
    expect(await KeteMcpSecret.resolve("h", { A: "{kete-secret:mcp:harness}", B: "b" }, lookup)).toEqual({ A: "pat.x", B: "b" })
    await expect(KeteMcpSecret.resolve("h", { A: "{kete-secret:mcp:other}" }, lookup)).rejects.toThrow("no stored secret")
    await expect(KeteMcpSecret.resolve("h", { A: "{kete-secret:other}" }, lookup)).rejects.toThrow('only "mcp:<name>"')
  })
})

describe("KeteSyncIntegrations.slackClientId", () => {
  test("reads integrations.slack.client_id when present and valid; tolerates absence and odd shapes", () => {
    expect(KeteSyncIntegrations.slackClientId({ integrations: { slack: { client_id: "123.456" } } })).toBe("123.456")
    expect(KeteSyncIntegrations.slackClientId({ integrations: { slack: { clientId: "123.456" } } })).toBe("123.456")
    expect(KeteSyncIntegrations.slackClientId({})).toBeUndefined()
    expect(KeteSyncIntegrations.slackClientId(undefined)).toBeUndefined()
    expect(KeteSyncIntegrations.slackClientId({ integrations: "nope" })).toBeUndefined()
    expect(KeteSyncIntegrations.slackClientId({ integrations: { slack: { client_id: "bad id" } } })).toBeUndefined()
    expect(KeteSyncIntegrations.slackClientId({ integrations: [] })).toBeUndefined()
  })

  test("a sync response keeps integrations through decoding, and decodes without them", () => {
    const base = { organization: { id: "573b7e15-80c5-4db4-9e43-a8841b97f055", name: "Acme" }, generated_at: "2026-10-05T00:00:00Z", agents: [] }
    const decode = Schema.decodeUnknownSync(SyncResponse)
    expect(KeteSyncIntegrations.slackClientId(decode({ ...base, integrations: { slack: { client_id: "1.2" } } }))).toBe("1.2")
    expect(KeteSyncIntegrations.slackClientId(decode(base))).toBeUndefined()
  })
})
