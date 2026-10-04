// End-to-end checks of the kete CLI entry point: help and version output,
// the KETE_* environment bridge, upgrade from a source build, and the disabled uninstall command.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kete-cli-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

// A clean environment rooted in `root`: no inherited KETE_* or OPENCODE_* values.
function environment(overrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (/^(KETE|OPENCODE)_/i.test(name)) delete env[name]
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}

async function cli(args: string[], env = environment()) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../../src/index.ts"), ...args], {
    // Run from the package so Bun picks up its tsconfig (JSX runtime).
    cwd: path.join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function parsePaths(stdout: string) {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2)),
  )
}

describe("kete cli", () => {
  test("--help names the kete command and Kete Code, never OpenCode", async () => {
    const result = await cli(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("kete")
    expect(result.stdout).toContain("Kete Code")
    expect(result.stdout).not.toMatch(/opencode/i)
  })

  test("--version prints a version", async () => {
    const result = await cli(["--version"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).not.toBe("")
    expect(result.stdout).not.toMatch(/opencode/i)
  })

  test("resolves global paths under kete directories", async () => {
    const result = await cli(["debug", "paths"])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(parsePaths(result.stdout)).toMatchObject({
      config: path.join(root, "config", "kete"),
      data: path.join(root, "data", "kete"),
      cache: path.join(root, "cache", "kete"),
      state: path.join(root, "state", "kete"),
    })
  })

  test("reads KETE_CONFIG_DIR", async () => {
    const custom = path.join(root, "custom-config")
    const result = await cli(["debug", "paths"], environment({ KETE_CONFIG_DIR: custom }))
    expect(result.exitCode, result.stderr).toBe(0)
    expect(parsePaths(result.stdout).config).toBe(custom)
  })

  test("ignores OPENCODE_CONFIG_DIR", async () => {
    const result = await cli(
      ["debug", "paths"],
      environment({ OPENCODE_CONFIG_DIR: path.join(root, "opencode-config") }),
    )
    expect(result.exitCode, result.stderr).toBe(0)
    expect(parsePaths(result.stdout).config).toBe(path.join(root, "config", "kete"))
  })

  test("upgrade from a source build changes nothing and says why", async () => {
    const result = await cli(["upgrade"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("source checkout or a local build, which doesn't update itself")
    expect(result.stdout + result.stderr).not.toMatch(/opencode/i)
  })

  test("update (alias) refuses a --method that doesn't match the install", async () => {
    const result = await cli(["update", "9.9.9", "--method", "npm"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("wasn't installed with npm")
  })

  test("uninstall is disabled and deletes nothing", async () => {
    const config = path.join(root, "config", "kete")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(path.join(config, "kete.json"), "{}")
    const result = await cli(["uninstall", "--force"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("not yet available")
    expect(await Bun.file(path.join(config, "kete.json")).exists()).toBe(true)
  })
})
