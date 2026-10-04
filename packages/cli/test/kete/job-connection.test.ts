import { describe, expect, test } from "bun:test"
import { JobConnection } from "../../src/kete/job-connection"
import { JobGit } from "../../src/kete/job-git"

describe("JobConnection.resolve", () => {
  test("job mode off: args pass through unchanged", () => {
    expect(JobConnection.resolve({ standalone: false }, {})).toEqual({ kind: "ok", args: { standalone: false } })
    expect(JobConnection.resolve({ server: "http://x", standalone: false }, {})).toEqual({
      kind: "ok",
      args: { server: "http://x", standalone: false },
    })
  })

  test("job mode on: --server is refused", () => {
    const result = JobConnection.resolve({ server: "http://x", standalone: false }, { OPENCODE_JOB_MODE: "1" })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.message).toContain("--server")
  })

  test("job mode on: the background service is never used, standalone is forced", () => {
    expect(JobConnection.resolve({ standalone: false }, { OPENCODE_JOB_MODE: "1" })).toEqual({
      kind: "ok",
      args: { standalone: true },
    })
  })

  test("an invalid KETE_JOB_MODE fails closed like \"1\"", () => {
    expect(JobConnection.resolve({ standalone: false }, { OPENCODE_JOB_MODE: "maybe" })).toEqual({
      kind: "ok",
      args: { standalone: true },
    })
  })
})

describe("JobGit.run in job mode", () => {
  test("rejects before git starts", async () => {
    await expect(JobGit.run("/repo", ["status"], { env: { OPENCODE_JOB_MODE: "1" } })).rejects.toThrow(
      "refused to start `git`",
    )
  })

  test("runs normally when job mode is off", async () => {
    const result = await JobGit.run(process.cwd(), ["--version"], { env: {} })
    expect(result.exitCode).toBe(0)
  })
})
