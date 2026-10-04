// Public distribution (ADR 0009): the public file set, the Homebrew formula, the npm packages, and
// install.sh end to end against a local release server (checksum-only mode, since tests can't make a
// Sigstore signature; the fail-closed paths are covered).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ReleaseVerify } from "../../cli/src/kete/release-verify"
import { homebrewFormula, npmManifests, npmPlatforms, publicFiles, readPublic, releaseNotes } from "../src/distribute"
import { checksums } from "../src/release"

const version = "0.3.0"
let root: string
let releaseDir: string

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

function sh(cmd: string[], cwd: string) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`)
}

/** A release directory like `release` builds: every target's archive (a fake kete), a .vsix, SHA256SUMS. */
function buildRelease(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  for (const target of ReleaseVerify.targets) {
    const staging = fs.mkdtempSync(path.join(root, "stage-"))
    const member = target.startsWith("windows-") ? "kete.exe" : "kete"
    fs.writeFileSync(path.join(staging, member), `#!/bin/sh\necho "kete v${version} ${target}"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(staging, "LICENSE"), "MIT")
    fs.writeFileSync(path.join(staging, "NOTICE"), "OpenCode")
    const name = ReleaseVerify.archiveName(version, target)
    sh(
      name.endsWith(".tar.gz")
        ? ["tar", "-czf", path.join(dir, name), member, "LICENSE", "NOTICE"]
        : ["zip", "-q", path.join(dir, name), member, "LICENSE", "NOTICE"],
      staging,
    )
  }
  fs.writeFileSync(path.join(dir, `kete-code-${version}-linux-x64.vsix`), "vsix")
  const files = fs
    .readdirSync(dir)
    .map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, name))) }))
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), checksums(files) + "\n")
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kete-distribute-"))
  releaseDir = path.join(root, "release")
  buildRelease(releaseDir)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writePublic(dir: string) {
  const { files } = publicFiles(releaseDir)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) fs.writeFileSync(path.join(dir, file.name), file.bytes)
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), checksums(files) + "\n")
  return files
}

describe("public file set", () => {
  test("every CLI archive and both install scripts; never a .vsix", async () => {
    const { version: v, files } = publicFiles(releaseDir)
    expect(v).toBe(version)
    const names = files.map((file) => file.name)
    expect(names).toHaveLength(ReleaseVerify.targets.length + 2)
    expect(names).toContain("install.sh")
    expect(names).toContain("install.ps1")
    expect(names.some((name) => name.endsWith(".vsix"))).toBe(false)
  })

  test("refuses an archive that doesn't match the release's SHA256SUMS, or a missing target", async () => {
    const dir = path.join(root, "tampered")
    fs.cpSync(releaseDir, dir, { recursive: true })
    fs.appendFileSync(path.join(dir, ReleaseVerify.archiveName(version, "linux-x64")), "evil")
    expect(() => publicFiles(dir)).toThrow("doesn't match")

    const partial = path.join(root, "partial")
    fs.cpSync(releaseDir, partial, { recursive: true })
    const sums = fs
      .readFileSync(path.join(partial, "SHA256SUMS"), "utf8")
      .split("\n")
      .filter((line) => !line.includes("windows-arm64"))
    fs.writeFileSync(path.join(partial, "SHA256SUMS"), sums.join("\n"))
    expect(() => publicFiles(partial)).toThrow("windows-arm64")
    expect(publicFiles(partial, { partial: true }).files).toHaveLength(ReleaseVerify.targets.length + 1)
  })

  test("a public directory's SHA256SUMS describes the release", async () => {
    const dir = path.join(root, "public-read")
    writePublic(dir)
    expect(readPublic(dir).version).toBe(version)
    fs.appendFileSync(path.join(dir, "install.sh"), "\n# tampered")
    expect(() => readPublic(dir)).toThrow("install.sh doesn't match")
  })
})

describe("Homebrew formula", () => {
  test("per-platform urls and checksums from the public release", async () => {
    const dir = path.join(root, "public-brew")
    writePublic(dir)
    const release = readPublic(dir)
    const formula = homebrewFormula(release)
    expect(formula).toContain("class Kete < Formula")
    expect(formula).toContain(`version "${version}"`)
    for (const target of ["darwin-arm64", "darwin-x64-baseline", "linux-arm64", "linux-x64-baseline"] as const) {
      const archive = release.archives.get(target)!
      expect(formula).toContain(
        `url "https://github.com/kete-org/kete-releases/releases/download/kete-v${version}/${archive.name}"`,
      )
      expect(formula).toContain(`sha256 "${archive.sha256}"`)
    }
    expect(formula).not.toMatch(/opencode/i)
  })
})

describe("npm packages", () => {
  test("a launcher with one optional dependency per platform, selected by os, cpu and libc", async () => {
    const packages = npmManifests(version)
    const launcher = packages.at(-1)!.manifest
    expect(launcher.name).toBe("@ketecode/cli")
    expect(launcher.bin).toEqual({ kete: "bin/kete.js" })
    expect(Object.keys(launcher.optionalDependencies as object).sort()).toEqual(
      npmPlatforms.map((platform) => `@ketecode/cli-${platform.suffix}`).sort(),
    )
    const musl = packages.find((pkg) => pkg.manifest.name === "@ketecode/cli-linux-x64-musl")!.manifest
    expect(musl).toMatchObject({ os: ["linux"], cpu: ["x64"], libc: ["musl"], version })
    expect(packages.find((pkg) => pkg.manifest.name === "@ketecode/cli-darwin-arm64")!.manifest.libc).toBeUndefined()
    expect(launcher.repository).toBeUndefined()
    expect(
      npmManifests(version, { repository: "git+https://example.test/repo.git" }).at(-1)!.manifest.repository,
    ).toEqual({
      type: "git",
      url: "git+https://example.test/repo.git",
    })
  })

  test("distribute npm unpacks each platform's binary", async () => {
    const dir = path.join(root, "public-npm")
    writePublic(dir)
    const out = path.join(root, "npm")
    const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "../src/distribute.ts"), "npm", dir, out], {
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(fs.readFileSync(path.join(out, "cli-linux-x64/bin/kete"), "utf8")).toContain("linux-x64-baseline")
    expect(fs.readFileSync(path.join(out, "cli-windows-x64/bin/kete.exe"), "utf8")).toContain("windows-x64-baseline")
    expect(fs.existsSync(path.join(out, "cli/bin/kete.js"))).toBe(true)
    expect(fs.existsSync(path.join(out, "cli/LICENSE")) && fs.existsSync(path.join(out, "cli/NOTICE"))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(out, "cli/package.json"), "utf8")).version).toBe(version)
  })

  test("release notes name the version and the signing identity", async () => {
    const notes = releaseNotes(version)
    expect(notes).toContain(`kete-release.yml@refs/tags/kete-v${version}`)
    expect(notes).not.toMatch(/opencode/i)
  })
})

describe.skipIf(process.platform === "win32")("install.sh", () => {
  let server: ReturnType<typeof Bun.serve>
  let publicDir: string
  let overrides: Map<string, string>

  beforeAll(() => {
    publicDir = path.join(root, "public-install")
    writePublic(publicDir)
    overrides = new Map()
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const pathname = new URL(request.url).pathname
        const override = overrides.get(pathname)
        if (override !== undefined) return new Response(override)
        const latest = pathname.match(/^\/releases\/latest\/download\/(.+)$/)
        const tagged = pathname.match(new RegExp(`^/releases/download/kete-v${version.replaceAll(".", "\\.")}/(.+)$`))
        const name = latest?.[1] ?? tagged?.[1]
        if (!name || !fs.existsSync(path.join(publicDir, name))) return new Response("not found", { status: 404 })
        return new Response(Bun.file(path.join(publicDir, name)))
      },
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  // Async: a synchronous spawn would block this process's event loop, and with it the server.
  async function install(args: string[], env: Record<string, string> = {}) {
    const home = fs.mkdtempSync(path.join(root, "home-"))
    const child = Bun.spawn(
      [Bun.which("sh") ?? "/bin/sh", path.join(import.meta.dir, "../distribution/install.sh"), ...args],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          KETE_RELEASES_URL: `http://127.0.0.1:${server.port}`,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { home, code, output: stdout + stderr }
  }

  test("installs the latest release into ~/.local/bin with --checksum-only, and warns", async () => {
    const result = await install(["--checksum-only"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("signature on SHA256SUMS is NOT verified")
    const binary = path.join(result.home, ".local/bin/kete")
    expect(fs.statSync(binary).mode & 0o111).not.toBe(0)
    expect(fs.readFileSync(binary, "utf8")).toContain(`kete v${version}`)
  })

  test("without cosign it refuses to install unless asked for checksum-only", async () => {
    const empty = fs.mkdtempSync(path.join(root, "nocosign-"))
    // Only the tools the script needs, so a cosign elsewhere on the developer's PATH can't be found.
    for (const tool of ["uname", "grep", "sed", "head", "mktemp", "rm", "curl", "sysctl", "ldd", "cut", "awk"]) {
      const found = Bun.which(tool)
      if (found) fs.symlinkSync(found, path.join(empty, tool))
    }
    const result = await install([], { PATH: empty })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("is required to verify the release signature")
    expect(fs.existsSync(path.join(result.home, ".local/bin/kete"))).toBe(false)
  })

  test("a tampered SHA256SUMS entry fails the checksum and installs nothing", async () => {
    const sums = fs.readFileSync(path.join(publicDir, "SHA256SUMS"), "utf8")
    overrides.set(`/releases/download/kete-v${version}/SHA256SUMS`, sums.replace(/^[0-9a-f]{64}/gm, "0".repeat(64)))
    try {
      const result = await install(["--checksum-only", "--version", version])
      expect(result.code).not.toBe(0)
      expect(result.output).toContain("checksum mismatch")
      expect(fs.existsSync(path.join(result.home, ".local/bin/kete"))).toBe(false)
    } finally {
      overrides.clear()
    }
  })

  test("rejects a non-https releases URL and a malformed version", async () => {
    expect((await install(["--checksum-only"], { KETE_RELEASES_URL: "http://example.test" })).output).toContain(
      "must be an https:// URL",
    )
    expect((await install(["--checksum-only", "--version", "1.0"])).output).toContain("not a release version")
  })

  test("KETE_VERSION picks the version (a leading v is fine); --version wins over it", async () => {
    const fromEnv = await install(["--checksum-only"], { KETE_VERSION: `v${version}` })
    expect(fromEnv.code, fromEnv.output).toBe(0)
    expect(fromEnv.output).toContain(`Installing Kete Code ${version}`)
    const flagWins = await install(["--checksum-only", "--version", version], { KETE_VERSION: "1.0" })
    expect(flagWins.code, flagWins.output).toBe(0)
    expect((await install(["--checksum-only"], { KETE_VERSION: "1.0" })).output).toContain("not a release version")
  })

  test("a custom --install-dir, with a PATH hint", async () => {
    const dir = path.join(root, "custom-bin")
    const result = await install(["--checksum-only", "--install-dir", dir])
    expect(result.code, result.output).toBe(0)
    expect(fs.existsSync(path.join(dir, "kete"))).toBe(true)
    expect(result.output).toContain("is not on your PATH")
  })

  test("sha256 of the served archive matches what install.sh verified", async () => {
    const name = fs.readdirSync(publicDir).find((file) => file.endsWith("linux-x64.tar.gz"))!
    const sums = ReleaseVerify.parseChecksums(fs.readFileSync(path.join(publicDir, "SHA256SUMS"), "utf8"))
    expect(sums.get(name)).toBe(sha256(new Uint8Array(fs.readFileSync(path.join(publicDir, name)))))
  })
})

describe("signed public release", () => {
  test("verify accepts a release signed by a pinned key and nothing else", async () => {
    const crypto = await import("node:crypto")
    const { verifySigned } = await import("../src/distribute")
    const dir = path.join(root, "public-signed")
    writePublic(dir)
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    const pinned = {
      id: "test",
      publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
    }
    const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"))
    fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), crypto.sign(null, sums, privateKey))
    expect(verifySigned(dir, [pinned]).version).toBe(version)
    expect(() => verifySigned(dir, [])).toThrow("No update signing key")
    fs.writeFileSync(path.join(dir, "extra.txt"), "unlisted")
    expect(() => verifySigned(dir, [pinned])).toThrow("not covered by SHA256SUMS: extra.txt")
    fs.rmSync(path.join(dir, "extra.txt"))
    fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), crypto.sign(null, Buffer.from("other"), privateKey))
    expect(() => verifySigned(dir, [pinned])).toThrow("does not verify")
  })
})
