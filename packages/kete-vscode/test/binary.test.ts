import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executableName, resolve, targets } from "../src/binary"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function extension(platform: NodeJS.Platform, mode = 0o755) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-ext-"))
  roots.push(root)
  await mkdir(path.join(root, "bin"))
  const file = path.join(root, "bin", executableName(platform))
  await writeFile(file, "#!/bin/sh\n")
  await chmod(file, mode)
  return { root, file }
}

describe("binary resolution", () => {
  test("uses the binary bundled for the platform, never the PATH", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const { root, file } = await extension(platform)
      expect(await resolve({ extensionPath: root, platform })).toEqual({ ok: true, path: file, source: "bundled" })
    }
    expect(executableName("win32")).toBe("kete.exe")
    expect(executableName("darwin")).toBe("kete")
  })

  test("a package without a binary for this platform is an error, not a PATH lookup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-ext-"))
    roots.push(root)
    const result = await resolve({ extensionPath: root, platform: "linux" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("no kete binary for this platform")
  })

  test("restores a missing executable bit", async () => {
    if (process.platform === "win32") return
    const { root, file } = await extension("linux", 0o644)
    expect((await resolve({ extensionPath: root, platform: "linux" })).ok).toBe(true)
    expect((await stat(file)).mode & 0o111).not.toBe(0)
  })

  test("kete.cliPath overrides the bundled binary and must be an absolute path to a file", async () => {
    const { root, file } = await extension("linux")
    expect(await resolve({ extensionPath: "/nonexistent", setting: file, platform: "linux" })).toEqual({
      ok: true,
      path: file,
      source: "setting",
    })
    const relative = await resolve({ extensionPath: root, setting: "kete", platform: "linux" })
    expect(relative.ok).toBe(false)
    if (!relative.ok) expect(relative.error).toContain("absolute path")
    const missing = await resolve({ extensionPath: root, setting: path.join(root, "nope"), platform: "linux" })
    expect(missing.ok).toBe(false)
    // An empty setting means "use the bundled binary".
    expect(await resolve({ extensionPath: root, setting: "  ", platform: "linux" })).toMatchObject({ source: "bundled" })
  })

  test("each VS Code target bundles a CLI build for the same OS and architecture", () => {
    for (const [vscode, cli] of Object.entries(targets)) {
      const [os = "", arch = ""] = vscode.split("-")
      expect(cli.startsWith(os === "win32" ? "windows-" : os === "alpine" ? "linux-" : `${os}-`)).toBe(true)
      expect(cli).toContain(arch)
      if (os === "alpine") expect(cli.endsWith("-musl")).toBe(true)
    }
  })
})
