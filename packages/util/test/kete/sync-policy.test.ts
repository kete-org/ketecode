import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { KeteAccount } from "../../src/kete/account.js"
import { KeteRuntimeRegistration } from "../../src/kete/runtime-registration.js"
import type { KeteSecretStore } from "../../src/kete/secret-store.js"
import { SyncResponse, type SyncedPolicy } from "../../src/kete/sync/contract.js"
import { KeteSyncPolicy } from "../../src/kete/sync/policy.js"

// The same wildcard semantics as the runtime's permissions (core/src/util/wildcard.ts).
function match(input: string, pattern: string) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(input)
}

const policy = (overrides: Partial<SyncedPolicy>): SyncedPolicy => ({
  id: "5d0c7e2a-3b1f-4c8e-9a6d-2f4b1c3e5a70",
  name: "Policy",
  description: "",
  category: "security",
  enforcement: "enforced",
  environment_kinds: [],
  agents: null,
  rules: [],
  updated_at: "2026-09-27T09:00:00.000Z",
  ...overrides,
})

const noForcePush = policy({
  name: "No force pushes",
  rules: [
    { action: "shell", resource: "git push --force*", effect: "deny", description: "" },
    { action: "shell", resource: "git push*", effect: "ask", description: "" },
    { action: "shell", resource: "git push origin feature/*", effect: "allow", description: "feature branches" },
  ],
})
const ci = policy({
  name: "Review CI changes",
  agents: ["developer"],
  rules: [{ action: "edit", resource: ".github/workflows/*", effect: "ask", description: "" }],
})
const production = policy({ name: "Production", environment_kinds: ["production"], rules: [{ action: "*", resource: "*", effect: "deny", description: "" }] })
const audit = policy({ name: "Watch", enforcement: "audit_only", rules: [{ action: "edit", resource: "*", effect: "deny", description: "" }] })

const run = (action: string, resources: string[], agent?: string) =>
  KeteSyncPolicy.evaluate([noForcePush, ci, production, audit], { action, resources, agent, environment: "development" }, match)

describe("organization policies", () => {
  test("a broader ask after a deny never weakens it; a later allow is an exception", () => {
    const ordered = policy({
      rules: [
        { action: "shell", resource: "rm -rf *", effect: "deny", description: "" },
        { action: "shell", resource: "rm *", effect: "ask", description: "" },
        { action: "shell", resource: "rm -rf node_modules", effect: "allow", description: "" },
      ],
    })
    const decide = (command: string) =>
      KeteSyncPolicy.evaluate([ordered], { action: "shell", resources: [command], environment: "development" }, match).enforced?.effect
    expect(decide("rm -rf /tmp/x")).toBe("deny")
    expect(decide("rm a.txt")).toBe("ask")
    expect(decide("rm -rf node_modules")).toBeUndefined()
  })

  test("deny and ask; an allow later in the policy is an exception", () => {
    expect(run("shell", ["git push --force origin main"]).enforced?.effect).toBe("deny")
    expect(run("shell", ["git push origin main"]).enforced).toMatchObject({ effect: "ask", policy: { name: "No force pushes" } })
    // An exception inside the policy: nothing restricts it.
    expect(run("shell", ["git push origin feature/login"]).enforced).toBeUndefined()
    expect(run("shell", ["git status"]).enforced).toBeUndefined()
  })

  test("the most restrictive resource and policy win", () => {
    const result = run("shell", ["git push origin main", "git push -f"])
    expect(result.enforced?.effect).toBe("ask")
    expect(run("shell", ["git push origin main", "git push --force"]).enforced).toMatchObject({ effect: "deny", resource: "git push --force" })
  })

  test("agent-assigned policies apply only to those agents; other environments don't apply", () => {
    expect(run("edit", [".github/workflows/ci.yml"], "developer").enforced?.policy.name).toBe("Review CI changes")
    expect(run("edit", [".github/workflows/ci.yml"], "qa").enforced).toBeUndefined()
    expect(run("edit", [".github/workflows/ci.yml"]).enforced).toBeUndefined()
    // "Production" denies everything, but only in production.
    expect(run("read", ["src/a.ts"]).enforced).toBeUndefined()
  })

  test("audit-only policies decide nothing, but report what they would do", () => {
    const result = run("edit", ["src/a.ts"])
    expect(result.enforced).toBeUndefined()
    expect(result.audit.map((item) => [item.policy.name, item.effect])).toEqual([["Watch", "deny"]])
  })

  test("the sync response accepts policies (and still accepts a platform without them)", () => {
    const base = { organization: { id: "573b7e15-80c5-4db4-9e43-a8841b97f055", name: "Kete Labs" }, generated_at: "x", agents: [] }
    expect(Schema.decodeUnknownOption(SyncResponse)(base)._tag).toBe("Some")
    const withPolicies = Schema.decodeUnknownOption(SyncResponse)({ ...base, policies: [noForcePush, { ...ci, category: "brand-new" }] })
    expect(withPolicies._tag).toBe("Some")
    // An effect the runtime doesn't know fails the sync: the last cached copy stays in force.
    expect(Schema.decodeUnknownOption(SyncResponse)({ ...base, policies: [policy({ rules: [{ action: "x", resource: "y", effect: "maybe", description: "" }] as never })] })._tag).toBe("None")
  })
})

// ------------------------------------------------------------------ runtime type resolution

describe("resolveRuntimeType", () => {
  test("a configured value wins over the environment variable", () => {
    expect(KeteRuntimeRegistration.resolveRuntimeType("kete_cloud", { OPENCODE_RUNTIME_TYPE: "enterprise_private" })).toEqual({
      kind: "ok",
      type: "kete_cloud",
      source: "config",
    })
  })

  test("falls back to KETE_RUNTIME_TYPE, then to local; an empty variable counts as unset", () => {
    expect(KeteRuntimeRegistration.resolveRuntimeType(undefined, { OPENCODE_RUNTIME_TYPE: "enterprise_private" })).toEqual({
      kind: "ok",
      type: "enterprise_private",
      source: "KETE_RUNTIME_TYPE",
    })
    expect(KeteRuntimeRegistration.resolveRuntimeType(undefined, {})).toEqual({ kind: "ok", type: "local", source: "default" })
    expect(KeteRuntimeRegistration.resolveRuntimeType(undefined, { OPENCODE_RUNTIME_TYPE: "" })).toEqual({
      kind: "ok",
      type: "local",
      source: "default",
    })
  })

  test("an unknown value at either source is reported invalid, never guessed", () => {
    expect(KeteRuntimeRegistration.resolveRuntimeType("moon_base", {})).toEqual({ kind: "invalid", source: "config", value: "moon_base" })
    expect(KeteRuntimeRegistration.resolveRuntimeType(undefined, { OPENCODE_RUNTIME_TYPE: "moon_base" })).toEqual({
      kind: "invalid",
      source: "KETE_RUNTIME_TYPE",
      value: "moon_base",
    })
  })

  test("a long invalid value is truncated before it could appear in a message", () => {
    const result = KeteRuntimeRegistration.resolveRuntimeType("x".repeat(200), {})
    expect(result.kind).toBe("invalid")
    expect((result as { value: string }).value.length).toBeLessThanOrEqual(51)
  })

  test("the literal list matches the schema's (packages/schema/src/config/kete.ts ConfigKete.Runtime)", () => {
    expect([...KeteRuntimeRegistration.runtimeTypes]).toEqual(["local", "kete_cloud", "enterprise_private"])
  })
})

// ------------------------------------------------------------------ runtime registration

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

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

const key = "kete_test_REGISTER0123456789ab"

async function setup(status = 200) {
  const requests: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json().catch(() => undefined),
      })
      return Response.json({}, { status })
    },
  })
  cleanup.push(() => server.stop(true))
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-register-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
  return { options, requests, url: `http://127.0.0.1:${server.port}` }
}

async function signIn(options: KeteAccount.Options, url: string) {
  await KeteAccount.save(
    options,
    {
      platform_url: url,
      gateway_url: "https://gateway.example",
      organization: { id: "573b7e15-80c5-4db4-9e43-a8841b97f055", name: "Kete Labs" },
      key_id: "3f1c2b7e-0000-4000-8000-000000000001",
      device_name: "dev-macbook",
    },
    key,
  )
}

describe("runtime registration", () => {
  test("signed out: nothing is sent and no installation id is created", async () => {
    const { options, requests } = await setup()
    expect(await KeteRuntimeRegistration.register({ ...options, version: "0.2.0" })).toEqual({ kind: "signed-out" })
    expect(requests).toEqual([])
  })

  test("registers once, then only when due (version change or a day later)", async () => {
    const { options, requests, url } = await setup()
    await signIn(options, url)
    const first = await KeteRuntimeRegistration.register({ ...options, version: "0.2.0", now: () => new Date("2026-09-27T10:00:00Z") })
    expect(first.kind).toBe("registered")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/runtimes/${first.kind === "registered" ? first.installation : ""}`,
      authorization: `Bearer ${key}`,
      body: { runtime_type: "local", version: "0.2.0", device_name: "dev-macbook" },
    })
    // Only what the contract names: no paths, hostnames beyond the chosen device name, or keys.
    expect(Object.keys(requests[0]!.body as object).sort()).toEqual(["arch", "device_name", "os", "runtime_type", "version"])

    const later = await KeteRuntimeRegistration.register({ ...options, version: "0.2.0", now: () => new Date("2026-09-27T20:00:00Z") })
    expect(later.kind).toBe("skipped")
    expect((await KeteRuntimeRegistration.register({ ...options, version: "0.2.1", now: () => new Date("2026-09-27T20:00:00Z") })).kind).toBe("registered")
    expect((await KeteRuntimeRegistration.register({ ...options, version: "0.2.1", now: () => new Date("2026-09-28T21:00:00Z") })).kind).toBe("registered")
    expect(requests).toHaveLength(3)
    // One installation id throughout, stored privately.
    expect(new Set(requests.map((item) => item.path)).size).toBe(1)
    const file = KeteRuntimeRegistration.file(options)
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, "utf8")).not.toContain(key)
  })

  test("a platform without the endpoint (or down) is reported, not thrown, and retried next time", async () => {
    const { options, url } = await setup(404)
    await signIn(options, url)
    const outcome = await KeteRuntimeRegistration.register({ ...options, version: "0.2.0" })
    expect(outcome).toMatchObject({ kind: "failed", error: "the platform answered HTTP 404" })
    expect((await KeteRuntimeRegistration.register({ ...options, version: "0.2.0" })).kind).toBe("failed")
  })

  test("re-registers when the runtime type changes, even before a day passes", async () => {
    const { options, requests, url } = await setup()
    await signIn(options, url)
    const first = await KeteRuntimeRegistration.register({
      ...options,
      version: "0.2.0",
      runtimeType: "kete_cloud",
      now: () => new Date("2026-09-27T10:00:00Z"),
    })
    expect(first.kind).toBe("registered")
    const unchanged = await KeteRuntimeRegistration.register({
      ...options,
      version: "0.2.0",
      runtimeType: "kete_cloud",
      now: () => new Date("2026-09-27T10:05:00Z"),
    })
    expect(unchanged.kind).toBe("skipped")
    const changed = await KeteRuntimeRegistration.register({
      ...options,
      version: "0.2.0",
      runtimeType: "enterprise_private",
      now: () => new Date("2026-09-27T10:06:00Z"),
    })
    expect(changed.kind).toBe("registered")
    expect(requests).toHaveLength(2)
    expect(requests[1]!.body).toMatchObject({ runtime_type: "enterprise_private" })
  })

  test("an installation.json from before runtime_type existed is still valid and treated as local", async () => {
    const { options, requests, url } = await setup()
    await signIn(options, url)
    const created = await KeteRuntimeRegistration.installation(options)
    await writeFile(
      KeteRuntimeRegistration.file(options),
      JSON.stringify({
        installation_id: created.installation_id,
        registered: {
          at: new Date("2026-09-27T10:00:00Z").toISOString(),
          version: "0.2.0",
          organization: "573b7e15-80c5-4db4-9e43-a8841b97f055",
          key_id: "3f1c2b7e-0000-4000-8000-000000000001",
        },
      }),
    )
    const stillLocal = await KeteRuntimeRegistration.register({ ...options, version: "0.2.0", now: () => new Date("2026-09-27T10:05:00Z") })
    expect(stillLocal.kind).toBe("skipped")
    expect(requests).toEqual([])
    const changed = await KeteRuntimeRegistration.register({
      ...options,
      version: "0.2.0",
      runtimeType: "kete_cloud",
      now: () => new Date("2026-09-27T10:06:00Z"),
    })
    expect(changed.kind).toBe("registered")
  })
})
