import { describe, expect, test } from "bun:test"
import { KeteEnv } from "../../src/kete/env.js"

describe("KeteEnv.bridge", () => {
  test("maps KETE_* to the internal OPENCODE_* names", () => {
    const env: KeteEnv.Environment = { KETE_CONFIG_DIR: "/tmp/kete-config", KETE_PASSWORD: "secret", PATH: "/bin" }
    KeteEnv.bridge(env)
    expect(env).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/kete-config",
      OPENCODE_PASSWORD: "secret",
      PATH: "/bin",
      [KeteEnv.marker]: "1",
    })
  })

  test("ignores OPENCODE_* variables inherited from outside Kete Code", () => {
    const env: KeteEnv.Environment = {
      OPENCODE_CONFIG_DIR: "/home/user/.config/opencode",
      OPENCODE_CONFIG_CONTENT: '{"shell":"opencode"}',
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    }
    KeteEnv.bridge(env)
    expect(env).toEqual({ [KeteEnv.marker]: "1" })
  })

  test("KETE_* wins over a same-named OPENCODE_* variable from outside", () => {
    const env: KeteEnv.Environment = { OPENCODE_CONFIG: "/opencode.json", KETE_CONFIG: "/kete.json" }
    KeteEnv.bridge(env)
    expect(env.OPENCODE_CONFIG).toBe("/kete.json")
    expect(env.KETE_CONFIG).toBeUndefined()
  })

  test("treats OPENCODE_* case-insensitively (Windows environment names)", () => {
    const env: KeteEnv.Environment = { Opencode_Config_Dir: "/x", kete_log_level: "DEBUG" }
    KeteEnv.bridge(env)
    expect(env).toEqual({ OPENCODE_LOG_LEVEL: "DEBUG", [KeteEnv.marker]: "1" })
  })

  test("children of a bridged process keep the values the runtime handed them", () => {
    // What a Kete parent passes to a child it starts: its bridged env plus a
    // child-specific credential (the standalone server lease password).
    const parent: KeteEnv.Environment = { KETE_CONFIG_DIR: "/cfg", KETE_PASSWORD: "user" }
    KeteEnv.bridge(parent)
    const child: KeteEnv.Environment = { ...parent, OPENCODE_PASSWORD: "lease", OPENCODE_PTY_HANDOFF: "{}" }
    KeteEnv.bridge(child)
    expect(child.OPENCODE_PASSWORD).toBe("lease")
    expect(child.OPENCODE_PTY_HANDOFF).toBe("{}")
    expect(child.OPENCODE_CONFIG_DIR).toBe("/cfg")
  })

  test("an explicit KETE_* override still applies in a child", () => {
    const child: KeteEnv.Environment = {
      [KeteEnv.marker]: "1",
      OPENCODE_CONFIG_DIR: "/inherited",
      KETE_CONFIG_DIR: "/explicit",
    }
    KeteEnv.bridge(child)
    expect(child.OPENCODE_CONFIG_DIR).toBe("/explicit")
  })

  test("is idempotent", () => {
    const env: KeteEnv.Environment = { KETE_DB: ":memory:", OPENCODE_DB: "/elsewhere.db" }
    KeteEnv.bridge(env)
    const once = { ...env }
    KeteEnv.bridge(env)
    expect(env).toEqual(once)
  })

  test("publicName reports the user-facing variable", () => {
    expect(KeteEnv.publicName("OPENCODE_PASSWORD")).toBe("KETE_PASSWORD")
    expect(KeteEnv.publicName("PATH")).toBe("PATH")
  })
})
