import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Run } from "../src/run"
import { Settings } from "../src/settings"

const base = { PLUGIN_TASK: "x", PLUGIN_BUDGET: "1", PLUGIN_TIMEOUT: "5" }

function keyDir() {
  return path.join(mkdtempSync(path.join(tmpdir(), "kete-harness-keys-")), "keys")
}

/** The `{file:...}` path a provider's apiKey references. */
function referenced(env: Record<string, string>, provider: string): string {
  const apiKey = JSON.parse(env.KETE_CONFIG_CONTENT!).providers[provider].settings.apiKey as string
  const match = /^\{file:(.+)\}$/.exec(apiKey)
  if (!match) throw new Error(`not a file reference: ${apiKey}`)
  return match[1]!
}

function noValue(env: Record<string, string>, secret: string) {
  for (const [name, value] of Object.entries(env))
    expect({ name, leaked: value.includes(secret) }).toEqual({ name, leaked: false })
}

describe("the agent's environment", () => {
  test("drops the settings, clone credentials and secret-looking variables; provider keys go to files", () => {
    const env = {
      ...base,
      PLUGIN_ANTHROPIC_API_KEY: "sk-ant-0123456789abcdef",
      DRONE_NETRC_PASSWORD: "clone-token",
      DRONE_NETRC_USERNAME: "bot",
      GITHUB_TOKEN: "ghp_x",
      AWS_SECRET_ACCESS_KEY: "aws",
      PATH: "/usr/bin",
      DRONE_BUILD_NUMBER: "7",
    }
    const settings = Settings.parse(env)
    if (settings.mode !== "run") throw new Error("run mode")
    const dir = keyDir()
    const out = Run.keteEnv(settings, env, dir)
    expect(out.PATH).toBe("/usr/bin")
    expect(out.DRONE_BUILD_NUMBER).toBe("7")
    expect(out.KETE_DISABLE_AUTOUPDATE).toBe("1")
    for (const name of [
      "ANTHROPIC_API_KEY",
      "PLUGIN_ANTHROPIC_API_KEY",
      "PLUGIN_TASK",
      "DRONE_NETRC_PASSWORD",
      "DRONE_NETRC_USERNAME",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "KETE_PLATFORM_URL",
    ])
      expect(out[name]).toBeUndefined()
    noValue(out, "sk-ant-0123456789abcdef")
    const file = referenced(out, "anthropic")
    expect(readFileSync(file, "utf8")).toBe("sk-ant-0123456789abcdef")
    expect(path.dirname(file)).toBe(dir)
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  test("the gateway key and the endpoint key are file references too; URLs stay in the environment", () => {
    const gw = Settings.parse({
      ...base,
      PLUGIN_KETE_API_KEY: "kete_k_plainvalue",
      PLUGIN_GATEWAY_URL: "https://gw.example.com",
      PLUGIN_BASE_URL: "https://app.example.com",
    })
    if (gw.mode !== "run") throw new Error("run mode")
    const gwEnv = Run.keteEnv(gw, {}, keyDir())
    expect(gwEnv).toMatchObject({
      KETE_GATEWAY_URL: "https://gw.example.com",
      KETE_PLATFORM_URL: "https://app.example.com",
    })
    expect(gwEnv.KETE_GATEWAY_KEY).toBeUndefined()
    noValue(gwEnv, "kete_k_plainvalue")
    expect(readFileSync(referenced(gwEnv, "kete"), "utf8")).toBe("kete_k_plainvalue")

    const ep = Settings.parse({
      ...base,
      PLUGIN_MODEL_URL: "http://127.0.0.1:9/v1",
      PLUGIN_MODEL: "m",
      PLUGIN_MODEL_API_KEY: "ep-key-plainvalue",
    })
    if (ep.mode !== "run") throw new Error("run mode")
    const env = Run.keteEnv(ep, {}, keyDir())
    noValue(env, "ep-key-plainvalue")
    const provider = JSON.parse(env.KETE_CONFIG_CONTENT!).providers.endpoint
    expect(provider.settings.baseURL).toBe("http://127.0.0.1:9/v1")
    expect(readFileSync(referenced(env, "endpoint"), "utf8")).toBe("ep-key-plainvalue")
    expect(env.KETE_PLATFORM_URL).toBeUndefined()
  })

  test("the output directory can't leave the workspace through a symlink", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "kete-harness-ws-"))
    const outside = mkdtempSync(path.join(tmpdir(), "kete-harness-out-"))
    symlinkSync(outside, path.join(ws, "escape"))
    expect(() => Run.outputDirectory(ws, "escape")).toThrow("inside the workspace")
    expect(Run.outputDirectory(ws, "kete-output")).toBe(path.join(realpathSync(ws), "kete-output"))
  })
})
