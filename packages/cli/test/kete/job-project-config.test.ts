// B1 (task 2026-10-05-unattended-secret-hygiene): which project config `kete job run` refuses, read
// from real files in a temporary repository.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteJobProjectConfig } from "../../src/kete/job-project-config"

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "kete-project-config-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function write(relative: string, content: string) {
  const file = path.join(tmp, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

describe("KeteJobProjectConfig.guardedKeys", () => {
  test("names every guarded setting", () => {
    expect(
      KeteJobProjectConfig.guardedKeys({
        providers: { openai: { options: { baseURL: "https://evil" } }, anthropic: {} },
        provider: { legacy: {} },
        mcp: { tools: { type: "local", command: ["x"] } },
        plugins: ["x"],
        plugin: ["y"],
        enterprise: { url: "https://evil" },
        share: "auto",
        autoshare: true,
        kete: { integrations: {}, platform: { url: "https://evil" }, unattended: { passEnv: ["X"] }, hooks: { Stop: [{ command: "x" }] }, budget: { session: 1 } },
      }),
    ).toEqual([
      "providers.openai",
      "providers.anthropic",
      "provider.legacy",
      "mcp.tools",
      "plugins",
      "plugin",
      "enterprise",
      "share",
      "autoshare",
      "kete.integrations",
      "kete.platform",
      "kete.unattended",
      "kete.hooks",
    ])
  })

  test("ignores settings a repository may keep: permissions, agents, instructions, formatter, kete.budget, share disabled", () => {
    expect(
      KeteJobProjectConfig.guardedKeys({
        permissions: [],
        agents: { build: {} },
        instructions: ["AGENTS.md"],
        formatter: {},
        share: "disabled",
        autoshare: false,
        kete: { budget: { session: 1 }, workflows: {} },
      }),
    ).toEqual([])
  })

  test("an empty providers or mcp object still counts", () => {
    expect(KeteJobProjectConfig.guardedKeys({ providers: {}, mcp: null })).toEqual(["providers", "mcp"])
  })
})

describe("KeteJobProjectConfig.inspect", () => {
  test("finds kete.json(c) and .kete/kete.json(c) from the run's directory up to the root", async () => {
    const top = await write("kete.jsonc", '// comment\n{ "provider": { "x": {} }, }')
    const nested = await write("app/.kete/kete.json", JSON.stringify({ mcp: { evil: {} } }))
    await write("app/kete.json", JSON.stringify({ permissions: [] }))
    const findings = await KeteJobProjectConfig.inspect(path.join(tmp, "app"), tmp)
    expect(findings).toEqual([
      { file: nested, keys: ["mcp.evil"] },
      { file: top, keys: ["provider.x"] },
    ])
  })

  test("config above the stop directory (the machine owner's) is not inspected", async () => {
    await write("kete.json", JSON.stringify({ providers: { openai: {} } }))
    await mkdir(path.join(tmp, "repo"))
    expect(await KeteJobProjectConfig.inspect(path.join(tmp, "repo"), path.join(tmp, "repo"))).toEqual([])
  })

  test("a stop directory that isn't an ancestor inspects only the run's directory", async () => {
    await write("kete.json", JSON.stringify({ providers: { openai: {} } }))
    const own = await write("a/kete.json", JSON.stringify({ mcp: { x: {} } }))
    const findings = await KeteJobProjectConfig.inspect(path.join(tmp, "a"), path.join(tmp, "b"))
    expect(findings).toEqual([{ file: own, keys: ["mcp.x"] }])
  })

  test("plugin code in .kete/plugin(s) is a finding; an empty directory isn't", async () => {
    await write(".kete/plugins/evil.ts", "export default {}")
    await mkdir(path.join(tmp, ".kete", "plugin"), { recursive: true })
    expect(await KeteJobProjectConfig.inspect(tmp, tmp)).toEqual([
      { file: path.join(tmp, ".kete", "plugins"), keys: ["plugin code"] },
    ])
  })

  test("an unparseable file fails closed", async () => {
    const file = await write(".kete/kete.jsonc", "{ not json")
    expect(await KeteJobProjectConfig.inspect(tmp, tmp)).toEqual([{ file, keys: ["could not be parsed"] }])
  })

  test("a read failure other than a missing file fails closed", async () => {
    const fs: KeteJobProjectConfig.Fs = {
      readFile: async (file) => {
        if (file.endsWith(path.join(tmp, "kete.json"))) throw Object.assign(new Error("denied"), { code: "EACCES" })
        return undefined
      },
      readDir: async () => undefined,
    }
    expect(await KeteJobProjectConfig.inspect(tmp, tmp, fs)).toEqual([
      { file: path.join(tmp, "kete.json"), keys: ["could not be read (EACCES)"] },
    ])
  })

  test("a repository without guarded settings passes", async () => {
    await write(".kete/kete.json", JSON.stringify({ permissions: [], kete: { budget: { session: 2 } } }))
    await write(".kete/agents/reviewer.md", "---\ndescription: x\n---\n")
    expect(await KeteJobProjectConfig.inspect(tmp, tmp)).toEqual([])
  })
})

describe("KeteJobProjectConfig.trusted", () => {
  test("the flag or KETE_TRUST_PROJECT_CONFIG=1 (bridged); nothing else", () => {
    expect(KeteJobProjectConfig.trusted(true, {})).toBe(true)
    expect(KeteJobProjectConfig.trusted(false, { OPENCODE_TRUST_PROJECT_CONFIG: "1" })).toBe(true)
    expect(KeteJobProjectConfig.trusted(false, { OPENCODE_TRUST_PROJECT_CONFIG: "true" })).toBe(false)
    expect(KeteJobProjectConfig.trusted(false, {})).toBe(false)
    expect(KeteJobProjectConfig.trustPublicName).toBe("KETE_TRUST_PROJECT_CONFIG")
  })
})
