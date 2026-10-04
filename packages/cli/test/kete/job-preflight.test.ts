import { describe, expect, test } from "bun:test"
import { KeteJobPreflight } from "../../src/kete/job-preflight"

function harness(env: Record<string, string | undefined>, read: () => Promise<string> = async () => "job-key") {
  const calls: string[] = []
  const deps: Partial<KeteJobPreflight.Deps> = {
    env,
    dumpable: () => {
      calls.push("dumpable")
      return { kind: "ok" }
    },
    readDescriptor: async (fd, options) => {
      calls.push(`read:${fd}:${options.maxBytes}`)
      return read()
    },
    validateAudit: (fd) => {
      calls.push(`validate:${fd}`)
      return undefined
    },
    setCloexec: (fd) => {
      calls.push(`cloexec:${fd}`)
    },
  }
  return { calls, deps }
}

const jobEnv = () => ({
  OPENCODE_JOB_MODE: "1",
  OPENCODE_JOB_GATEWAY_KEY_FD: "3",
  OPENCODE_JOB_AUDIT_FD: "4",
  OPENCODE_GATEWAY_KEY: "env-key-must-be-ignored",
  OPENCODE_PASSWORD: "pw",
  OPENCODE_SERVER_PASSWORD: "pw2",
  KEEP: "yes",
})

describe("KeteJobPreflight.run", () => {
  test("becomes non-dumpable, then reads the key and removes every secret variable (AC2, AC3)", async () => {
    const env: Record<string, string | undefined> = jobEnv()
    const { calls, deps } = harness(env)
    expect(await KeteJobPreflight.run(deps)).toEqual({ kind: "ok", gatewayKey: "job-key", auditFd: 4 })
    expect(calls).toEqual(["dumpable", "read:3:4096", "validate:4", "cloexec:4"])
    expect(env).toEqual({ OPENCODE_JOB_MODE: "1", KEEP: "yes" })
  })

  test("a failing prctl refuses before the descriptor is read (AC3)", async () => {
    const env: Record<string, string | undefined> = jobEnv()
    const calls: string[] = []
    const outcome = await KeteJobPreflight.run({
      env,
      dumpable: () => ({ kind: "failed", errno: 1, reason: "prctl(PR_SET_DUMPABLE, 0) failed" }),
      readDescriptor: async () => {
        calls.push("read")
        return "job-key"
      },
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") expect(outcome.message).toContain("non-dumpable")
    expect(calls).toEqual([])
  })

  test("an environment key alone is ignored: refused (D2)", async () => {
    const env: Record<string, string | undefined> = { OPENCODE_JOB_MODE: "1", OPENCODE_GATEWAY_KEY: "env-key" }
    const { calls, deps } = harness(env)
    const outcome = await KeteJobPreflight.run(deps)
    expect(outcome).toEqual({
      kind: "refused",
      message: "Job mode: no gateway key — pass it on a descriptor with KETE_JOB_GATEWAY_KEY_FD.",
    })
    expect(calls).toEqual(["dumpable"])
    expect(env.OPENCODE_GATEWAY_KEY).toBeUndefined()
  })

  test("refuses an invalid descriptor number", async () => {
    for (const value of ["0", "2", "abc", "1024"]) {
      const { calls, deps } = harness({ OPENCODE_JOB_MODE: "1", OPENCODE_JOB_GATEWAY_KEY_FD: value })
      const outcome = await KeteJobPreflight.run(deps)
      expect(outcome.kind).toBe("refused")
      expect(calls).toEqual(["dumpable"])
    }
  })

  test("a read failure refuses, naming the variable, not the content", async () => {
    const { deps } = harness(jobEnv(), async () => {
      throw new Error("descriptor 3 holds more than 4096 bytes")
    })
    const outcome = await KeteJobPreflight.run(deps)
    expect(outcome).toEqual({
      kind: "refused",
      message: "Job mode: could not read KETE_JOB_GATEWAY_KEY_FD: descriptor 3 holds more than 4096 bytes",
    })
  })

  test("refuses an empty or non-printable key without echoing it", async () => {
    for (const key of ["", "zz9 with spaces", "zz9\n"]) {
      const { deps } = harness(jobEnv(), async () => key)
      const outcome = await KeteJobPreflight.run(deps)
      expect(outcome.kind).toBe("refused")
      if (outcome.kind === "refused" && key) expect(outcome.message).not.toContain("zz9")
    }
  })

  test("the audit pipe is required, must differ from the key's descriptor, be a pipe, and become close-on-exec (AC3)", async () => {
    const missing = harness({ ...jobEnv(), OPENCODE_JOB_AUDIT_FD: undefined })
    expect(await KeteJobPreflight.run(missing.deps)).toEqual({
      kind: "refused",
      message: "Job mode: no audit sink — pass a pipe with KETE_JOB_AUDIT_FD.",
    })
    for (const value of ["3", "2", "x"]) {
      const invalid = harness({ ...jobEnv(), OPENCODE_JOB_AUDIT_FD: value })
      const outcome = await KeteJobPreflight.run(invalid.deps)
      expect(outcome.kind).toBe("refused")
      if (outcome.kind === "refused") expect(outcome.message).toContain("KETE_JOB_AUDIT_FD is not a descriptor number")
    }
    const notPipe = harness(jobEnv())
    const outcome = await KeteJobPreflight.run({ ...notPipe.deps, validateAudit: () => "descriptor 4 is not a pipe" })
    expect(outcome).toEqual({ kind: "refused", message: "Job mode: KETE_JOB_AUDIT_FD: descriptor 4 is not a pipe." })
    const env: Record<string, string | undefined> = jobEnv()
    const cloexec = harness(env)
    const failed = await KeteJobPreflight.run({
      ...cloexec.deps,
      setCloexec: () => {
        throw new Error("cannot mark descriptor 4 close-on-exec")
      },
    })
    expect(failed.kind).toBe("refused")
    expect(env.OPENCODE_JOB_AUDIT_FD).toBeUndefined()
  })
})
