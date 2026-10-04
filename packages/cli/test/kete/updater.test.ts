// The verified updater (ADR 0009) against an in-memory release server: real Ed25519 signatures, real
// tar.gz archives (system tar), real files. Covers tampered checksums, signatures and archives,
// downgrade refusal, interrupted replacement, and package-manager installs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { KeteUpdater, UpdateError, type Deps } from "../../src/kete/updater"
import { ReleaseVerify, type PinnedKey } from "../../src/kete/release-verify"

const releases = "https://releases.example.test/kete-org/kete-releases"

let root: string
let bin: string
let executable: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kete-updater-"))
  bin = path.join(root, "bin")
  await fs.mkdir(bin)
  executable = path.join(bin, "kete")
  await fs.writeFile(executable, "old binary", { mode: 0o755 })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function keyPair(id = "test") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const pinned: PinnedKey = {
    id,
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
  }
  return { pinned, privateKey }
}

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex")

/** A real kete-<version>-linux-x64.tar.gz holding a `kete` whose contents name the version. */
async function archive(version: string) {
  const staging = await fs.mkdtemp(path.join(root, "archive-"))
  await fs.writeFile(path.join(staging, "kete"), `new binary ${version}`, { mode: 0o755 })
  await fs.writeFile(path.join(staging, "LICENSE"), "MIT")
  const file = path.join(staging, "out.tar.gz")
  const tar = Bun.spawnSync(["tar", "-czf", file, "kete", "LICENSE"], { cwd: staging })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Uint8Array(await fs.readFile(file))
}

type Server = Map<string, Uint8Array | number>

/** Publishes a signed release at its tag URL (and as latest when `latest`). */
async function publish(
  server: Server,
  key: ReturnType<typeof keyPair>,
  version: string,
  options: { latest?: boolean } = {},
) {
  const bytes = await archive(version)
  const name = ReleaseVerify.archiveName(version, "linux-x64")
  const checksums = Buffer.from(`${sha256(bytes)}  ${name}\n${sha256(Buffer.from("script"))}  install.sh\n`)
  const signature = crypto.sign(null, checksums, key.privateKey)
  const base = `${releases}/releases/download/kete-v${version}`
  server.set(`${base}/${name}`, bytes)
  server.set(`${base}/SHA256SUMS`, checksums)
  server.set(`${base}/SHA256SUMS.sig`, signature)
  if (options.latest) {
    server.set(`${releases}/releases/latest/download/SHA256SUMS`, checksums)
    server.set(`${releases}/releases/latest/download/SHA256SUMS.sig`, signature)
  }
  return { base, name, checksums, signature }
}

function deps(server: Server, keys: readonly PinnedKey[], overrides: Partial<Deps> = {}) {
  const requests: string[] = []
  const value: Deps = {
    releases,
    keys,
    version: "0.2.0",
    channel: "latest",
    target: "linux-x64",
    execPath: executable,
    platform: "linux",
    fetch: async (url) => {
      requests.push(url)
      const body = server.get(url)
      if (body === undefined) return new Response("not found", { status: 404 })
      if (typeof body === "number") return new Response("error", { status: body })
      return new Response(Buffer.from(body))
    },
    extract: async (file, member, directory, signal) => {
      const tar = Bun.spawn(["tar", "-xf", file, "-C", directory, member], { signal, stderr: "pipe" })
      if ((await tar.exited) !== 0) throw new Error(await new Response(tar.stderr).text())
    },
    probe: async (binary) => `kete v${(await fs.readFile(binary, "utf8")).replace("new binary ", "")}`,
    rename: (from, to) => fs.rename(from, to),
    ...overrides,
  }
  return { deps: value, requests }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof UpdateError) return error
    throw error
  }
  throw new Error("expected an UpdateError")
}

async function leftovers() {
  return (await fs.readdir(bin)).filter((name) => name !== "kete")
}

describe("kete updater: install", () => {
  test("installs a newer signed release over the binary", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    await KeteUpdater.install(deps(server, [key.pinned]).deps, "0.3.0")
    expect(await fs.readFile(executable, "utf8")).toBe("new binary 0.3.0")
    expect((await fs.stat(executable)).mode & 0o111).not.toBe(0)
    expect(await leftovers()).toEqual([])
  })

  test("tampered SHA256SUMS: the signature fails and nothing is downloaded or replaced", async () => {
    const key = keyPair()
    const server: Server = new Map()
    const published = await publish(server, key, "0.3.0")
    server.set(
      `${published.base}/SHA256SUMS`,
      Buffer.from(published.checksums.toString().replace(/^[0-9a-f]{8}/, "00000000")),
    )
    const { deps: d, requests } = deps(server, [key.pinned])
    const error = await failure(KeteUpdater.install(d, "0.3.0"))
    expect(error.code).toBe("verify")
    expect(error.message).toContain("does not verify")
    expect(requests.some((url) => url.endsWith(".tar.gz"))).toBe(false)
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")
    expect(await leftovers()).toEqual([])
  })

  test("a signature from an unpinned key fails", async () => {
    const key = keyPair()
    const attacker = keyPair("attacker")
    const server: Server = new Map()
    await publish(server, attacker, "0.3.0")
    const error = await failure(KeteUpdater.install(deps(server, [key.pinned]).deps, "0.3.0"))
    expect(error.code).toBe("verify")
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")
  })

  test("a tampered archive fails its checksum and leaves no staged files", async () => {
    const key = keyPair()
    const server: Server = new Map()
    const published = await publish(server, key, "0.3.0")
    server.set(`${published.base}/${published.name}`, await archive("9.9.9"))
    const error = await failure(KeteUpdater.install(deps(server, [key.pinned]).deps, "0.3.0"))
    expect(error.code).toBe("verify")
    expect(error.message).toContain("doesn't match the signed SHA256SUMS")
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")
    expect(await leftovers()).toEqual([])
  })

  test("a genuine but different release replayed at the requested URL is refused", async () => {
    const key = keyPair()
    const server: Server = new Map()
    const older = await publish(server, key, "0.2.5")
    const base = `${releases}/releases/download/kete-v0.3.0`
    server.set(`${base}/SHA256SUMS`, older.checksums)
    server.set(`${base}/SHA256SUMS.sig`, older.signature)
    const error = await failure(KeteUpdater.install(deps(server, [key.pinned]).deps, "0.3.0"))
    expect(error.code).toBe("verify")
    expect(error.message).toContain("describes version 0.2.5")
  })

  test("refuses downgrades and reinstalls without fetching anything", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.1.0")
    const { deps: d, requests } = deps(server, [key.pinned])
    expect((await failure(KeteUpdater.install(d, "0.1.0"))).code).toBe("downgrade")
    expect((await failure(KeteUpdater.install(d, "0.2.0-rc.1"))).code).toBe("downgrade")
    expect((await failure(KeteUpdater.install(d, "0.2.0"))).code).toBe("current")
    expect((await failure(KeteUpdater.install(d, "latest"))).code).toBe("invalid")
    expect(requests).toEqual([])
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")
  })

  test("no pinned key: updates are unavailable", async () => {
    const error = await failure(KeteUpdater.install(deps(new Map(), []).deps, "0.3.0"))
    expect(error.code).toBe("unavailable")
  })

  test("a release without this target's build", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const error = await failure(
      KeteUpdater.install(deps(server, [key.pinned], { target: "linux-arm64" }).deps, "0.3.0"),
    )
    expect(error.code).toBe("platform")
  })

  test("a new binary that doesn't run (or reports another version) is not installed", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const crashed = await failure(
      KeteUpdater.install(
        deps(server, [key.pinned], {
          probe: async () => {
            throw new Error("Illegal instruction")
          },
        }).deps,
        "0.3.0",
      ),
    )
    expect(crashed.code).toBe("verify")
    const wrong = await failure(
      KeteUpdater.install(deps(server, [key.pinned], { probe: async () => "kete v0.2.0" }).deps, "0.3.0"),
    )
    expect(wrong.code).toBe("verify")
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")
    expect(await leftovers()).toEqual([])
  })

  test("an interrupted replace keeps the old binary", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const rename = async () => {
      throw Object.assign(new Error("EIO: power lost"), { code: "EIO" })
    }
    await expect(KeteUpdater.install(deps(server, [key.pinned], { rename }).deps, "0.3.0")).rejects.toThrow(
      "power lost",
    )
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")
    expect(await leftovers()).toEqual([])
  })

  test("Windows: a failed swap puts the running binary back", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const exe = path.join(bin, "kete.exe")
    await fs.rename(executable, exe)
    const renames: string[] = []
    const rename = async (from: string, to: string) => {
      renames.push(`${path.basename(from)} -> ${path.basename(to)}`)
      // The second rename (new binary into place) fails, as when antivirus holds the file.
      if (renames.length === 2) throw new Error("EBUSY")
      await fs.rename(from, to)
    }
    // The archive is tar.gz here; only the member name and the swap differ on Windows.
    const extract = async (_file: string, member: string, directory: string) => {
      await fs.writeFile(path.join(directory, member), "new binary 0.3.0")
    }
    await expect(
      KeteUpdater.install(
        deps(server, [key.pinned], { platform: "win32", execPath: exe, rename, extract }).deps,
        "0.3.0",
      ),
    ).rejects.toThrow("EBUSY")
    expect(renames).toHaveLength(3)
    expect(renames[2]).toMatch(/^kete\.exe\.[0-9a-f]{8}\.old -> kete\.exe$/)
    expect(await fs.readFile(exe, "utf8")).toBe("old binary")
    expect((await fs.readdir(bin)).filter((name) => name !== "kete.exe")).toEqual([])
  })

  test("Windows: a failed rollback says where the previous binary is", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const exe = path.join(bin, "kete.exe")
    await fs.rename(executable, exe)
    let calls = 0
    const rename = async (from: string, to: string) => {
      calls++
      if (calls >= 2) throw new Error("EBUSY")
      await fs.rename(from, to)
    }
    const extract = async (_file: string, member: string, directory: string) => {
      await fs.writeFile(path.join(directory, member), "new binary 0.3.0")
    }
    const error = await failure(
      KeteUpdater.install(
        deps(server, [key.pinned], { platform: "win32", execPath: exe, rename, extract }).deps,
        "0.3.0",
      ),
    )
    expect(error.message).toMatch(/couldn't be put back: it is at .*kete\.exe\.[0-9a-f]{8}\.old/)
  })

  test("an oversized SHA256SUMS is refused without buffering it all", async () => {
    const key = keyPair()
    const server: Server = new Map()
    const published = await publish(server, key, "0.3.0")
    server.set(`${published.base}/SHA256SUMS`, new Uint8Array(200 * 1024))
    const error = await failure(KeteUpdater.install(deps(server, [key.pinned]).deps, "0.3.0"))
    expect(error.message).toContain("larger than expected")
  })

  test("a probe reporting a longer version doesn't count as a match", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const error = await failure(
      KeteUpdater.install(deps(server, [key.pinned], { probe: async () => "kete v10.3.0" }).deps, "0.3.0"),
    )
    expect(error.code).toBe("verify")
  })

  test("Windows: a successful swap renames the running binary aside, then removes it", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0")
    const exe = path.join(bin, "kete.exe")
    await fs.rename(executable, exe)
    await fs.writeFile(path.join(bin, "kete.exe.deadbeef.old"), "stale")
    const extract = async (_file: string, member: string, directory: string) => {
      await fs.writeFile(path.join(directory, member), "new binary 0.3.0")
    }
    await KeteUpdater.install(deps(server, [key.pinned], { platform: "win32", execPath: exe, extract }).deps, "0.3.0")
    expect(await fs.readFile(exe, "utf8")).toBe("new binary 0.3.0")
    expect(await fs.readdir(bin)).toEqual(["kete.exe"])
  })
})

describe("kete updater: install detection", () => {
  const detect = (execPath: string, channel = "latest", version = "0.2.0") =>
    KeteUpdater.detect({ execPath, channel, version })

  test("package managers, the extension and source builds are not replaced", async () => {
    expect((await detect("/opt/homebrew/Cellar/kete/0.2.0/bin/kete")).kind).toBe("homebrew")
    expect((await detect("/home/linuxbrew/.linuxbrew/Cellar/kete/0.2.0/bin/kete")).kind).toBe("homebrew")
    expect((await detect("/usr/lib/node_modules/@ketecode/cli-linux-x64/bin/kete")).kind).toBe("npm")
    expect(
      (await detect("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@ketecode\\cli-windows-x64\\bin\\kete.exe"))
        .kind,
    ).toBe("npm")
    expect((await detect("/home/me/.vscode/extensions/ketecode.kete-code-0.2.0-linux-x64/bin/kete")).kind).toBe(
      "extension",
    )
    expect((await detect(executable, "local")).kind).toBe("source")
    expect((await detect(executable, "latest", "local")).kind).toBe("source")
    expect(await detect(executable)).toEqual({ kind: "direct", executable: await fs.realpath(executable) })
  })

  test("a package-manager install refuses to self-replace", async () => {
    const key = keyPair()
    const error = await failure(
      KeteUpdater.install(
        deps(new Map(), [key.pinned], { execPath: "/opt/homebrew/Cellar/kete/0.2.0/bin/kete" }).deps,
        "0.3.0",
      ),
    )
    expect(error.code).toBe("managed")
    expect(error.message).toContain("brew upgrade kete")
  })
})

describe("kete updater: service", () => {
  const service = (d: Deps) => KeteUpdater.make(d, path.join(root, "config"))

  test("check and latest read the signed latest release", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0", { latest: true })
    const updater = service(deps(server, [key.pinned]).deps)
    expect(await Effect.runPromise(updater.latest())).toBe("0.3.0")
    expect(await Effect.runPromise(updater.check())).toEqual({ type: "available", version: "0.3.0" })
    expect(await Effect.runPromise(updater.method())).toBe("curl")
  })

  test("an unsigned latest is an error, not an update", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, keyPair("attacker"), "0.3.0", { latest: true })
    const exit = await Effect.runPromiseExit(service(deps(server, [key.pinned]).deps).check())
    expect(exit._tag).toBe("Failure")
  })

  test("an older or equal latest is no update", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.1.0", { latest: true })
    expect(await Effect.runPromise(service(deps(server, [key.pinned]).deps).check())).toBeUndefined()
  })

  test("no pinned key: check reports unavailable and the background check stays silent", async () => {
    const { deps: d, requests } = deps(new Map(), [])
    const updater = service(d)
    expect(await Effect.runPromise(updater.check())).toEqual({
      type: "unavailable",
      message: expect.stringContaining("no pinned update signing key"),
    })
    expect(await Effect.runPromise(updater.run())).toBeUndefined()
    expect(requests).toEqual([])
  })

  test("background check: notify by default, auto installs only a direct install", async () => {
    const key = keyPair()
    const server: Server = new Map()
    await publish(server, key, "0.3.0", { latest: true })
    expect(await Effect.runPromise(service(deps(server, [key.pinned]).deps).run())).toEqual({
      type: "available",
      version: "0.3.0",
    })
    expect(await fs.readFile(executable, "utf8")).toBe("old binary")

    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "kete.json"), JSON.stringify({ autoupdate: true }))
    const brew = deps(server, [key.pinned], { execPath: "/opt/homebrew/Cellar/kete/0.2.0/bin/kete" }).deps
    expect(await Effect.runPromise(service(brew).run())).toEqual({ type: "available", version: "0.3.0" })

    const installing: string[] = []
    expect(await Effect.runPromise(service(deps(server, [key.pinned]).deps).run((v) => installing.push(v)))).toEqual({
      type: "installed",
      version: "0.3.0",
    })
    expect(installing).toEqual(["0.3.0"])
    expect(await fs.readFile(executable, "utf8")).toBe("new binary 0.3.0")
  })

  test("background check: disabled by policy, and silent on failure", async () => {
    const key = keyPair()
    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "kete.json"), JSON.stringify({ autoupdate: false }))
    const { deps: d, requests } = deps(new Map(), [key.pinned])
    expect(await Effect.runPromise(service(d).run())).toBeUndefined()
    expect(requests).toEqual([])
    await fs.rm(path.join(root, "config", "kete.json"))
    expect(await Effect.runPromise(service(d).run())).toBeUndefined()
    expect(requests.length).toBeGreaterThan(0)
  })

  test("upgrade through a package manager's method is refused with its command", async () => {
    const key = keyPair()
    const error = await Effect.runPromise(
      Effect.flip(service(deps(new Map(), [key.pinned]).deps).upgrade("npm", "0.3.0")),
    )
    expect(error.message).toContain("npm install -g @ketecode/cli@latest")
  })
})
