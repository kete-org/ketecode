// kete/audit.ts in job mode (job mode piece A3, AC3): the log goes only to the inherited pipe, no
// `<data>/audit` directory is created, a closed pipe marks the root broken and interrupts it, the
// byte caps of N3 hold, and job mode without a sink refuses the step.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DateTime, Duration, Effect } from "effect"
import { Money } from "@opencode/schema/money"
import { AbsolutePath } from "@opencode/schema/schema"
import { Global } from "@opencode/util/global"
import { KeteJobAuditSink } from "@opencode/util/kete/job-audit-sink"
import { KeteAudit } from "@opencode/core/kete/audit"
import type { KeteUnattended } from "@opencode/core/kete/unattended"
import type { KeteUnattendedPolicy } from "@opencode/core/kete/unattended-policy"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import type { SessionSchema } from "@opencode/core/session/schema"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const rootID = Session.ID.make("ses_sinkroot")
const info = {
  id: rootID,
  projectID: Project.ID.global,
  cost: Money.USD.make(0),
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location,
  metadata: { "kete.unattended": { version: 1 } },
} as SessionSchema.Info
const root: KeteUnattendedPolicy.Unattended = { kind: "unattended", policy: { version: 1 }, root: info }
const limits: KeteUnattended.Limits = { budget: 5, timeout: Duration.minutes(30), missing: [] }

const started: KeteAudit.RunStarted = {
  v: 1,
  ts: "2026-10-01T00:00:00.000Z",
  type: "run",
  event: "started",
  session_id: rootID,
  root_id: rootID,
  policy: { version: 1 },
  limits: { missing: [] },
}

let counter = 0
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kete-audit-sink-core-"))
function pipe() {
  const file = path.join(directory, `fifo-${counter++}`)
  if (Bun.spawnSync(["mkfifo", file]).exitCode !== 0) throw new Error("mkfifo failed")
  const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  const writer = fs.openSync(file, fs.constants.O_WRONLY)
  const drain = () => {
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(65536)
    for (;;) {
      try {
        const count = fs.readSync(reader, buffer)
        if (count === 0) break
        chunks.push(Buffer.from(buffer.subarray(0, count)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") break
        throw error
      }
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  return { reader, writer, drain }
}

function deps(dataDir: string, storage: KeteAudit.Storage) {
  const interrupted: string[] = []
  const value: KeteAudit.Deps = {
    writer: KeteAudit.makeWriterState(dataDir, KeyedMutex.makeUnsafe<string>(), storage),
    resolve: { get: (sessionID) => Effect.succeed(sessionID === rootID ? root : { kind: "interactive" as const }) },
    stopReason: () => Effect.succeed(undefined),
    interrupt: (sessionID) => Effect.sync(() => void interrupted.push(sessionID)),
    stepModels: new Map(),
    shellStarts: new Map(),
  }
  return { deps: value, interrupted }
}

const toolAfter = (id: string, excerpt = "ok") =>
  ({
    sessionID: rootID,
    messageID: "msg_1",
    id,
    tool: "read",
    agent: "build",
    input: { path: "a" },
    status: "completed",
    result: { output: excerpt },
  }) as never

describe("storage selection", () => {
  test("job mode (on or invalid) uses the sink, otherwise the file", () => {
    expect(KeteAudit.storageFor({}).kind).toBe("file")
    expect(KeteAudit.storageFor({ OPENCODE_JOB_MODE: "1" }).kind).toBe("sink")
    expect(KeteAudit.storageFor({ OPENCODE_JOB_MODE: "yes" }).kind).toBe("sink")
  })
})

describe("sink storage", () => {
  test("run started once per root, then detail lines, all on the pipe; no <data>/audit", async () => {
    const p = pipe()
    const writer = KeteJobAuditSink.writer(p.writer)
    const storage: KeteAudit.Storage = { kind: "sink", writer: () => writer }
    const data = fs.mkdtempSync(path.join(directory, "data-"))
    await Effect.runPromise(KeteAudit.createSink(storage, rootID, started))
    await Effect.runPromise(KeteAudit.createSink(storage, rootID, started))
    const { deps: d } = deps(data, storage)
    await Effect.runPromise(KeteAudit.onToolAfter(d, toolAfter("call_1")))
    const lines = p.drain()
    expect(lines.map((line) => line["type"])).toEqual(["run", "tool"])
    expect(fs.existsSync(path.join(data, "audit"))).toBe(false)
    fs.closeSync(p.writer)
    fs.closeSync(p.reader)
  })

  test("a closed pipe marks the root broken, interrupts it, and refuses the next tool call and step", async () => {
    const p = pipe()
    const writer = KeteJobAuditSink.writer(p.writer)
    const storage: KeteAudit.Storage = { kind: "sink", writer: () => writer }
    await Effect.runPromise(KeteAudit.createSink(storage, rootID, started))
    fs.closeSync(p.reader)
    const { deps: d, interrupted } = deps(directory, storage)
    await Effect.runPromise(KeteAudit.onToolAfter(d, toolAfter("call_2")))
    expect(interrupted).toEqual([rootID])
    expect(d.writer.broken.has(rootID)).toBe(true)
    const before = await Effect.runPromise(
      Effect.exit(KeteAudit.onToolBefore(d, { sessionID: rootID, tool: "read", id: "call_3" } as never)),
    )
    expect(before._tag).toBe("Failure")
    const again = await Effect.runPromise(Effect.exit(KeteAudit.createSink(storage, rootID, started)))
    expect(again._tag).toBe("Failure")
    expect(String(again)).toContain("EPIPE")
    fs.closeSync(p.writer)
  })

  test("N3: detail lines stop at 19,000,000 bytes with one truncated line; past 20,000,000 is a failure", async () => {
    let bytes = 0
    const writer = KeteJobAuditSink.writer(99, {
      raw: async (_fd, _data, _offset, length) => {
        bytes += length
        return length
      },
    })
    const storage: KeteAudit.Storage = { kind: "sink", writer: () => writer }
    const state = KeteAudit.makeWriterState(directory, KeyedMutex.makeUnsafe<string>(), storage)
    await Effect.runPromise(KeteAudit.createSink(storage, rootID, started))
    const big: KeteAudit.ToolLine = {
      v: 1,
      ts: "2026-10-01T00:00:00.000Z",
      type: "tool",
      session_id: rootID,
      root_id: rootID,
      tool: "read",
      agent: "build",
      input: "i".repeat(2000),
      status: "completed",
      excerpt: "e".repeat(2000),
    }
    // Append until a detail line no longer adds bytes (the cap was reached, `truncated` written).
    for (let index = 0; index < 20_000; index++) {
      const before = bytes
      await Effect.runPromise(KeteAudit.append(state, rootID, big, "detail"))
      if (bytes === before) break
    }
    expect(bytes).toBeLessThanOrEqual(KeteJobAuditSink.MAX_DETAIL_BYTES + 1000)
    const afterDetail = bytes
    await Effect.runPromise(KeteAudit.append(state, rootID, big, "detail"))
    expect(bytes).toBe(afterDetail)
    // "always" lines continue into the reserve, then fail at the hard cap.
    const permission: KeteAudit.PermissionLine = {
      v: 1,
      ts: "2026-10-01T00:00:00.000Z",
      type: "permission",
      session_id: rootID,
      root_id: rootID,
      action: "read",
      resources: ["x".repeat(1500)],
      effect: "allow",
    }
    let failure: string | undefined
    for (let count = 0; count < 2000 && failure === undefined; count++) {
      const exit = await Effect.runPromise(Effect.exit(KeteAudit.append(state, rootID, permission, "always")))
      if (exit._tag === "Failure") failure = String(exit.cause)
    }
    expect(failure).toContain("audit-cap")
    expect(bytes).toBeLessThanOrEqual(KeteJobAuditSink.MAX_TOTAL_BYTES)
  }, 120_000)

  test("job mode without a sink refuses the step (begin)", async () => {
    const previous = process.env.OPENCODE_JOB_MODE
    process.env.OPENCODE_JOB_MODE = "1"
    try {
      const data = fs.mkdtempSync(path.join(directory, "data-"))
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const begin = yield* KeteAudit.make
          yield* begin(root, rootID, limits)
        }).pipe(Effect.provide(Global.layerWith({ data })), Effect.exit),
      )
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("no-audit-sink")
      expect(fs.existsSync(path.join(data, "audit"))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_JOB_MODE
      else process.env.OPENCODE_JOB_MODE = previous
    }
  })
})
