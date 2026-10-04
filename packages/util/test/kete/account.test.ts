import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteAccount } from "../../src/kete/account.js"
import { KeteSecretStore } from "../../src/kete/secret-store.js"

const secret = "kete_sk_live_0123456789abcdefABCDEF"
const details = {
  platform_url: "https://platform.example",
  gateway_url: "https://gateway.example",
  organization: { id: "8f7a1c9e-0000-4000-8000-000000000001", name: "Acme" },
  key_id: "8f7a1c9e-0000-4000-8000-000000000002",
  device_name: "laptop",
} satisfies KeteAccount.Details

function memoryStore(behaviour: "works" | "fails" | "forgets" = "works"): KeteSecretStore.Store & {
  entries: Map<string, string>
} {
  const entries = new Map<string, string>()
  return {
    entries,
    kind: "keychain",
    description: "test keychain",
    set: async (name, value) => {
      if (behaviour === "fails") throw new Error("User interaction is not allowed.")
      if (behaviour === "works") entries.set(name, value)
    },
    get: async (name) => entries.get(name),
    remove: async (name) => void entries.delete(name),
  }
}

async function withDirectory<A>(run: (options: { config: string; data: string }) => Promise<A>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-account-"))
  try {
    return await run({ config: path.join(root, "config"), data: path.join(root, "data") })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("KeteAccount storage backend selection", () => {
  test("uses the OS store when it holds the key", () =>
    withDirectory(async (directories) => {
      const native = memoryStore()
      const options = { ...directories, native }
      const saved = await KeteAccount.save(options, details, secret)
      expect(saved.store.kind).toBe("keychain")
      expect(saved.skipped).toEqual([])
      expect(await KeteAccount.read(options)).toMatchObject({ ...details, storage: "keychain", version: 1 })
      expect(await KeteAccount.key(options, saved.account)).toBe(secret)
      // The fallback file was never written.
      expect(await stat(directories.data).catch(() => undefined)).toBeUndefined()
    }))

  test("falls back to a user-only file when the OS store fails, and says why", () =>
    withDirectory(async (directories) => {
      const options = { ...directories, native: memoryStore("fails") }
      const saved = await KeteAccount.save(options, details, secret)
      expect(saved.store.kind).toBe("file")
      expect(saved.skipped.map((item) => item.reason)).toEqual(["User interaction is not allowed."])
      expect(await KeteAccount.key(options, saved.account)).toBe(secret)
      if (process.platform !== "win32") {
        const [file] = await Array.fromAsync(new Bun.Glob("account-key-*").scan({ cwd: directories.data, absolute: true }))
        expect((await stat(file)).mode & 0o777).toBe(0o600)
        expect((await stat(directories.data)).mode & 0o777).toBe(0o700)
      }
    }))

  test("skips an OS store that reports success but does not keep the key", () =>
    withDirectory(async (directories) => {
      const native = memoryStore("forgets")
      const saved = await KeteAccount.save({ ...directories, native }, details, secret)
      expect(saved.store.kind).toBe("file")
      expect(saved.skipped[0]?.reason).toBe("the stored key could not be read back")
    }))

  test("falls back to the file when the platform has no OS store", () =>
    withDirectory(async (directories) => {
      const saved = await KeteAccount.save({ ...directories, native: undefined }, details, secret)
      expect(saved.store.kind).toBe("file")
    }))

  test("picks the OS store by platform", () => {
    expect(KeteSecretStore.native("darwin")?.kind).toBe("keychain")
    expect(KeteSecretStore.native("linux")?.kind).toBe("secret-service")
    expect(KeteSecretStore.native("win32")?.kind).toBe("credential-manager")
    expect(KeteSecretStore.native("aix")).toBeUndefined()
  })
})

describe("KeteAccount files", () => {
  test("account.json holds only non-secret details and is private", () =>
    withDirectory(async (directories) => {
      const options = { ...directories, native: memoryStore() }
      await KeteAccount.save(options, details, secret)
      const text = await readFile(KeteAccount.file(options), "utf8")
      expect(text).not.toContain(secret)
      if (process.platform !== "win32") expect((await stat(KeteAccount.file(options))).mode & 0o777).toBe(0o600)
    }))

  test("clear removes the key and account.json", () =>
    withDirectory(async (directories) => {
      const native = memoryStore()
      const options = { ...directories, native }
      const saved = await KeteAccount.save(options, details, secret)
      expect(await KeteAccount.clear(options, saved.account)).toEqual([])
      expect(native.entries.size).toBe(0)
      expect(await KeteAccount.read(options)).toBeUndefined()
    }))

  test("an invalid account.json is reported, not silently ignored", () =>
    withDirectory(async (directories) => {
      const options = { ...directories, native: undefined }
      await Bun.write(KeteAccount.file(options), "{ not json")
      await expect(KeteAccount.read(options)).rejects.toThrow("is not a valid account file")
    }))

  test("rejects keys that a credential tool could re-parse", () =>
    withDirectory(async (directories) => {
      const options = { ...directories, native: memoryStore() }
      await expect(KeteAccount.save(options, details, 'abc" -w other')).rejects.toThrow("unexpected format")
    }))
})

// The real macOS backend, against a throwaway keychain file (never the login keychain).
describe.skipIf(process.platform !== "darwin")("macOS Keychain backend", () => {
  test("stores, updates, reads and deletes a key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-keychain-"))
    const keychain = path.join(root, "test.keychain-db")
    execFileSync("security", ["create-keychain", "-p", "test", keychain])
    try {
      execFileSync("security", ["unlock-keychain", "-p", "test", keychain])
      const store = KeteSecretStore.keychain({ keychain })
      const name = "platform.example/key"
      expect(await store.get(name)).toBeUndefined()
      expect((await KeteSecretStore.save([store], name, secret)).store.kind).toBe("keychain")
      expect(await store.get(name)).toBe(secret)
      await store.set(name, "kete_sk_rotated")
      expect(await store.get(name)).toBe("kete_sk_rotated")
      await store.remove(name)
      await store.remove(name)
      expect(await store.get(name)).toBeUndefined()
    } finally {
      execFileSync("security", ["delete-keychain", keychain])
      await rm(root, { recursive: true, force: true })
    }
  })
})
