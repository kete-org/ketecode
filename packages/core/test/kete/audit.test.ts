// Pure/unit tests for kete/audit.ts: the writer (create/append, redaction, the per-run cap, file
// modes) and the handlers, called directly over a hand-built `Deps`/`Lookup` rather than through
// real services. Real-service, hook-order coverage (deny/allow lines, subagent -> root file,
// interactive writes nothing) is in audit-service.test.ts.
import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { DateTime, Duration, Effect } from "effect"
import { TestConsole } from "effect/testing"
import { Money } from "@opencode/schema/money"
import { AbsolutePath } from "@opencode/schema/schema"
import { Global } from "@opencode/util/global"
import { KeteAudit } from "@opencode/core/kete/audit"
import { KeteUnattended } from "@opencode/core/kete/unattended"
import { KeteUnattendedPolicy } from "@opencode/core/kete/unattended-policy"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import type { SessionSchema } from "@opencode/core/session/schema"
import { it } from "../lib/effect"
import { withTempDir } from "../fixture/tmpdir"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const rootID = Session.ID.make("ses_root")
const childID = Session.ID.make("ses_child")

const sessionInfo = (id: SessionSchema.ID): SessionSchema.Info =>
  ({
    id,
    projectID: Project.ID.global,
    cost: Money.USD.make(0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location,
    metadata: { "kete.unattended": { version: 1 } },
  }) as SessionSchema.Info

const root: KeteUnattendedPolicy.Unattended = { kind: "unattended", policy: { version: 1 }, root: sessionInfo(rootID) }

/** A `Deps` writing under `dir`, resolving `rootID` as unattended and everything else interactive. */
function makeDeps(dir: string) {
  const writer = KeteAudit.makeWriterState(dir, KeyedMutex.makeUnsafe<string>())
  const interrupted: string[] = []
  const deps: KeteAudit.Deps = {
    writer,
    resolve: {
      get: (sessionID) => Effect.succeed(sessionID === rootID ? root : { kind: "interactive" as const }),
    },
    stopReason: () => Effect.succeed(undefined),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interrupted.push(sessionID)
      }),
    stepModels: new Map(),
    shellStarts: new Map(),
  }
  return { deps, interrupted }
}

const readLines = async (dir: string, sessionID = rootID) => {
  const text = await readFile(path.join(dir, "audit", `${sessionID}.jsonl`), "utf8")
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

// A bus event payload shape is `{ id, type, created, data, durable, location? }` (schema/event.ts);
// tests only need `type` and `data`, so the rest is filled in loosely.
const busEvent = (type: string, data: Record<string, unknown>) =>
  ({ id: "evt_1", type, created: 0, data, durable: { aggregateID: "agg", seq: 1, version: 1 } }) as any

/** `append`/the handlers assume `begin` already created the root's file, as run-checks.ts always
 * does before any hook can fire for that root; tests that call them directly recreate that. */
const beginFile = (dir: string, sessionID: SessionSchema.ID = rootID) =>
  KeteAudit.create(dir, sessionID, {
    v: 1,
    ts: new Date().toISOString(),
    type: "run",
    event: "started",
    session_id: sessionID,
    root_id: sessionID,
    policy: { version: 1 },
    limits: { missing: [] },
  })

describe("KeteAudit.create", () => {
  test("run: writes the run started line, directory 0700 and file 0600", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const line: KeteAudit.RunStarted = {
            v: 1,
            ts: new Date().toISOString(),
            type: "run",
            event: "started",
            session_id: rootID,
            root_id: rootID,
            policy: { version: 1 },
            limits: { budget_usd: 5, timeout_minutes: 30, missing: [] },
          }
          yield* KeteAudit.create(dir, rootID, line)
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines).toHaveLength(1)
          expect(lines[0]).toMatchObject({ type: "run", event: "started", session_id: rootID, root_id: rootID })
          if (process.platform !== "win32") {
            const fileInfo = yield* Effect.promise(() => stat(path.join(dir, "audit", `${rootID}.jsonl`)))
            const dirInfo = yield* Effect.promise(() => stat(path.join(dir, "audit")))
            expect(fileInfo.mode & 0o777).toBe(0o600)
            expect(dirInfo.mode & 0o777).toBe(0o700)
          }
        }),
      ),
    )
  })

  test("run: a second create call probes instead of overwriting the first line", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const line = (event: "started"): KeteAudit.RunStarted => ({
            v: 1,
            ts: new Date().toISOString(),
            type: "run",
            event,
            session_id: rootID,
            root_id: rootID,
            policy: { version: 1 },
            limits: { missing: [] },
          })
          yield* KeteAudit.create(dir, rootID, line("started"))
          yield* KeteAudit.create(dir, rootID, line("started"))
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines).toHaveLength(1)
        }),
      ),
    )
  })

  test("fails on a root id that isn't a plain id (no path traversal)", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const line: KeteAudit.RunStarted = {
            v: 1,
            ts: new Date().toISOString(),
            type: "run",
            event: "started",
            session_id: rootID,
            root_id: "../evil",
            policy: {},
            limits: { missing: [] },
          }
          const exit = yield* KeteAudit.create(dir, "../evil", line).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }),
      ),
    )
  })
})

describe("KeteAudit.make (begin)", () => {
  test("fail: refuses the step with a clear error when the audit directory can't be created", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          // A *file* at <dir>/audit blocks `mkdir`, on every OS and as root.
          yield* Effect.promise(() => writeFile(path.join(dir, "audit"), "not a directory"))
          const limits: KeteUnattended.Limits = { budget: 5, timeout: Duration.minutes(30), missing: [] }
          const exit = yield* Effect.gen(function* () {
            const begin = yield* KeteAudit.make
            yield* begin(root, rootID, limits)
          }).pipe(Effect.provide(Global.layerWith({ data: dir })), Effect.exit)
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const message = String(exit.cause)
            expect(message).toContain("audit log can't be written")
          }
        }),
      ),
    )
  })

  test("run: writes the policy and computed limits", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const limits: KeteUnattended.Limits = { budget: 5, timeout: Duration.minutes(30), missing: [] }
          yield* Effect.gen(function* () {
            const begin = yield* KeteAudit.make
            yield* begin(root, rootID, limits)
          }).pipe(Effect.provide(Global.layerWith({ data: dir })))
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines[0]).toMatchObject({
            type: "run",
            event: "started",
            policy: { version: 1 },
            limits: { budget_usd: 5, timeout_minutes: 30, missing: [] },
          })
        }),
      ),
    )
  })
})

describe("KeteAudit handlers", () => {
  test("permission line: records the final effect and a deny message", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* beginFile(dir)
          yield* KeteAudit.onEvaluate(deps, {
            sessionID: rootID,
            action: "shell",
            resources: ["rm -rf /"],
            effect: "deny",
            message: "unattended run: not allowed by this run's policy",
          })
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines.filter((line) => line.type === "permission")).toHaveLength(1)
          expect(lines.find((line) => line.type === "permission")).toMatchObject({ type: "permission", action: "shell", effect: "deny", message: "unattended run: not allowed by this run's policy" })
        }),
      ),
    )
  })

  test("interactive: writes nothing", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* KeteAudit.onEvaluate(deps, { sessionID: childID, action: "shell", resources: ["ls"], effect: "ask" })
          const exists = yield* Effect.promise(() =>
            stat(path.join(dir, "audit", `${childID}.jsonl`)).then(
              () => true,
              () => false,
            ),
          )
          expect(exists).toBe(false)
        }),
      ),
    )
  })

  test("tool line: a completed call, plus a derived file line for edit", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* beginFile(dir)
          yield* KeteAudit.onToolAfter(deps, {
            tool: "edit",
            sessionID: rootID,
            agent: "build",
            messageID: "msg_1",
            id: "call_1",
            input: { path: "src/a.ts", oldString: "a", newString: "b" },
            status: "completed",
            result: { output: { files: [{ file: "src/a.ts", patch: "", additions: 1, deletions: 1, status: "modified" }], replacements: 1 } },
          } as any)
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines.find((line) => line.type === "tool")).toMatchObject({ tool: "edit", status: "completed" })
          expect(lines.find((line) => line.type === "file")).toMatchObject({ path: "src/a.ts", operation: "edit" })
        }),
      ),
    )
  })

  test("a ~5 MB tool result is bounded and written within a small time budget", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* beginFile(dir)
          const big = "x".repeat(5 * 1024 * 1024)
          const start = Date.now()
          yield* KeteAudit.onToolAfter(deps, {
            tool: "webfetch",
            sessionID: rootID,
            agent: "build",
            messageID: "msg_1",
            id: "call_big",
            input: { url: "https://example.com" },
            status: "completed",
            result: { output: { text: big } },
          } as any)
          const elapsed = Date.now() - start
          // Bounding the redactor's scan window (PRE_REDACT_WINDOW_BYTES) keeps this near-instant
          // regardless of the result's real size; a regression back to redacting the whole 5 MB
          // string would take far longer than this budget.
          expect(elapsed).toBeLessThan(1000)
          const lines = yield* Effect.promise(() => readLines(dir))
          const tool = lines.find((line) => line.type === "tool")
          expect(tool.output_bytes).toBeGreaterThan(5 * 1024 * 1024 - 100)
          const serializedBytes = Buffer.byteLength(JSON.stringify(tool), "utf8")
          expect(serializedBytes).toBeLessThanOrEqual(KeteAudit.MAX_LINE_BYTES)
        }),
      ),
    )
  })

  test("command line: a shell call records cwd, exit and duration", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* beginFile(dir)
          deps.shellStarts.set("call_2", Date.now() - 10)
          yield* KeteAudit.onToolAfter(deps, {
            tool: "shell",
            sessionID: rootID,
            agent: "build",
            messageID: "msg_1",
            id: "call_2",
            input: { command: "echo hi", workdir: "/project" },
            status: "completed",
            result: { output: { exit: 0, truncated: false, output: "hi", status: "completed" } },
          } as any)
          const lines = yield* Effect.promise(() => readLines(dir))
          const command = lines.find((line) => line.type === "command")
          expect(command).toMatchObject({ command: "echo hi", cwd: "/project", exit: 0, background: false })
          expect(command!.duration_ms).toBeGreaterThanOrEqual(0)
        }),
      ),
    )
  })

  test("a broken run fails a further tool call instead of writing", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps, interrupted } = makeDeps(dir)
          deps.writer.broken.add(rootID)
          const exit = yield* KeteAudit.onToolBefore(deps, {
            tool: "shell",
            sessionID: rootID,
            agent: "build",
            messageID: "msg_1",
            id: "call_3",
            input: { command: "echo hi" },
          } as any).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          expect(interrupted).toEqual([])
        }),
      ),
    )
  })

  it.effect(
    "a write failure mid-run marks the root broken, logs, and interrupts it (root-proof: a directory in place of the file, not a permission bit)",
    () =>
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps, interrupted } = makeDeps(dir)
          yield* beginFile(dir)
          // Replace the root's file with a directory of the same name: `appendFile` then fails
          // with EISDIR regardless of the user's privileges (unlike a permission bit, which root
          // bypasses) — the same "works on every OS and as root" requirement as the mkdir-blocked
          // fail-closed test above.
          const file = path.join(dir, "audit", `${rootID}.jsonl`)
          yield* Effect.promise(() => rm(file))
          yield* Effect.promise(() => mkdir(file))

          yield* KeteAudit.onEvaluate(deps, {
            sessionID: rootID,
            action: "shell",
            resources: ["ls"],
            effect: "allow",
          })

          expect(deps.writer.broken.has(rootID)).toBe(true)
          expect(interrupted).toEqual([rootID])
          // The default logger writes through `console.log` (not `.error`) unless `LogToStderr` is
          // set, so the failure shows up in `logLines`, not `errorLines`.
          const logs = yield* TestConsole.logLines
          expect(logs.some((line) => String(line).toLowerCase().includes("failed to write an audit line"))).toBe(true)
        }),
      ),
  )

  test("run: onEvent writes run ended with the completed reason for the root's own Execution.Succeeded", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* beginFile(dir)
          yield* KeteAudit.onEvent(deps, busEvent("session.execution.succeeded", { sessionID: rootID }))
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines.find((line) => line.event === "ended")).toMatchObject({ type: "run", event: "ended", reason: "completed" })
        }),
      ),
    )
  })

  test("model line: pairs Step.Started's model with Step.Ended's cost and tokens", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const { deps } = makeDeps(dir)
          yield* beginFile(dir)
          yield* KeteAudit.onEvent(
            deps,
            busEvent("session.step.started", {
              sessionID: rootID,
              assistantMessageID: "msg_1",
              agent: "build",
              model: { id: "sonnet", providerID: "anthropic" },
              started: 0,
            }),
          )
          yield* KeteAudit.onEvent(
            deps,
            busEvent("session.step.ended", {
              sessionID: rootID,
              assistantMessageID: "msg_1",
              finish: "stop",
              cost: 0.01,
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
          )
          const lines = yield* Effect.promise(() => readLines(dir))
          const model = lines.find((line) => line.type === "model")
          expect(model).toMatchObject({ provider: "anthropic", model: "sonnet", cost_usd: 0.01, finish: "stop" })
        }),
      ),
    )
  })
})

describe("KeteAudit.append", () => {
  test("redact: a tool line's input and excerpt are redacted before being written", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const writer = KeteAudit.makeWriterState(dir, KeyedMutex.makeUnsafe<string>())
          yield* beginFile(dir)
          const line: KeteAudit.ToolLine = {
            v: 1,
            ts: new Date().toISOString(),
            type: "tool",
            session_id: rootID,
            root_id: rootID,
            tool: "shell",
            agent: "build",
            input: JSON.stringify({ command: "curl -H 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx0123' https://example.com" }),
            status: "completed",
            excerpt: "PASSWORD=hunter2",
          }
          yield* KeteAudit.append(writer, rootID, line, "detail")
          const text = yield* Effect.promise(() => readFile(path.join(dir, "audit", `${rootID}.jsonl`), "utf8"))
          expect(text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx0123")
          expect(text).not.toContain("hunter2")
          expect(text).toContain("[REDACTED]")
        }),
      ),
    )
  })

  test("redact: a string field longer than 2 KB is truncated", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const writer = KeteAudit.makeWriterState(dir, KeyedMutex.makeUnsafe<string>())
          yield* beginFile(dir)
          const line: KeteAudit.ToolLine = {
            v: 1,
            ts: new Date().toISOString(),
            type: "tool",
            session_id: rootID,
            root_id: rootID,
            tool: "read",
            agent: "build",
            input: "{}",
            status: "completed",
            excerpt: "x".repeat(5000),
          }
          yield* KeteAudit.append(writer, rootID, line, "detail")
          const lines = yield* Effect.promise(() => readLines(dir))
          const tool = lines.find((entry) => entry.type === "tool")
          expect(Buffer.byteLength(tool.excerpt, "utf8")).toBeLessThanOrEqual(KeteAudit.MAX_FIELD_BYTES)
        }),
      ),
    )
  })

  test("cap: past the per-run cap, one truncated line is written and further detail is skipped", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const writer = KeteAudit.makeWriterState(dir, KeyedMutex.makeUnsafe<string>())
          yield* beginFile(dir)
          writer.bytes.set(rootID, KeteAudit.MAX_RUN_BYTES - 10)
          const detail: KeteAudit.ToolLine = {
            v: 1,
            ts: new Date().toISOString(),
            type: "tool",
            session_id: rootID,
            root_id: rootID,
            tool: "read",
            agent: "build",
            input: "{}",
            status: "completed",
          }
          yield* KeteAudit.append(writer, rootID, detail, "detail")
          yield* KeteAudit.append(writer, rootID, { ...detail }, "detail")
          const permission: KeteAudit.PermissionLine = {
            v: 1,
            ts: new Date().toISOString(),
            type: "permission",
            session_id: rootID,
            root_id: rootID,
            action: "shell",
            resources: ["ls"],
            effect: "deny",
          }
          yield* KeteAudit.append(writer, rootID, permission, "always")
          const lines = yield* Effect.promise(() => readLines(dir))
          expect(lines.filter((line) => line.type === "truncated")).toHaveLength(1)
          expect(lines.filter((line) => line.type === "tool")).toHaveLength(0)
          expect(lines.filter((line) => line.type === "permission")).toHaveLength(1)
        }),
      ),
    )
  })

  test("cap: an array field is capped to 20 items", async () => {
    await Effect.runPromise(
      withTempDir(({ path: dir }) =>
        Effect.gen(function* () {
          const writer = KeteAudit.makeWriterState(dir, KeyedMutex.makeUnsafe<string>())
          yield* beginFile(dir)
          const line: KeteAudit.PermissionLine = {
            v: 1,
            ts: new Date().toISOString(),
            type: "permission",
            session_id: rootID,
            root_id: rootID,
            action: "shell",
            resources: Array.from({ length: 30 }, (_, i) => `resource-${i}`),
            effect: "allow",
          }
          yield* KeteAudit.append(writer, rootID, line, "always")
          const lines = yield* Effect.promise(() => readLines(dir))
          const permission = lines.find((entry) => entry.type === "permission")
          expect(permission.resources).toHaveLength(KeteAudit.MAX_ARRAY_ITEMS)
        }),
      ),
    )
  })
})
