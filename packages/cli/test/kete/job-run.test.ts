// AC1 "starts nothing" for an invalid spec, AC4's reason/exit mapping (audit reasons, event
// fallback, watchdog), the permission-asked bug path, and the `--json` shape — against fake
// clients and fake git (real end-to-end coverage against a real server is
// `packages/server/test/kete/job-run.test.ts`).
import { describe, expect, spyOn, test } from "bun:test"
import { OpenCode, type EventSubscribeOutput } from "@opencode/client/promise"
import { JobRun } from "../../src/kete/job-run"

type V2Event = EventSubscribeOutput

function ok<T>(data: T) {
  return Promise.resolve(data)
}

const validPolicy = { version: 1 as const, budget: 5, timeout: 30 }
const validSpec: JobRun.Spec = { version: 1, prompt: "do it", policy: validPolicy }

/** A fake `JobRun.Git`: `rev-parse --show-toplevel`/`HEAD` and `status` answer as a clean repo at
 * `/repo` on `deadbeef` by default; every call is recorded for assertions. */
function fakeGit(overrides: Partial<JobRun.Git> = {}) {
  const calls: Array<{ readonly fn: string; readonly args: ReadonlyArray<unknown> }> = []
  const okResult: JobRun.GitResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false }
  const git: JobRun.Git = {
    run: async (cwd, args, options) => {
      calls.push({ fn: "run", args: [cwd, args] })
      if (overrides.run) return overrides.run(cwd, args, options)
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ...okResult, stdout: "/repo\n" }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ...okResult, stdout: "deadbeef\n" }
      if (args[0] === "status") return { ...okResult, stdout: "" }
      return okResult
    },
    worktreeAdd: async (root, input, options) => {
      calls.push({ fn: "worktreeAdd", args: [root, input] })
      return overrides.worktreeAdd ? overrides.worktreeAdd(root, input, options) : okResult
    },
    worktreeDiscard: async (root, input, options) => {
      calls.push({ fn: "worktreeDiscard", args: [root, input] })
      return overrides.worktreeDiscard ? overrides.worktreeDiscard(root, input, options) : { remove: okResult, branch: okResult }
    },
  }
  return { git, calls }
}

/** A real `OpenCode` client with every network method faked. `event.subscribe` returns one shared
 * async generator: `pushEvent` queues an event and wakes a waiting reader, `connected` is emitted
 * first (like a real stream). */
function fakeClient(options: {
  readonly locationDirectory?: string
  readonly sessionCreate?: () => Promise<unknown>
  readonly sessionWait?: () => Promise<void>
  readonly interruptEmitsEvent?: boolean
} = {}) {
  const sdk = OpenCode.make({ baseUrl: "https://job.test" })
  const values: V2Event[] = [{ id: "evt_connected", type: "server.connected", data: {} }]
  let wake: (() => void) | undefined
  const stream = (async function* (): AsyncGenerator<V2Event, void, unknown> {
    for (;;) {
      const value = values.shift()
      if (!value) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      yield value
    }
  })()
  const pushEvent = (event: V2Event) => {
    values.push(event)
    wake?.()
    wake = undefined
  }

  spyOn(sdk.event, "subscribe").mockImplementation(() => stream)
  spyOn(sdk.location, "get").mockImplementation(
    () => ok({ directory: options.locationDirectory ?? "/repo", project: { id: "abcdef1234567890", directory: "/repo", canonical: "/repo" } }) as never,
  )
  spyOn(sdk.session, "create").mockImplementation(
    () => (options.sessionCreate ? options.sessionCreate() : ok({ id: "ses_job", time: { created: Date.now() } })) as never,
  )
  spyOn(sdk.session, "environment").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.session, "prompt").mockImplementation(() => ok({ id: "msg_1", sessionID: "ses_job", time: { created: 0 } }) as never)
  spyOn(sdk.session, "wait").mockImplementation(() => (options.sessionWait ? options.sessionWait() : ok(undefined)) as never)
  spyOn(sdk.session, "interrupt").mockImplementation(() => {
    if (options.interruptEmitsEvent !== false)
      pushEvent({
        id: "evt_interrupted",
        created: 0,
        type: "session.execution.interrupted",
        durable: { aggregateID: "ses_job", seq: 1, version: 1 },
        data: { sessionID: "ses_job", reason: "user" },
      })
    return ok({ interrupted: true }) as never
  })
  spyOn(sdk.session, "get").mockImplementation(() => ok({ id: "ses_job", cost: 0 }) as never)
  spyOn(sdk.message, "list").mockImplementation(() => ok({ data: [], cursor: {} }) as never)
  spyOn(sdk.permission, "reply").mockImplementation(() => ok(undefined) as never)

  return { client: sdk, pushEvent }
}

function fakeDeps(input: {
  readonly client: ReturnType<typeof fakeClient>["client"]
  readonly git: JobRun.Git
  readonly auditFiles?: Record<string, string>
}): JobRun.Deps {
  const files = { ...(input.auditFiles ?? {}) }
  return {
    client: input.client,
    git: input.git,
    readFile: async (file) => {
      const content = files[file]
      if (content === undefined) throw new Error("ENOENT")
      return content
    },
    stat: async (file) => {
      const content = files[file]
      if (content === undefined) throw new Error("ENOENT")
      return { size: Buffer.byteLength(content, "utf8"), isFile: () => true }
    },
    exists: async (file) => files[file] !== undefined,
    realpath: async (file) => file,
    dataDir: "/data",
    auditDir: "/data/audit",
    // A short poll window so a "no local audit file" test doesn't wait out the real 5s default;
    // real time (capped) otherwise, so an abandoned (raced-out) watchdog sleep never costs more
    // than a couple of ms — deadline-sensitive tests use a tiny `policy.timeout` instead of a fake
    // clock, the way `core/test/kete/unattended.test.ts` does.
    auditPollTimeoutMs: 40,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))),
    stdout: () => {},
    stderr: () => {},
    onInterrupt: () => () => {},
    randomId: () => "0123456789abcdef",
    attached: false,
  }
}

async function runWith(options: {
  readonly spec?: JobRun.Spec
  readonly cwd?: string
  readonly serverUrl?: string
  readonly json?: boolean
  readonly client?: ReturnType<typeof fakeClient>
  readonly git?: ReturnType<typeof fakeGit>
  readonly auditFiles?: Record<string, string>
  readonly jobMode?: boolean
  readonly extra?: Partial<JobRun.Deps>
}) {
  const client = options.client ?? fakeClient()
  const git = options.git ?? fakeGit()
  const deps = { ...fakeDeps({ client: client.client, git: git.git, auditFiles: options.auditFiles }), ...options.extra }
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const wrapped: JobRun.Deps = { ...deps, stdout: (text) => stdoutLines.push(text), stderr: (text) => stderrLines.push(text) }
  const result = await JobRun.run(
    { spec: options.spec ?? validSpec, cwd: options.cwd ?? "/repo", serverUrl: options.serverUrl, json: options.json ?? false, jobMode: options.jobMode },
    wrapped,
  )
  return { ...result, stdoutLines, stderrLines, client, git }
}

describe("JobRun.run — invalid input, refused before anything starts", () => {
  test("invalid spec: zero client and git calls", async () => {
    const client = fakeClient()
    const git = fakeGit()
    const badSpec: JobRun.Spec = { ...validSpec, policy: { version: 1, budget: 0, timeout: 30 } }
    const { exitCode, result } = await runWith({ spec: badSpec, client, git })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("policy.budget")
    expect(git.calls).toEqual([])
    expect((client.client.session.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([])
  })

  test("an invalid model reference: zero client and git calls", async () => {
    const client = fakeClient()
    const git = fakeGit()
    const badSpec: JobRun.Spec = { ...validSpec, model: "not-a-model" }
    const { exitCode, result } = await runWith({ spec: badSpec, client, git })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("spec.model")
    expect(git.calls).toEqual([])
    expect((client.client.session.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([])
  })

  test("a non-loopback --server is refused before any git call", async () => {
    const git = fakeGit()
    const { exitCode, result } = await runWith({ serverUrl: "http://example.com:4000", git })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("this machine")
    expect(git.calls).toEqual([])
  })

  test("a loopback --server is accepted", async () => {
    const client = fakeClient()
    const auditFiles = {
      "/data/audit/ses_job.jsonl":
        JSON.stringify({ v: 1, type: "run", event: "ended", session_id: "ses_job", root_id: "ses_job", reason: "completed" }) + "\n",
    }
    const { exitCode } = await runWith({ serverUrl: "http://127.0.0.1:4096", client, auditFiles })
    expect(exitCode).toBe(0)
  })

  test("a location.get directory mismatch (a tunnel to another host) is refused", async () => {
    const client = fakeClient({ locationDirectory: "/somewhere/else" })
    const git = fakeGit()
    const { exitCode, result } = await runWith({ client, git })
    expect(exitCode).toBe(2)
    expect(result.message).toContain("this machine")
  })

  test("a branch requested outside a git repository is refused", async () => {
    const git = fakeGit({ run: async (_cwd, args) => ({ exitCode: 128, stdout: "", stderr: "not a git repository", timedOut: false }) })
    const spec: JobRun.Spec = { ...validSpec, branch: "job/x" }
    const { exitCode, result } = await runWith({ spec, git })
    expect(exitCode).toBe(2)
    expect(result.message).toContain("not a git repository")
  })

  test("a repository with no commits is refused", async () => {
    const git = fakeGit({
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { exitCode: 0, stdout: "/repo\n", stderr: "", timedOut: false }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { exitCode: 128, stdout: "", stderr: "unknown revision", timedOut: false }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      },
    })
    const { exitCode, result } = await runWith({ git })
    expect(exitCode).toBe(2)
    expect(result.message).toContain("no commits")
  })
})

describe("JobRun.run — worktree creation", () => {
  test("the worktree path and git worktree add arguments", async () => {
    const git = fakeGit()
    await runWith({ git })
    const added = git.calls.find((call) => call.fn === "worktreeAdd")
    expect(added).toBeDefined()
    const [root, input] = added!.args as [string, { branch: string; path: string; base: string }]
    expect(root).toBe("/repo")
    expect(input.base).toBe("deadbeef")
    expect(input.path).toBe("/data/worktree/abcdef/job-01234567")
    expect(input.branch).toBe("kete/job/01234567")
  })

  test("a session.create failure removes the worktree it just created and deletes the branch", async () => {
    const client = fakeClient({ sessionCreate: () => Promise.reject(new Error("boom")) })
    const git = fakeGit()
    const { exitCode, result } = await runWith({ client, git })
    expect(exitCode).toBe(2)
    expect(result.message).toContain("boom")
    expect(git.calls.some((call) => call.fn === "worktreeDiscard")).toBe(true)
  })
})

describe("JobRun.run — audit-log reason mapping (AC4)", () => {
  const cases: ReadonlyArray<{ readonly reason: JobRun.Outcome; readonly exitCode: number }> = [
    { reason: "completed", exitCode: 0 },
    { reason: "error", exitCode: 1 },
    { reason: "refused", exitCode: 2 },
    { reason: "audit_failed", exitCode: 2 },
    { reason: "time_limit", exitCode: 3 },
    { reason: "budget", exitCode: 4 },
    { reason: "interrupted", exitCode: 130 },
  ]
  for (const { reason, exitCode } of cases) {
    test(`"${reason}" from the audit log maps to exit ${exitCode}`, async () => {
      const auditFiles = {
        "/data/audit/ses_job.jsonl": JSON.stringify({ v: 1, type: "run", event: "ended", session_id: "ses_job", root_id: "ses_job", reason }) + "\n",
      }
      const { exitCode: actual, result } = await runWith({ auditFiles })
      expect(actual).toBe(exitCode)
      expect(result.outcome).toBe(reason)
      expect(result.audit_local).toBe(true)
    })
  }

  test("sums the audit log's model lines for the family cost", async () => {
    const lines = [
      { v: 1, type: "run", event: "started", session_id: "ses_job", root_id: "ses_job" },
      { v: 1, type: "model", session_id: "ses_job", root_id: "ses_job", provider: "test", model: "m", cost_usd: 0.5 },
      { v: 1, type: "model", session_id: "ses_child", root_id: "ses_job", provider: "test", model: "m", cost_usd: 0.25 },
      { v: 1, type: "run", event: "ended", session_id: "ses_job", root_id: "ses_job", reason: "completed" },
    ]
    const auditFiles = { "/data/audit/ses_job.jsonl": lines.map((line) => JSON.stringify(line)).join("\n") + "\n" }
    const { result } = await runWith({ auditFiles })
    expect(result.cost_usd).toBeCloseTo(0.75)
    expect(result.cost_scope).toBe("family")
  })

  test("lists every denial from the audit log's permission lines", async () => {
    const lines = [
      { v: 1, type: "run", event: "started", session_id: "ses_job", root_id: "ses_job" },
      { v: 1, type: "permission", session_id: "ses_job", root_id: "ses_job", action: "edit", resources: [".kete/kete.jsonc"], effect: "deny", message: "unattended run: editing Kete configuration (.kete/, kete.json, the global config) is not allowed" },
      { v: 1, type: "permission", session_id: "ses_job", root_id: "ses_job", action: "shell", resources: ["ls"], effect: "allow" },
      { v: 1, type: "run", event: "ended", session_id: "ses_job", root_id: "ses_job", reason: "completed" },
    ]
    const auditFiles = { "/data/audit/ses_job.jsonl": lines.map((line) => JSON.stringify(line)).join("\n") + "\n" }
    const { result } = await runWith({ auditFiles })
    expect(result.denied).toEqual([{ action: "edit", resources: [".kete/kete.jsonc"], message: "unattended run: editing Kete configuration (.kete/, kete.json, the global config) is not allowed" }])
  })
})

describe("JobRun.run — event fallback (no local audit log)", () => {
  test("session.execution.succeeded with no audit file: completed / 0", async () => {
    const client = fakeClient({
      sessionWait: () => {
        return Promise.resolve()
      },
    })
    // Emit the terminal event right when wait() is asked for, mirroring what a real server would push.
    const spied = spyOn(client.client.session, "wait").mockImplementation(() => {
      client.pushEvent({
        id: "evt_ok",
        created: 0,
        type: "session.execution.succeeded",
        durable: { aggregateID: "ses_job", seq: 1, version: 1 },
        data: { sessionID: "ses_job" },
      })
      return ok(undefined) as never
    })
    const { exitCode, result } = await runWith({ client })
    expect(exitCode).toBe(0)
    expect(result.outcome).toBe("completed")
    expect(result.audit_local).toBe(false)
    spied.mockRestore()
  })

  test("session.execution.failed with error.type unattended, classified by message: budget → 4", async () => {
    const client = fakeClient()
    spyOn(client.client.session, "wait").mockImplementation(() => {
      client.pushEvent({
        id: "evt_failed",
        created: 0,
        type: "session.execution.failed",
        durable: { aggregateID: "ses_job", seq: 1, version: 1 },
        data: { sessionID: "ses_job", error: { type: "unattended", message: "Unattended run stopped: it reached its $5.00 budget (spent $5.50)." } },
      })
      return ok(undefined) as never
    })
    const { exitCode, result } = await runWith({ client })
    expect(exitCode).toBe(4)
    expect(result.outcome).toBe("budget")
  })

  test("session.execution.failed with an ordinary error: error / 1", async () => {
    const client = fakeClient()
    spyOn(client.client.session, "wait").mockImplementation(() => {
      client.pushEvent({
        id: "evt_failed",
        created: 0,
        type: "session.execution.failed",
        durable: { aggregateID: "ses_job", seq: 1, version: 1 },
        data: { sessionID: "ses_job", error: { type: "provider", message: "boom" } },
      })
      return ok(undefined) as never
    })
    const { exitCode, result } = await runWith({ client })
    expect(exitCode).toBe(1)
    expect(result.outcome).toBe("error")
  })
})

describe("JobRun.run — permission.asked is a runtime bug", () => {
  test("replies reject, interrupts, and reports the bug", async () => {
    const client = fakeClient({ interruptEmitsEvent: false })
    spyOn(client.client.session, "prompt").mockImplementation(() => {
      client.pushEvent({
        id: "evt_ask",
        created: 0,
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_job", action: "shell", resources: ["ls"] },
      })
      return ok({ id: "msg_1", sessionID: "ses_job", time: { created: 0 } }) as never
    })
    const interruptSpy = spyOn(client.client.session, "interrupt").mockImplementation(() => ok({ interrupted: true }) as never)
    const replySpy = spyOn(client.client.permission, "reply").mockImplementation(() => ok(undefined) as never)
    const { exitCode, result } = await runWith({ client })
    expect(exitCode).toBe(1)
    expect(result.outcome).toBe("error")
    expect(result.message).toContain("bug: the runtime asked for a permission")
    expect(replySpy).toHaveBeenCalled()
    expect(interruptSpy).toHaveBeenCalled()
  })
})

describe("JobRun.run — the watchdog", () => {
  test("interrupts a run the runtime never ends, past timeout + 2 minutes", async () => {
    const client = fakeClient({ sessionWait: () => new Promise(() => {}) }) // never resolves on its own
    // A tiny timeout so the real clock has clearly passed the deadline by the time the fallback
    // checks it (this test's `sleep` is real time, capped short — see fakeDeps).
    const spec: JobRun.Spec = { ...validSpec, policy: { version: 1, budget: 5, timeout: 0.0001 } }
    const { exitCode, result } = await runWith({ client, spec })
    // No local audit file; the watchdog's own interrupt produces the terminal event, and the clock
    // past the deadline classifies it as the time limit rather than an outside interrupt.
    expect(exitCode).toBe(3)
    expect(result.outcome).toBe("time_limit")
  })
})

describe("JobRun.run — --json", () => {
  test("prints exactly one JSON object on stdout", async () => {
    const { stdoutLines, result } = await runWith({ json: true })
    expect(stdoutLines).toHaveLength(1)
    expect(JSON.parse(stdoutLines[0]!)).toEqual(result)
  })

  test("a spec error's --json output is the minimal shape", async () => {
    const badSpec: JobRun.Spec = { ...validSpec, policy: { version: 1, budget: 0, timeout: 30 } }
    const { stdoutLines } = await runWith({ spec: badSpec, json: true })
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.outcome).toBe("refused")
    expect(parsed.exit_code).toBe(2)
    expect(typeof parsed.message).toBe("string")
  })
})

describe("JobRun.run — job mode: cwd is the entrypoint's prepared worktree", () => {
  const ended =
    JSON.stringify({ v: 1, type: "run", event: "ended", session_id: "ses_job", root_id: "ses_job", reason: "completed" }) + "\n"
  /** A fake git that fails the test if it is ever called: in job mode `kete` runs no git at all. */
  const noGit = () =>
    fakeGit({
      run: async () => {
        throw new Error("git must not run in job mode")
      },
      worktreeAdd: async () => {
        throw new Error("git worktree add must not run in job mode")
      },
      worktreeDiscard: async () => {
        throw new Error("git worktree remove must not run in job mode")
      },
    })

  test("runs in cwd with no git call; reports isolated, worktree = cwd, branch = spec.branch", async () => {
    const git = noGit()
    const client = fakeClient()
    const { exitCode, result } = await runWith({
      jobMode: true,
      git,
      client,
      spec: { ...validSpec, branch: "kete/job/abc" },
      auditFiles: { "/repo/.git": "", "/data/audit/ses_job.jsonl": ended },
    })
    expect(exitCode).toBe(0)
    expect(result.outcome).toBe("completed")
    expect(result.isolated).toBe(true)
    expect(result.worktree).toBe("/repo")
    expect(result.branch).toBe("kete/job/abc")
    expect(result.directory).toBe("/repo")
    expect(git.calls).toEqual([])
    const created = (client.client.session.create as unknown as { mock: { calls: Array<[{ location: { directory: string } }]> } }).mock.calls
    expect(created[0]?.[0].location.directory).toBe("/repo")
  })

  test("refused without spec.branch, before any git or client call", async () => {
    const git = noGit()
    const client = fakeClient()
    const { exitCode, result } = await runWith({ jobMode: true, git, client, auditFiles: { "/repo/.git": "" } })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("spec.branch")
    expect(git.calls).toEqual([])
    expect((client.client.session.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([])
  })

  test("refused when cwd has no .git", async () => {
    const git = noGit()
    const client = fakeClient()
    const { exitCode, result } = await runWith({ jobMode: true, git, client, spec: { ...validSpec, branch: "kete/job/abc" } })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("no .git")
    expect(git.calls).toEqual([])
    expect((client.client.session.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([])
  })

  test("a failed session create cleans nothing up (the worktree is the entrypoint's)", async () => {
    const git = noGit()
    const client = fakeClient({ sessionCreate: () => Promise.reject(new Error("boom")) })
    const { exitCode, result } = await runWith({
      jobMode: true,
      git,
      client,
      spec: { ...validSpec, branch: "kete/job/abc" },
      auditFiles: { "/repo/.git": "" },
    })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.worktree).toBe("/repo")
    expect(git.calls).toEqual([])
  })

  test("piece A3: the audit comes from the relay (readAudit), not a file; no audit_log path (N2)", async () => {
    const relayed =
      JSON.stringify({ type: "model", root_id: "ses_job", cost_usd: 0.25 }) +
      "\n" +
      JSON.stringify({ type: "permission", root_id: "ses_job", effect: "deny", action: "shell", resources: ["rm"] }) +
      "\n" +
      JSON.stringify({ type: "run", event: "ended", root_id: "ses_job", reason: "completed" }) +
      "\n"
    const asked: string[] = []
    const { exitCode, result } = await runWith({
      jobMode: true,
      git: noGit(),
      spec: { ...validSpec, branch: "kete/job/abc" },
      // A stale file under auditDir must be ignored in favour of the relay.
      auditFiles: { "/repo/.git": "", "/data/audit/ses_job.jsonl": JSON.stringify({ type: "run", event: "ended", reason: "error" }) + "\n" },
      extra: {
        readAudit: async (rootID) => {
          asked.push(rootID)
          return relayed
        },
        auditFailure: () => undefined,
      },
    })
    expect(exitCode).toBe(0)
    expect(result.outcome).toBe("completed")
    expect(result.cost_usd).toBe(0.25)
    expect(result.cost_scope).toBe("family")
    expect(result.denied).toEqual([{ action: "shell", resources: ["rm"], message: undefined }])
    expect(result.audit_local).toBe(true)
    expect(result.audit_log).toBeUndefined()
    expect(asked[0]).toBe("ses_job")
  })

  test("piece A3: a failed audit relay ends the run audit_failed (exit 2)", async () => {
    const { exitCode, result } = await runWith({
      jobMode: true,
      git: noGit(),
      spec: { ...validSpec, branch: "kete/job/abc" },
      auditFiles: { "/repo/.git": "" },
      extra: {
        readAudit: async () => JSON.stringify({ type: "run", event: "ended", root_id: "ses_job", reason: "completed" }) + "\n",
        auditFailure: () => "EPIPE",
      },
    })
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("audit_failed")
    expect(result.message).toContain("EPIPE")
    expect(result.audit_log).toBeUndefined()
  })

  test("piece A3: a relay that fails during the poll (the run-ended push failed) is audit_failed, not the event fallback", async () => {
    let polls = 0
    let failure: string | undefined
    const client = fakeClient()
    client.pushEvent({
      id: "evt_ok",
      created: 0,
      type: "session.execution.succeeded",
      durable: { aggregateID: "ses_job", seq: 1, version: 1 },
      data: { sessionID: "ses_job" },
    } as never)
    const { exitCode, result } = await runWith({
      jobMode: true,
      git: noGit(),
      client,
      spec: { ...validSpec, branch: "kete/job/abc" },
      auditFiles: { "/repo/.git": "" },
      extra: {
        // The relay forwarded `run started` but its `run ended` push failed: never kept.
        readAudit: async () => {
          polls++
          if (polls === 2) failure = "timeout"
          return JSON.stringify({ type: "run", event: "started", root_id: "ses_job" }) + "\n"
        },
        auditFailure: () => failure,
      },
    })
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("audit_failed")
    expect(result.message).toContain("timeout")
  })
})
