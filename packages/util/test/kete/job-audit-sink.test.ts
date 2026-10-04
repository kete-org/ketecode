// KeteJobAuditSink (job mode piece A3, AC3): descriptor parsing, write-once, serialized and timed
// writes to a real pipe, EPIPE on a closed reader, the relay's cap and its line tee.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteJobAuditSink } from "../../src/kete/job-audit-sink.js"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kete-audit-sink-"))
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

let counter = 0
/** A named pipe: the read end opened non-blocking first, then a blocking write end. */
function pipe() {
  const file = path.join(directory, `fifo-${counter++}`)
  const made = Bun.spawnSync(["mkfifo", file])
  if (made.exitCode !== 0) throw new Error("mkfifo failed")
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
    return Buffer.concat(chunks).toString("utf8")
  }
  return { file, reader, writer, drain }
}

describe("parse and validate", () => {
  test("missing, invalid and valid descriptor numbers", () => {
    expect(KeteJobAuditSink.parse({})).toEqual({ kind: "missing" })
    expect(KeteJobAuditSink.parse({ OPENCODE_JOB_AUDIT_FD: "" })).toEqual({ kind: "missing" })
    expect(KeteJobAuditSink.parse({ OPENCODE_JOB_AUDIT_FD: "2" })).toEqual({ kind: "invalid" })
    expect(KeteJobAuditSink.parse({ OPENCODE_JOB_AUDIT_FD: "4x" })).toEqual({ kind: "invalid" })
    expect(KeteJobAuditSink.parse({ OPENCODE_JOB_AUDIT_FD: "4" })).toEqual({ kind: "fd", fd: 4 })
    expect(KeteJobAuditSink.publicName).toBe("KETE_JOB_AUDIT_FD")
  })

  test("a pipe passes; a regular file and a closed descriptor don't", () => {
    const p = pipe()
    expect(KeteJobAuditSink.validate(p.writer, "fifo")).toBeUndefined()
    expect(KeteJobAuditSink.validate(p.writer, "fifo-or-socket")).toBeUndefined()
    const file = fs.openSync(path.join(directory, "regular"), "w")
    expect(KeteJobAuditSink.validate(file, "fifo")).toBe(`descriptor ${file} is not a pipe`)
    fs.closeSync(file)
    expect(KeteJobAuditSink.validate(file, "fifo")).toBe(`descriptor ${file} is not open`)
    fs.closeSync(p.writer)
    fs.closeSync(p.reader)
  })

  test("set is write-once", () => {
    const p = pipe()
    expect(KeteJobAuditSink.get()).toBeUndefined()
    KeteJobAuditSink.set(p.writer)
    expect(KeteJobAuditSink.get()?.fd).toBe(p.writer)
    expect(() => KeteJobAuditSink.set(p.writer)).toThrow(/already set/)
  })
})

describe("writer", () => {
  test("serializes lines in order and counts bytes", async () => {
    const p = pipe()
    const sink = KeteJobAuditSink.writer(p.writer)
    await Promise.all(["a\n", "bb\n", "ccc\n"].map((line) => sink.write(new TextEncoder().encode(line))))
    expect(p.drain()).toBe("a\nbb\nccc\n")
    expect(sink.written()).toBe(9)
    fs.closeSync(p.writer)
    fs.closeSync(p.reader)
  })

  test("a closed reader fails with EPIPE, and the failure is sticky", async () => {
    const p = pipe()
    const sink = KeteJobAuditSink.writer(p.writer)
    fs.closeSync(p.reader)
    await expect(sink.write(new TextEncoder().encode("x\n"))).rejects.toThrow(/EPIPE/)
    expect(sink.failure()).toBe("EPIPE")
    await expect(sink.write(new TextEncoder().encode("y\n"))).rejects.toThrow(/EPIPE/)
    fs.closeSync(p.writer)
  })

  test("a full pipe times out", async () => {
    const sink = KeteJobAuditSink.writer(99, { timeoutMs: 50, raw: () => new Promise(() => {}) })
    await expect(sink.write(new Uint8Array(10))).rejects.toThrow(/timeout/)
    expect(sink.failure()).toBe("timeout")
  })

  test("EAGAIN waits for room within the deadline", async () => {
    let calls = 0
    const sink = KeteJobAuditSink.writer(99, {
      raw: async (_fd, _bytes, _offset, length) => {
        calls++
        if (calls < 3) throw Object.assign(new Error("again"), { code: "EAGAIN" })
        return length
      },
    })
    await sink.write(new Uint8Array(5))
    expect(sink.written()).toBe(5)
  })
})

describe("relay", () => {
  const line = (value: Record<string, unknown>) => JSON.stringify(value) + "\n"

  test("forwards bytes unchanged and keeps run/model/permission lines per root, across chunk boundaries", async () => {
    const p = pipe()
    const relay = KeteJobAuditSink.relay(KeteJobAuditSink.writer(p.writer))
    const text =
      line({ type: "run", event: "started", root_id: "ses_a" }) +
      line({ type: "tool", root_id: "ses_a" }) +
      line({ type: "model", root_id: "ses_a", cost_usd: 0.5 }) +
      line({ type: "permission", root_id: "ses_b", effect: "deny" }) +
      line({ type: "run", event: "ended", root_id: "ses_a", reason: "completed" })
    const bytes = new TextEncoder().encode(text)
    for (let offset = 0; offset < bytes.byteLength; offset += 7) await relay.push(bytes.subarray(offset, offset + 7))
    expect(p.drain()).toBe(text)
    expect(relay.forwarded()).toBe(bytes.byteLength)
    const kept = relay.read("ses_a")!.trim().split("\n").map((item) => JSON.parse(item).type)
    expect(kept).toEqual(["run", "model", "run"])
    expect(relay.read("ses_b")).toContain("permission")
    expect(relay.read("ses_c")).toBeUndefined()
    fs.closeSync(p.writer)
    fs.closeSync(p.reader)
  })

  test("stops above the byte cap, and stays stopped", async () => {
    const p = pipe()
    const relay = KeteJobAuditSink.relay(KeteJobAuditSink.writer(p.writer), { maxBytes: 10 })
    await relay.push(new Uint8Array(10))
    await expect(relay.push(new Uint8Array(1))).rejects.toThrow(/audit-cap/)
    expect(relay.failure()).toBe("audit-cap")
    await expect(relay.push(new Uint8Array(0))).rejects.toThrow(/audit-cap/)
    fs.closeSync(p.writer)
    fs.closeSync(p.reader)
  })

  test("a closed downstream pipe fails the relay", async () => {
    const p = pipe()
    const relay = KeteJobAuditSink.relay(KeteJobAuditSink.writer(p.writer))
    fs.closeSync(p.reader)
    await expect(relay.push(new TextEncoder().encode("x\n"))).rejects.toThrow(/EPIPE/)
    expect(relay.failure()).toBe("EPIPE")
    fs.closeSync(p.writer)
  })

  test("keeps at most maxLines non-run lines, always the run lines", async () => {
    const p = pipe()
    const relay = KeteJobAuditSink.relay(KeteJobAuditSink.writer(p.writer), { maxLines: 2 })
    for (let index = 0; index < 5; index++) await relay.push(new TextEncoder().encode(line({ type: "model", root_id: "r" })))
    await relay.push(new TextEncoder().encode(line({ type: "run", event: "ended", root_id: "r" })))
    p.drain()
    const kept = relay.read("r")!.trim().split("\n")
    expect(kept.length).toBe(3)
    fs.closeSync(p.writer)
    fs.closeSync(p.reader)
  })
})
