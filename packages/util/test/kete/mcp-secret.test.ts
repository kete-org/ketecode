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

const definition: KeteMcpSecret.LocalDefinition = {
  type: "local",
  command: ["npx", "-y", "harness-mcp-v2@3.2.32"],
  environment: { HARNESS_API_KEY: "{kete-secret:mcp:harness}", HARNESS_READ_ONLY: "true" },
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
    const saved = await KeteMcpSecret.save(stores, "harness", "pat.abc.def", definition)
    expect(saved.store.kind).toBe("keychain")
    // Secret and fingerprint are one store value, written and read together.
    expect(native.entries.get("mcp:harness")).toBe(`kete-mcp-v1:${KeteMcpSecret.fingerprint("harness", definition)}:pat.abc.def`)
    expect(file.entries.size).toBe(0)
    expect(await KeteMcpSecret.read(stores, "mcp:harness")).toEqual({
      secret: "pat.abc.def",
      fingerprint: KeteMcpSecret.fingerprint("harness", definition),
    })
  })

  test("falls back to the file when the OS store doesn't keep the value", async () => {
    const native = memory("secret-service", { broken: true })
    const file = memory("file")
    const stores = { candidates: [native.store, file.store] }
    const saved = await KeteMcpSecret.save(stores, "harness", "pat.abc.def", definition)
    expect(saved.store.kind).toBe("file")
    expect((await KeteMcpSecret.read(stores, "mcp:harness"))?.secret).toBe("pat.abc.def")
  })

  test("errors never contain the secret", async () => {
    const stores = { candidates: [memory("keychain", { failing: true }).store] }
    const error = await KeteMcpSecret.save(stores, "harness", "pat.very-secret", definition).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("pat.very-secret")
    expect(String(error)).not.toContain("account key")
    await expect(KeteMcpSecret.save(stores, "harness", "has space", definition)).rejects.toThrow("can't store")
    await expect(KeteMcpSecret.read(stores, "mcp:harness")).rejects.toThrow("Could not read")
  })

  test("fingerprint: covers name, command, cwd and every plain environment entry; not the reference's value", () => {
    const base = KeteMcpSecret.fingerprint("harness", definition)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    // Key order doesn't matter (canonical JSON).
    expect(
      KeteMcpSecret.fingerprint("harness", { ...definition, environment: { HARNESS_READ_ONLY: "true", HARNESS_API_KEY: "{kete-secret:mcp:harness}" } }),
    ).toBe(base)
    const changed = [
      KeteMcpSecret.fingerprint("x", definition),
      KeteMcpSecret.fingerprint("harness", { ...definition, command: ["sh", "-c", "curl evil"] }),
      KeteMcpSecret.fingerprint("harness", { ...definition, cwd: "evil" }),
      KeteMcpSecret.fingerprint("harness", { ...definition, environment: { ...definition.environment, HARNESS_READ_ONLY: "false" } }),
      KeteMcpSecret.fingerprint("harness", { ...definition, environment: { ...definition.environment, EXTRA: "1" } }),
      KeteMcpSecret.fingerprint("harness", { ...definition, environment: { HARNESS_READ_ONLY: "true", OTHER: "{kete-secret:mcp:harness}" } }),
    ]
    for (const value of changed) expect(value).not.toBe(base)
  })

  test("resolve: plain values pass without reading the store; invalid and missing entries fail", async () => {
    const fp = KeteMcpSecret.fingerprint("harness", definition)
    const lookup = async (name: string) => (name === "mcp:harness" ? { secret: "pat.x", fingerprint: fp } : undefined)
    expect(await KeteMcpSecret.resolve("harness", definition, lookup)).toEqual({ HARNESS_API_KEY: "pat.x", HARNESS_READ_ONLY: "true" })
    expect(
      await KeteMcpSecret.resolve("h", { type: "local", command: ["x"], environment: { B: "b" } }, async () => {
        throw new Error("must not be called")
      }),
    ).toEqual({ B: "b" })
    const other = { type: "local", command: ["x"], environment: { A: "{kete-secret:mcp:other}" } }
    await expect(KeteMcpSecret.resolve("other", other, lookup)).rejects.toThrow("no stored secret")
    await expect(
      KeteMcpSecret.resolve("h", { type: "local", command: ["x"], environment: { A: "{kete-secret:other}" } }, lookup),
    ).rejects.toThrow('only "mcp:<name>"')
  })

  test("resolve: a value stored without a fingerprint is never released", async () => {
    await expect(
      KeteMcpSecret.resolve("harness", definition, async () => KeteMcpSecret.decode("pat.legacy")),
    ).rejects.toThrow("kete mcp add harness")
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
