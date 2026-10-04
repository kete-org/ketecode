import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

const module = pathToFileURL(path.join(import.meta.dir, "../../src/global.ts")).href

// Global paths are resolved at import time, so resolve them in a fresh process.
function resolve(env: Record<string, string | undefined>) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { Global } = await import(${JSON.stringify(module)}); const p = Global.Path; console.log(JSON.stringify({ data: p.data, cache: p.cache, config: p.config, state: p.state, tmp: p.tmp, log: p.log, bin: p.bin }))`,
    ],
    env,
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString()) as Record<string, string>
}

describe("kete global paths", () => {
  test("use a kete directory under each XDG base directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kete-global-"))
    try {
      const paths = resolve({
        ...process.env,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      })
      expect(paths).toMatchObject({
        data: path.join(root, "data", "kete"),
        cache: path.join(root, "cache", "kete"),
        config: path.join(root, "config", "kete"),
        state: path.join(root, "state", "kete"),
        log: path.join(root, "data", "kete", "log"),
        bin: path.join(root, "cache", "kete", "bin"),
      })
      expect(path.basename(paths.tmp)).toBe("kete")
      for (const value of Object.values(paths)) expect(value).not.toContain("opencode")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("default to ~/.config/kete and friends without XDG variables (all platforms)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kete-home-"))
    try {
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home }
      for (const name of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]) delete env[name]
      const paths = resolve(env)
      expect(paths).toMatchObject({
        config: path.join(home, ".config", "kete"),
        data: path.join(home, ".local", "share", "kete"),
        cache: path.join(home, ".cache", "kete"),
        state: path.join(home, ".local", "state", "kete"),
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
