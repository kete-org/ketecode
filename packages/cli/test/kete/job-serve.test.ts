import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { KeteJobServe } from "../../src/kete/job-serve"

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const message = (value: object) =>
  JSON.stringify({ v: 1, password: "pw", gateway_key: "job-key", organization: org, ...value })

function harness(overrides: Partial<KeteJobServe.Deps> & { text?: string } = {}) {
  const calls: string[] = []
  const keys: string[] = []
  const organizations: string[] = []
  const env: Record<string, string | undefined> = overrides.env ?? {
    OPENCODE_JOB_MODE: "1",
    OPENCODE_JOB_SECRETS_FD: "3",
    OPENCODE_JOB_AUDIT_FD: "4",
    OPENCODE_GATEWAY_KEY: "env-key",
    OPENCODE_PASSWORD: "env-password",
    OPENCODE_SERVER_PASSWORD: "env-password-2",
    KEEP: "yes",
  }
  const deps: Partial<KeteJobServe.Deps> = {
    env,
    platform: "linux",
    dumpable: () => {
      calls.push("dumpable")
      return { kind: "ok" }
    },
    readDescriptor: async (fd) => {
      calls.push(`read:${fd}`)
      return overrides.text ?? message({})
    },
    setGatewayKey: (key) => {
      calls.push("setGatewayKey")
      keys.push(key)
    },
    setOrganization: (id) => {
      calls.push("setOrganization")
      organizations.push(id)
    },
    validateAudit: (fd) => {
      calls.push(`validateAudit:${fd}`)
      return undefined
    },
    setCloexec: (fd) => {
      calls.push(`cloexec:${fd}`)
    },
    setAuditSink: (fd) => {
      calls.push(`setAuditSink:${fd}`)
    },
    confinable: () => undefined,
    ...overrides,
  }
  return { calls, keys, organizations, env, deps }
}

const run = (input: KeteJobServe.Input, deps: Partial<KeteJobServe.Deps>) =>
  Effect.runPromiseExit(KeteJobServe.prepare(input, deps))

const errorOf = (exit: Exit.Exit<unknown, Error>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return String(exit.cause)
}

const socketInput = { mode: "stdio" as const, socket: "/run/kete-x/s" }

describe("KeteJobServe.prepare outside job mode (AC5, D1)", () => {
  test("changes nothing without --socket", async () => {
    const exit = await run({ mode: "default" }, { env: {} })
    expect(exit).toEqual(Exit.succeed(undefined))
  })

  test("refuses --socket", async () => {
    const exit = await run(socketInput, { env: {} })
    expect(errorOf(exit)).toContain("--socket is only available in job mode")
  })
})

describe("KeteJobServe.prepare in job mode", () => {
  test("refuses every shape but --stdio --socket (no TCP listener, AC1)", async () => {
    for (const input of [
      { mode: "stdio" as const },
      { mode: "default" as const, socket: "/run/x/s" },
      { mode: "service" as const, socket: "/run/x/s" },
      { ...socketInput, port: 0 },
      { ...socketInput, hostname: "127.0.0.1" },
    ]) {
      const { calls, deps } = harness()
      const exit = await run(input, deps)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toEqual([])
    }
  })

  test("refuses Windows", async () => {
    const { deps } = harness({ platform: "win32" })
    expect(errorOf(await run(socketInput, deps))).toContain("Windows")
  })

  test("reads the secrets after becoming non-dumpable, removes secret env, sets the key (AC2, AC3)", async () => {
    const { calls, keys, organizations, env, deps } = harness()
    const exit = await run(socketInput, deps)
    expect(exit).toEqual(Exit.succeed({ password: "pw", socket: "/run/kete-x/s" }))
    expect(calls).toEqual(["dumpable", "read:3", "validateAudit:4", "cloexec:4", "setGatewayKey", "setOrganization", "setAuditSink:4"])
    expect(keys).toEqual(["job-key"])
    expect(organizations).toEqual([org])
    expect(env).toEqual({ OPENCODE_JOB_MODE: "1", KEEP: "yes" })
  })

  test("an orchestrated job's section is handed to setOrchestration; an invalid one refuses (O7)", async () => {
    const spec = { version: 1, id: "ab12cd34-5e6f-4a7b-8c9d-0e1f2a3b4c5d", role: "coordinator", turn: 1, final: false, plan: null, titles: "send" }
    const seen: unknown[] = []
    const ok = harness({
      text: message({ orchestration: { job_id: "c3d8f1a2-6b4e-4f7a-9c2d-8e1f0a3b5c7d", spec } }),
      setOrchestration: (value) => void seen.push(value),
    })
    expect(Exit.isSuccess(await run(socketInput, ok.deps))).toBe(true)
    expect(seen).toEqual([{ jobID: "c3d8f1a2-6b4e-4f7a-9c2d-8e1f0a3b5c7d", spec }])
    const bad = harness({
      text: message({ orchestration: { job_id: "x", spec } }),
      setOrchestration: () => {
        throw new Error("the job's id is not a valid job id")
      },
    })
    expect(errorOf(await run(socketInput, bad.deps))).toContain("not a valid job id")
    const absent = harness({ setOrchestration: () => void seen.push("called") })
    await run(socketInput, absent.deps)
    expect(seen).toHaveLength(1)
  })

  test("a failing prctl refuses before the descriptor is read (AC3)", async () => {
    const { calls, deps } = harness({
      dumpable: () => {
        calls.push("dumpable")
        return { kind: "failed", errno: 1, reason: "prctl(PR_SET_DUMPABLE, 0) failed" }
      },
    })
    expect(errorOf(await run(socketInput, deps))).toContain("non-dumpable")
    expect(calls).toEqual(["dumpable"])
  })

  test("refuses a missing or invalid descriptor variable", async () => {
    const missing = harness({ env: { OPENCODE_JOB_MODE: "1" } })
    expect(errorOf(await run(socketInput, missing.deps))).toContain("KETE_JOB_SECRETS_FD is not set")
    const invalid = harness({ env: { OPENCODE_JOB_MODE: "1", OPENCODE_JOB_SECRETS_FD: "1" } })
    expect(errorOf(await run(socketInput, invalid.deps))).toContain("not a descriptor number")
  })

  test("a descriptor read failure refuses", async () => {
    const { deps } = harness({
      readDescriptor: async () => {
        throw new Error("descriptor 3 is not open")
      },
    })
    expect(errorOf(await run(socketInput, deps))).toContain("descriptor 3 is not open")
  })

  test("refuses a malformed message, an empty password and a missing or invalid key (D2)", async () => {
    for (const text of [
      "not json",
      message({ v: 2 }),
      message({ password: "" }),
      JSON.stringify({ v: 1, password: "pw" }),
      message({ gateway_key: "" }),
      message({ gateway_key: "bad key" }),
      JSON.stringify({ v: 1, password: "pw", gateway_key: "job-key" }),
      message({ organization: "" }),
      message({ organization: "../../etc" }),
    ]) {
      const { calls, deps } = harness({ text })
      const exit = await run(socketInput, deps)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).not.toContain("setGatewayKey")
      expect(calls).not.toContain("setOrganization")
      expect(errorOf(exit)).not.toContain("bad key")
    }
  })

  test("the audit descriptor is required, a pipe or socket, close-on-exec, and becomes the sink (AC3)", async () => {
    const missing = harness({ env: { OPENCODE_JOB_MODE: "1", OPENCODE_JOB_SECRETS_FD: "3" } })
    expect(errorOf(await run(socketInput, missing.deps))).toContain("KETE_JOB_AUDIT_FD is not set")
    expect(missing.calls).not.toContain("setGatewayKey")
    const same = harness({ env: { OPENCODE_JOB_MODE: "1", OPENCODE_JOB_SECRETS_FD: "3", OPENCODE_JOB_AUDIT_FD: "3" } })
    expect(errorOf(await run(socketInput, same.deps))).toContain("must differ")
    const notPipe = harness({ validateAudit: () => "descriptor 4 is not a pipe or socket" })
    expect(errorOf(await run(socketInput, notPipe.deps))).toContain("not a pipe or socket")
    expect(notPipe.calls).not.toContain("setAuditSink:4")
    const { env, deps } = harness()
    await run(socketInput, deps)
    expect(env.OPENCODE_JOB_AUDIT_FD).toBeUndefined()
  })

  test("refuses when the working tree can't be confined (no openat2), before any secret is read (AC2)", async () => {
    const { calls, deps } = harness({ confinable: () => "Job mode: kete can't confine its file access (not Linux: darwin); refusing to start." })
    expect(errorOf(await run(socketInput, deps))).toContain("can't confine its file access")
    expect(calls).toEqual(["dumpable"])
  })
})
