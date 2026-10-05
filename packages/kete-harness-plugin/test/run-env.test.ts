import { describe, expect, test } from "bun:test"
import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Run } from "../src/run"
import { Settings } from "../src/settings"

const base = { PLUGIN_TASK: "x", PLUGIN_BUDGET: "1", PLUGIN_TIMEOUT: "5" }

describe("the agent's environment", () => {
  test("drops the settings, clone credentials and secret-looking variables", () => {
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
    const out = Run.keteEnv(settings, env)
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-0123456789abcdef")
    expect(out.PATH).toBe("/usr/bin")
    expect(out.DRONE_BUILD_NUMBER).toBe("7")
    expect(out.KETE_DISABLE_AUTOUPDATE).toBe("1")
    for (const name of [
      "PLUGIN_ANTHROPIC_API_KEY",
      "PLUGIN_TASK",
      "DRONE_NETRC_PASSWORD",
      "DRONE_NETRC_USERNAME",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ])
      expect(out[name]).toBeUndefined()
  })

  test("the gateway gets its key and URLs; an endpoint is a custom provider whose key is referenced", () => {
    const gw = Settings.parse({
      ...base,
      PLUGIN_KETE_API_KEY: "kete_k",
      PLUGIN_GATEWAY_URL: "https://gw.example.com",
      PLUGIN_BASE_URL: "https://app.example.com",
    })
    if (gw.mode !== "run") throw new Error("run mode")
    expect(Run.keteEnv(gw, {})).toMatchObject({
      KETE_GATEWAY_KEY: "kete_k",
      KETE_GATEWAY_URL: "https://gw.example.com",
      KETE_PLATFORM_URL: "https://app.example.com",
    })
    const ep = Settings.parse({
      ...base,
      PLUGIN_MODEL_URL: "http://127.0.0.1:9/v1",
      PLUGIN_MODEL: "m",
      PLUGIN_MODEL_API_KEY: "ep-key",
    })
    if (ep.mode !== "run") throw new Error("run mode")
    const env = Run.keteEnv(ep, {})
    expect(env.KETE_CONFIG_CONTENT).not.toContain("ep-key")
    expect(JSON.parse(env.KETE_CONFIG_CONTENT!).providers.endpoint.settings).toEqual({
      baseURL: "http://127.0.0.1:9/v1",
      apiKey: "{env:PIPELINE_MODEL_ENDPOINT_KEY}",
    })
    expect(env.PIPELINE_MODEL_ENDPOINT_KEY).toBe("ep-key")
  })

  test("the output directory can't leave the workspace through a symlink", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "kete-harness-ws-"))
    const outside = mkdtempSync(path.join(tmpdir(), "kete-harness-out-"))
    symlinkSync(outside, path.join(ws, "escape"))
    expect(() => Run.outputDirectory(ws, "escape")).toThrow("inside the workspace")
    expect(Run.outputDirectory(ws, "kete-output")).toBe(path.join(require("node:fs").realpathSync(ws), "kete-output"))
  })
})
