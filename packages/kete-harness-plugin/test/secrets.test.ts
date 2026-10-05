import { describe, expect, test } from "bun:test"
import { Secrets } from "../src/secrets"

// Values with no known key shape and no `name=` next to them: only literal masking catches these.
const kete = "q7Hn2pXvL9tR4mWz"
const provider = "plainprovidervalue42"
const netrc = "clonepw-a8f3k2"
const endpoint = 'ep"quoted\\value99'

const env = {
  PLUGIN_KETE_API_KEY: kete,
  PLUGIN_OPENAI_API_KEY: provider,
  PLUGIN_MODEL_API_KEY: endpoint,
  DRONE_NETRC_PASSWORD: netrc,
  PLUGIN_TASK: "Fix the failing test please",
  PLUGIN_SOMETHING_TOKEN: "short",
  PATH: "/usr/bin:/bin",
}

describe("literal secret masking", () => {
  test("every known secret value is replaced, wherever it appears", () => {
    const redact = Secrets.redactor(env)
    const text = `token ${kete} then (${provider}) and ${netrc}/${endpoint} done`
    expect(redact(text)).toBe("token [REDACTED] then ([REDACTED]) and [REDACTED]/[REDACTED] done")
  })

  test("JSON-escaped forms are masked too, and settings that aren't secrets are left alone", () => {
    const redact = Secrets.redactor(env)
    const json = JSON.stringify({ text: `the key is ${endpoint}`, task: env.PLUGIN_TASK })
    expect(redact(json)).not.toContain("quoted")
    expect(redact(json)).toContain("Fix the failing test please")
    expect(Secrets.json({ text: `got ${provider}` }, redact)).not.toContain(provider)
  })

  test("short values aren't masked literally; shapes still are", () => {
    const redact = Secrets.redactor(env)
    expect(redact("a short word")).toBe("a short word")
    expect(redact("key sk-abcdefghijklmnopqrstu")).toBe("key [REDACTED]")
  })

  test("what counts as a secret setting", () => {
    expect(Secrets.isSecret("PLUGIN_KETE_API_KEY")).toBe(true)
    expect(Secrets.isSecret("PLUGIN_ANTHROPIC_API_KEY")).toBe(true)
    expect(Secrets.isSecret("PLUGIN_SOME_FUTURE_KEY")).toBe(true)
    expect(Secrets.isSecret("PLUGIN_DEPLOY_TOKEN")).toBe(true)
    expect(Secrets.isSecret("DRONE_NETRC_PASSWORD")).toBe(true)
    expect(Secrets.isSecret("PLUGIN_TASK")).toBe(false)
    expect(Secrets.isSecret("PATH")).toBe(false)
  })
})
