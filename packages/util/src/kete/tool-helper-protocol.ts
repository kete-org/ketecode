// The root helper's wire protocol v1 (packages/kete-root-helper/README.md "Protocol v1"): a
// length-prefixed frame per message, JSON control bodies decoded strictly, and small binary
// bodies for flow control and stream framing. Pure: no I/O, no node:net — tool-helper.ts is the
// client that actually speaks this over a socket. Frame and message shapes here are pinned to the
// Go helper's internal/protocol package by shared test vectors
// (packages/kete-root-helper/internal/protocol/testdata/vectors.json), read by both test suites.

export * as KeteToolHelperProtocol from "./tool-helper-protocol.js"

import { Schema } from "effect"

/** The only protocol version this build implements. */
export const protocolVersion = 1

export const Type = {
  helloC2H: 0x01,
  spawn: 0x02,
  stdin: 0x03,
  stdinEnd: 0x04,
  credit: 0x05,
  kill: 0x06,
  helloH2C: 0x41,
  spawned: 0x42,
  stdout: 0x43,
  stderr: 0x44,
  eof: 0x45,
  exit: 0x46,
  error: 0x47,
  stdinCredit: 0x48,
} as const
export type Type = (typeof Type)[keyof typeof Type]

/** Whether `type` carries raw stream bytes (capped at `dataFrameMax`) rather than a control body
 * (capped at the negotiated `maxFrame`). */
export function isDataFrame(type: number): boolean {
  return type === Type.stdin || type === Type.stdout || type === Type.stderr
}

/** Hard cap on STDIN/STDOUT/STDERR frame bodies, independent of `maxFrame`. */
export const dataFrameMax = 64 * 1024

export const streamStdout = 1
export const streamStderr = 2

export const maxArgv = 4096
export const maxEnvEntries = 1024
export const handshakeTimeoutMs = 5_000
export const maxOutstandingCredit = 16 * 1024 * 1024

export type ErrorCode =
  | "version"
  | "peer"
  | "too_large"
  | "bad_request"
  | "rate"
  | "busy"
  | "env"
  | "cwd"
  | "not_found"
  | "exec"
  | "identity"
  | "nnp"
  | "internal"

export interface Limits {
  readonly maxFrame: number
}

function maxBody(type: number, limits: Limits): number {
  if (isDataFrame(type)) return Math.min(limits.maxFrame, dataFrameMax)
  return limits.maxFrame
}

/** Thrown when a frame's declared body length exceeds its limit — the header is always read in
 * full; the body never is. */
export class FrameTooLargeError extends Error {
  override readonly name = "KeteToolHelperProtocol.FrameTooLargeError"
}

export interface Frame {
  readonly type: number
  readonly body: Uint8Array
}

/** Encodes one frame: a 4-byte big-endian body length, a 1-byte type, then the body. */
export function encodeFrame(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length, false)
  view.setUint8(4, type)
  out.set(body, 5)
  return out
}

/** Incrementally decodes frames out of a byte stream. `push` returns every complete frame the
 * newly appended chunk completes (zero, one, or more); throws `FrameTooLargeError` as soon as a
 * frame's declared length is known to exceed its limit, without waiting for (or allocating) the
 * body. */
export class FrameDecoder {
  private chunks: Array<Uint8Array> = []
  private length = 0

  constructor(private readonly limits: Limits) {}

  push(chunk: Uint8Array): Array<Frame> {
    this.chunks.push(chunk)
    this.length += chunk.length
    const frames: Array<Frame> = []
    for (;;) {
      if (this.length < 5) break
      const header = this.peek(5)
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      const bodyLength = view.getUint32(0, false)
      const type = view.getUint8(4)
      const limit = maxBody(type, this.limits)
      if (bodyLength > limit) throw new FrameTooLargeError(`frame body (${bodyLength} bytes) exceeds the limit (${limit})`)
      const total = 5 + bodyLength
      if (this.length < total) break
      const full = this.take(total)
      frames.push({ type, body: full.subarray(5) })
    }
    return frames
  }

  /** Bytes buffered but not yet part of a complete frame. */
  get pending(): number {
    return this.length
  }

  private consolidate(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!
    const merged = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = [merged]
    return merged
  }

  private peek(n: number): Uint8Array {
    return this.consolidate().subarray(0, n)
  }

  private take(n: number): Uint8Array {
    const merged = this.consolidate()
    const out = merged.subarray(0, n)
    this.chunks = merged.length > n ? [merged.subarray(n)] : []
    this.length -= n
    return out
  }
}

// Control message bodies (strict JSON: unknown fields, wrong types, or trailing data all fail).
// Schema.parseJson decodes then validates in one step; Effect's default excess-property handling
// already fails a decode when the *shape* mismatches, but excess properties are silently dropped
// unless told otherwise — onExcessProperty: "error" at the call site (below) makes an unknown
// field a decode failure too, matching the Go side's json.Decoder.DisallowUnknownFields.

export const HelloC2H = Schema.Struct({ protocol: Schema.Number })
export type HelloC2H = typeof HelloC2H.Type

export const HelloH2C = Schema.Struct({
  protocol: Schema.Number,
  maxFrame: Schema.Number,
  dataChunk: Schema.Number,
  stdinWindow: Schema.Number,
  outputWindow: Schema.Number,
  env: Schema.Array(Schema.String),
})
export type HelloH2C = typeof HelloH2C.Type

const EnvPairSchema = Schema.Tuple([Schema.String, Schema.String])
/** A `[name, value]` entry in a SPAWN request's env list. */
export type EnvPair = typeof EnvPairSchema.Type

export const Spawn = Schema.Struct({
  argv: Schema.Array(Schema.String),
  env: Schema.Array(EnvPairSchema),
  cwd: Schema.String,
  stdin: Schema.Literals(["pipe", "null"]),
  stdout: Schema.Literals(["pipe", "null"]),
  stderr: Schema.Literals(["pipe", "null"]),
})
export type Spawn = typeof Spawn.Type

export const Spawned = Schema.Struct({ pid: Schema.Number, id: Schema.String })
export type Spawned = typeof Spawned.Type

export const Kill = Schema.Struct({
  signal: Schema.String,
  scope: Schema.Literals(["process", "group"]),
})
export type Kill = typeof Kill.Type

export const Exit = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
})
export type Exit = typeof Exit.Type

export const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String })
export type ErrorBody = typeof ErrorBody.Type

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

/** Strictly decodes a JSON control body: invalid UTF-8, malformed JSON, a schema mismatch, or an
 * unknown field all throw. */
export function decodeJson<A, I extends object>(schema: Schema.Codec<A, I>, body: Uint8Array): A {
  const text = textDecoder.decode(body)
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(JSON.parse(text))
}

export function encodeJson<A, I extends object>(schema: Schema.Codec<A, I>, value: A): Uint8Array {
  const encoded = Schema.encodeUnknownSync(schema)(value)
  return textEncoder.encode(JSON.stringify(encoded))
}

// Binary bodies -----------------------------------------------------------------------------

export function encodeStdinCredit(bytesAvailable: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, bytesAvailable, false)
  return out
}

export function decodeStdinCredit(body: Uint8Array): number {
  if (body.length !== 4) throw new Error("STDIN_CREDIT body must be 4 bytes")
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false)
}

export function encodeCredit(stream: number, n: number): Uint8Array {
  const out = new Uint8Array(5)
  out[0] = stream
  new DataView(out.buffer).setUint32(1, n, false)
  return out
}

export function decodeCredit(body: Uint8Array): { readonly stream: number; readonly n: number } {
  if (body.length !== 5) throw new Error("CREDIT body must be 5 bytes")
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  return { stream: view.getUint8(0), n: view.getUint32(1, false) }
}

export function encodeEOF(stream: number): Uint8Array {
  return new Uint8Array([stream])
}

export function decodeEOF(body: Uint8Array): number {
  if (body.length !== 1) throw new Error("EOF body must be 1 byte")
  return body[0]!
}
