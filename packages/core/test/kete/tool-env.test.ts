// KeteToolEnv's pure rules (task 2026-10-05-unattended-secret-hygiene, A1): which names are removed
// always, which only in an unattended run, `passEnv`, Windows case-insensitivity (AC4), and the
// models.dev snapshot's credential names (AC5).
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Option } from "effect"
import snapshotText from "../../src/models-dev/snapshot.txt" with { type: "text" }
import { KeteToolEnv } from "@opencode/core/kete/tool-env"
import { Session } from "@opencode/core/session"
import type { SessionSchema } from "@opencode/core/session/schema"

describe("KeteToolEnv.filter", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    ANTHROPIC_API_KEY: "a",
    GITHUB_TOKEN: "b",
    AWS_ACCESS_KEY_ID: "c",
    AWS_SECRET_ACCESS_KEY: "d",
    AWS_REGION: "us-east-1",
    OPENCODE_GATEWAY_KEY: "e",
    OPENCODE_API_KEY: "f",
    OPENCODE_PASSWORD: "g",
    OPENCODE_SERVER_PASSWORD: "h",
    OPENCODE_SSH_ASKPASS_TOKEN: "i",
    KETE_GATEWAY_KEY: "j",
    OPENCODE_JOB_MAX_OUTPUT_TOKENS: "4096",
    OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1000",
    OPENCODE_JOB_GATEWAY_KEY_FD: "3",
    OPENCODE_ENV_BRIDGED: "1",
    OPENCODE_TERMINAL: "1",
  }

  test("interactive: only Kete's own credentials are removed", () => {
    const result = KeteToolEnv.filter(env, { unattended: false, platform: "linux" })
    expect(Object.keys(result).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
        "OPENCODE_JOB_MAX_OUTPUT_TOKENS",
        "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX",
        "OPENCODE_JOB_GATEWAY_KEY_FD",
        "OPENCODE_ENV_BRIDGED",
        "OPENCODE_TERMINAL",
      ].sort(),
    )
  })

  test("unattended: credentials removed too; non-secret Kete names and plain variables kept", () => {
    const result = KeteToolEnv.filter(env, { unattended: true, platform: "linux" })
    expect(Object.keys(result).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "AWS_REGION",
        "OPENCODE_JOB_MAX_OUTPUT_TOKENS",
        "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX",
        "OPENCODE_JOB_GATEWAY_KEY_FD",
        "OPENCODE_ENV_BRIDGED",
        "OPENCODE_TERMINAL",
      ].sort(),
    )
  })

  test("passEnv keeps a named credential in an unattended run, never a Kete credential", () => {
    const result = KeteToolEnv.filter(env, {
      unattended: true,
      passEnv: ["GITHUB_TOKEN", "OPENCODE_GATEWAY_KEY", "KETE_GATEWAY_KEY"],
      platform: "linux",
    })
    expect(result.GITHUB_TOKEN).toBe("b")
    expect(result.OPENCODE_GATEWAY_KEY).toBeUndefined()
    expect(result.KETE_GATEWAY_KEY).toBeUndefined()
    expect(result.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test("AC4: names match case-insensitively; passEnv is exact on POSIX, case-insensitive on Windows", () => {
    const mixed = { Anthropic_Api_Key: "a", opencode_gateway_key: "b", Github_Token: "c", Path: "C:\\Windows" }
    const posix = KeteToolEnv.filter(mixed, { unattended: true, passEnv: ["GITHUB_TOKEN"], platform: "linux" })
    expect(posix).toEqual({ Path: "C:\\Windows" })
    const windows = KeteToolEnv.filter(mixed, { unattended: true, passEnv: ["GITHUB_TOKEN"], platform: "win32" })
    expect(windows).toEqual({ Github_Token: "c", Path: "C:\\Windows" })
    const interactive = KeteToolEnv.filter(mixed, { unattended: false, platform: "win32" })
    expect(interactive).toEqual({ Anthropic_Api_Key: "a", Github_Token: "c", Path: "C:\\Windows" })
  })

  test("returns a copy; the input is untouched", () => {
    const input = { OPENCODE_GATEWAY_KEY: "x", PATH: "/bin" }
    KeteToolEnv.filter(input, { unattended: true })
    expect(input).toEqual({ OPENCODE_GATEWAY_KEY: "x", PATH: "/bin" })
  })
})

// Names in the bundled catalogue that aren't credentials: regions, project/account IDs, hosts and
// endpoints. Everything else a provider lists under `env` is its credential and must be removed.
const nonSecret = new Set([
  "AWS_REGION",
  "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
  "AZURE_RESOURCE_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "DATABRICKS_HOST",
  "GOOGLE_VERTEX_LOCATION",
  "GOOGLE_VERTEX_PROJECT",
  "INFOMANIAK_PRODUCT_ID",
  "NEON_AI_GATEWAY_BASE_URL",
  "PRIVATEMODE_ENDPOINT",
  "SNOWFLAKE_ACCOUNT",
  "WATSONX_AI_PROJECT_ID",
])

describe("KeteToolEnv and the models.dev catalogue (AC5)", () => {
  test("every provider credential variable in the bundled snapshot is removed in an unattended run", () => {
    const catalogue = JSON.parse(snapshotText) as Record<string, { readonly env?: ReadonlyArray<string> }>
    const names = [...new Set(Object.values(catalogue).flatMap((provider) => provider.env ?? []))]
    expect(names.length).toBeGreaterThan(50)
    const missed = names.filter((name) => !nonSecret.has(name) && !KeteToolEnv.isCredential(name))
    expect(missed).toEqual([])
  })

  test("the non-secret list stays honest: each entry is still in the catalogue and not a credential", () => {
    const catalogue = JSON.parse(snapshotText) as Record<string, { readonly env?: ReadonlyArray<string> }>
    const names = new Set(Object.values(catalogue).flatMap((provider) => provider.env ?? []))
    for (const name of nonSecret) {
      expect(KeteToolEnv.isCredential(name)).toBe(false)
      expect(names.has(name)).toBe(true)
    }
  })
})

describe("KeteToolEnv.forSession", () => {
  const sessionID = Session.ID.make("ses_tool_env_unit")
  const info = (metadata?: Record<string, unknown>) =>
    ({ id: sessionID, metadata, time: { created: DateTime.makeUnsafe(0) } }) as unknown as SessionSchema.Info
  const env = { PATH: "/bin", ANTHROPIC_API_KEY: "a", NPM_TOKEN: "n", OPENCODE_GATEWAY_KEY: "k" }
  const lookup = (metadata: Record<string, unknown> | undefined, processEnv: Record<string, string> = {}) => ({
    session: () => Effect.succeed(Option.some(info(metadata))),
    config: Effect.succeed({ unattended: { passEnv: ["NPM_TOKEN"] } }),
    processEnv,
    platform: "linux" as const,
  })

  test("interactive session: provider keys kept, passEnv irrelevant", async () => {
    const result = await Effect.runPromise(KeteToolEnv.forSession(lookup(undefined), sessionID, env))
    expect(result).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "a", NPM_TOKEN: "n" })
  })

  test("unattended family: credentials removed, passEnv honoured", async () => {
    const result = await Effect.runPromise(
      KeteToolEnv.forSession(lookup({ "kete.unattended": { version: 1 } }), sessionID, env),
    )
    expect(result).toEqual({ PATH: "/bin", NPM_TOKEN: "n" })
  })

  test("job mode counts as unattended even without session metadata (and an invalid flag fails closed)", async () => {
    for (const value of ["1", "yes"]) {
      const result = await Effect.runPromise(
        KeteToolEnv.forSession(lookup(undefined, { OPENCODE_JOB_MODE: value }), sessionID, env),
      )
      expect(result).toEqual({ PATH: "/bin", NPM_TOKEN: "n" })
    }
  })

  test("an undecodable kete.unattended still counts as unattended", async () => {
    const result = await Effect.runPromise(
      KeteToolEnv.forSession(lookup({ "kete.unattended": "garbage" }), sessionID, env),
    )
    expect(result.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
