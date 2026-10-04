// The job's audit sink (job mode piece A3, decision D2/N1; kete-code-platform docs/jobs.md §8 item
// 4): in a cloud job nothing `kete` writes for the platform may be rewritable afterwards, so the
// audit log never goes to a file `kete` owns. Instead:
//
// - the entrypoint creates a pipe, keeps the read end and passes the write end as `kete job run`'s
//   fd 4, with KETE_JOB_AUDIT_FD=4 (a contract, contracts.md §6d);
// - `kete job run` can't hand that descriptor to its `kete serve` child (effect's spawner only
//   creates new pipes), so the child writes to its own fd 4 — a pipe to the parent — and the parent
//   relays the bytes unchanged into the entrypoint's pipe (`Relay`), keeping the lines it needs for
//   its own result (`run`, `model`, `permission`);
// - both hops are pipes: neither process can seek, truncate or rewrite a line already sent.
//
// A full or broken pipe is a write failure, which interrupts the run (fail closed), like a failed
// audit write always has. Writes are serialized (no two lines interleave) and time out after 10 s.
//
// The child's writer is the one piece of process-scoped state: set once, before the server boots,
// from the inherited descriptor (the same write-once rule as the gateway key in job-secrets.ts).

export * as KeteJobAuditSink from "./job-audit-sink.js"

import { fstatSync, write as fsWrite } from "node:fs"
import { KeteEnv } from "./env.js"
import { KeteJobSecrets } from "./job-secrets.js"

/** The internal name for KETE_JOB_AUDIT_FD (entrypoint → `kete job run`, and `kete job run` → its
 * `kete serve` child). */
export const variable = "OPENCODE_JOB_AUDIT_FD"
export const publicName = KeteEnv.publicName(variable)

/** The descriptor the audit travels on, in `kete job run` (from the entrypoint) and in its child. */
export const childFd = 4

/** The hard stop: more than this many bytes through the sink is a failure (the entrypoint's cap). */
export const MAX_TOTAL_BYTES = 20_000_000
/** Detail lines stop at this many bytes; the rest is kept for permission/run/truncated lines. */
export const MAX_DETAIL_BYTES = 19_000_000
/** How long one write may wait for room in the pipe. */
export const WRITE_TIMEOUT_MS = 10_000
/** The most lines the relay keeps for `kete job run`'s own result. */
export const MAX_KEPT_LINES = 10_000
const MAX_PARTIAL_LINE_BYTES = 64 * 1024

export type Parsed = { readonly kind: "missing" } | { readonly kind: "invalid" } | { readonly kind: "fd"; readonly fd: number }

/** Reads the variable: unset/empty is `missing`, a descriptor number 3–1023 is `fd`, anything else
 * `invalid`. */
export function parse(env: Record<string, string | undefined>): Parsed {
  const value = env[variable]
  if (value === undefined || value === "") return { kind: "missing" }
  const fd = KeteJobSecrets.parseDescriptor(value)
  return fd === undefined ? { kind: "invalid" } : { kind: "fd", fd }
}

/** `undefined` when `fd` is an open pipe (or, for the child, a socket); else why not. */
export function validate(fd: number, accept: "fifo" | "fifo-or-socket"): string | undefined {
  let stat
  try {
    stat = fstatSync(fd)
  } catch {
    return `descriptor ${fd} is not open`
  }
  if (stat.isFIFO()) return undefined
  if (accept === "fifo-or-socket" && stat.isSocket()) return undefined
  return accept === "fifo" ? `descriptor ${fd} is not a pipe` : `descriptor ${fd} is not a pipe or socket`
}

export class WriteFailure extends Error {
  override readonly name = "KeteJobAuditSink.WriteFailure"
  constructor(readonly code: string) {
    super(`audit sink write failed: ${code}`)
  }
}

const errnoCode = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "EIO"

type Raw = (fd: number, bytes: Uint8Array, offset: number, length: number) => Promise<number>

const rawWrite: Raw = (fd, bytes, offset, length) =>
  new Promise((resolve, reject) =>
    fsWrite(fd, bytes, offset, length, null, (error, written) => (error ? reject(error) : resolve(written))),
  )

/** Serialized, timed writes to one descriptor. A failure is sticky: every later write fails with the
 * same code, since a broken or timed-out pipe may hold a partial line. */
export interface Writer {
  readonly fd: number
  /** Bytes written so far. */
  readonly written: () => number
  /** The first failure, if any. */
  readonly failure: () => string | undefined
  /** Writes all of `bytes`, after every earlier write; rejects with `WriteFailure`. */
  readonly write: (bytes: Uint8Array) => Promise<void>
}

export function writer(fd: number, options: { readonly timeoutMs?: number; readonly raw?: Raw } = {}): Writer {
  const timeoutMs = options.timeoutMs ?? WRITE_TIMEOUT_MS
  const raw = options.raw ?? rawWrite
  let total = 0
  let failed: string | undefined
  let tail: Promise<void> = Promise.resolve()

  const writeAll = async (bytes: Uint8Array) => {
    const deadline = Date.now() + timeoutMs
    let offset = 0
    while (offset < bytes.byteLength) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new WriteFailure("timeout")
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining)
      })
      const result = await Promise.race([
        raw(fd, bytes, offset, bytes.byteLength - offset).then(
          (count) => ({ count }),
          (error: unknown) => ({ error: errnoCode(error) }),
        ),
        timeout,
      ]).finally(() => clearTimeout(timer))
      if (result === "timeout") throw new WriteFailure("timeout")
      if ("error" in result) {
        // A non-blocking descriptor with a full buffer: wait for room, within the deadline.
        if (result.error === "EAGAIN" || result.error === "EWOULDBLOCK") {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        throw new WriteFailure(result.error)
      }
      if (result.count === 0) throw new WriteFailure("EIO")
      offset += result.count
      total += result.count
    }
  }

  return {
    fd,
    written: () => total,
    failure: () => failed,
    write: (bytes) => {
      const run = tail.then(async () => {
        if (failed !== undefined) throw new WriteFailure(failed)
        try {
          await writeAll(bytes)
        } catch (error) {
          failed = error instanceof WriteFailure ? error.code : errnoCode(error)
          throw error instanceof WriteFailure ? error : new WriteFailure(failed)
        }
      })
      tail = run.catch(() => undefined)
      return run
    },
  }
}

let current: Writer | undefined

/** Sets this process's audit sink (the `kete serve` child, from KETE_JOB_AUDIT_FD). Write-once. */
export function set(fd: number): void {
  if (current !== undefined) throw new Error("the job's audit sink is already set")
  current = writer(fd)
}

/** The sink set by `set`, or `undefined`. */
export function get(): Writer | undefined {
  return current
}

const KEPT_TYPES = new Set(["run", "model", "permission"])

/** `kete job run`'s relay: forwards the child's audit bytes unchanged to the entrypoint's pipe,
 * stops above MAX_TOTAL_BYTES, and keeps the `run`/`model`/`permission` lines its result needs. */
export interface Relay {
  /** Forwards one chunk; rejects (and stays failed) on a write failure or the cap. */
  readonly push: (chunk: Uint8Array) => Promise<void>
  /** The first failure, if any. */
  readonly failure: () => string | undefined
  /** The kept lines for one root session, as JSON Lines text (`undefined` when none). */
  readonly read: (rootID: string) => string | undefined
  /** Bytes forwarded so far. */
  readonly forwarded: () => number
}

export function relay(out: Writer, options: { readonly maxBytes?: number; readonly maxLines?: number } = {}): Relay {
  const maxBytes = options.maxBytes ?? MAX_TOTAL_BYTES
  const maxLines = options.maxLines ?? MAX_KEPT_LINES
  const kept: Array<{ readonly root: string; readonly text: string; readonly type: string }> = []
  let other = 0
  let forwarded = 0
  let failed: string | undefined
  let partial = ""
  let dropping = false
  const decoder = new TextDecoder()

  const keep = (line: string) => {
    if (line.trim() === "") return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== "object") return
    const record = parsed as Record<string, unknown>
    const type = record["type"]
    const root = record["root_id"]
    if (typeof type !== "string" || !KEPT_TYPES.has(type) || typeof root !== "string") return
    // `run` lines (started/ended, a few per job) are always kept; the others up to the bound.
    if (type !== "run") {
      if (other >= maxLines) return
      other++
    }
    kept.push({ root, text: line, type })
  }

  const tee = (chunk: Uint8Array) => {
    const pieces = (partial + decoder.decode(chunk, { stream: true })).split("\n")
    partial = pieces.pop() ?? ""
    for (const piece of pieces) {
      // The end of a line that grew past the bound while it accumulated: dropped with it.
      if (dropping) dropping = false
      else keep(piece)
    }
    if (partial.length > MAX_PARTIAL_LINE_BYTES) {
      partial = ""
      dropping = true
    }
  }

  return {
    push: async (chunk) => {
      if (failed !== undefined) throw new WriteFailure(failed)
      if (forwarded + chunk.byteLength > maxBytes) {
        failed = "audit-cap"
        throw new WriteFailure(failed)
      }
      try {
        await out.write(chunk)
      } catch (error) {
        failed = error instanceof WriteFailure ? error.code : errnoCode(error)
        throw error instanceof WriteFailure ? error : new WriteFailure(failed)
      }
      forwarded += chunk.byteLength
      tee(chunk)
    },
    failure: () => failed,
    read: (rootID) => {
      const lines = kept.filter((line) => line.root === rootID).map((line) => line.text)
      return lines.length === 0 ? undefined : lines.join("\n") + "\n"
    },
    forwarded: () => forwarded,
  }
}
