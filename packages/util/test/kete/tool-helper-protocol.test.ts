import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { KeteToolHelperProtocol } from "../../src/kete/tool-helper-protocol.js"

const limits: KeteToolHelperProtocol.Limits = { maxFrame: 1024 * 1024 }

describe("FrameDecoder", () => {
  test("decodes a single frame delivered in one chunk", () => {
    const frame = KeteToolHelperProtocol.encodeFrame(KeteToolHelperProtocol.Type.spawn, new TextEncoder().encode("hi"))
    const decoder = new KeteToolHelperProtocol.FrameDecoder(limits)
    const frames = decoder.push(frame)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(KeteToolHelperProtocol.Type.spawn)
    expect(new TextDecoder().decode(frames[0]!.body)).toBe("hi")
    expect(decoder.pending).toBe(0)
  })

  test("decodes a frame split across many small chunks (partial reads)", () => {
    const frame = KeteToolHelperProtocol.encodeFrame(KeteToolHelperProtocol.Type.stdout, new TextEncoder().encode("hello world"))
    const decoder = new KeteToolHelperProtocol.FrameDecoder(limits)
    let frames: Array<KeteToolHelperProtocol.Frame> = []
    for (let i = 0; i < frame.length; i++) {
      frames = frames.concat(decoder.push(frame.subarray(i, i + 1)))
    }
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0]!.body)).toBe("hello world")
  })

  test("decodes multiple frames delivered in one chunk", () => {
    const a = KeteToolHelperProtocol.encodeFrame(KeteToolHelperProtocol.Type.stdinEnd, new Uint8Array())
    const b = KeteToolHelperProtocol.encodeFrame(KeteToolHelperProtocol.Type.eof, KeteToolHelperProtocol.encodeEOF(1))
    const combined = new Uint8Array(a.length + b.length)
    combined.set(a, 0)
    combined.set(b, a.length)
    const decoder = new KeteToolHelperProtocol.FrameDecoder(limits)
    const frames = decoder.push(combined)
    expect(frames.map((f) => f.type)).toEqual([KeteToolHelperProtocol.Type.stdinEnd, KeteToolHelperProtocol.Type.eof])
  })

  test("zero-length body", () => {
    const frame = KeteToolHelperProtocol.encodeFrame(KeteToolHelperProtocol.Type.stdinEnd, new Uint8Array())
    const decoder = new KeteToolHelperProtocol.FrameDecoder(limits)
    const frames = decoder.push(frame)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.body).toHaveLength(0)
  })

  test("unknown frame type is decoded, not rejected (caller decides)", () => {
    const frame = KeteToolHelperProtocol.encodeFrame(0xee, new Uint8Array([1, 2, 3]))
    const decoder = new KeteToolHelperProtocol.FrameDecoder(limits)
    const frames = decoder.push(frame)
    expect(frames[0]!.type).toBe(0xee)
  })

  test("control frame exceeding maxFrame throws FrameTooLargeError as soon as the header is known", () => {
    const small: KeteToolHelperProtocol.Limits = { maxFrame: 16 }
    const decoder = new KeteToolHelperProtocol.FrameDecoder(small)
    const header = new Uint8Array(5)
    new DataView(header.buffer).setUint32(0, 17, false)
    header[4] = KeteToolHelperProtocol.Type.spawn
    expect(() => decoder.push(header)).toThrow(KeteToolHelperProtocol.FrameTooLargeError)
  })

  test("data frame is capped at dataFrameMax independent of maxFrame", () => {
    const generous: KeteToolHelperProtocol.Limits = { maxFrame: 1024 * 1024 }
    const decoder = new KeteToolHelperProtocol.FrameDecoder(generous)
    const header = new Uint8Array(5)
    new DataView(header.buffer).setUint32(0, KeteToolHelperProtocol.dataFrameMax + 1, false)
    header[4] = KeteToolHelperProtocol.Type.stdout
    expect(() => decoder.push(header)).toThrow(KeteToolHelperProtocol.FrameTooLargeError)
  })
})

describe("decodeJson", () => {
  test("rejects an unknown field", () => {
    const body = new TextEncoder().encode('{"protocol":1,"extra":true}')
    expect(() => KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.HelloC2H, body)).toThrow()
  })

  test("rejects trailing data after the JSON value", () => {
    const body = new TextEncoder().encode('{"protocol":1}{"protocol":1}')
    expect(() => KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.HelloC2H, body)).toThrow()
  })

  test("rejects a wrong-typed field", () => {
    const body = new TextEncoder().encode('{"protocol":"one"}')
    expect(() => KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.HelloC2H, body)).toThrow()
  })

  test("accepts a valid body", () => {
    const body = new TextEncoder().encode('{"protocol":1}')
    expect(KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.HelloC2H, body)).toEqual({ protocol: 1 })
  })
})

describe("binary bodies", () => {
  test("stdin credit round trip", () => {
    const body = KeteToolHelperProtocol.encodeStdinCredit(262144)
    expect(KeteToolHelperProtocol.decodeStdinCredit(body)).toBe(262144)
  })

  test("credit round trip", () => {
    const body = KeteToolHelperProtocol.encodeCredit(KeteToolHelperProtocol.streamStderr, 4096)
    expect(KeteToolHelperProtocol.decodeCredit(body)).toEqual({ stream: KeteToolHelperProtocol.streamStderr, n: 4096 })
  })

  test("eof round trip", () => {
    const body = KeteToolHelperProtocol.encodeEOF(KeteToolHelperProtocol.streamStdout)
    expect(KeteToolHelperProtocol.decodeEOF(body)).toBe(KeteToolHelperProtocol.streamStdout)
  })

  test("wrong-sized bodies are rejected", () => {
    expect(() => KeteToolHelperProtocol.decodeStdinCredit(new Uint8Array(3))).toThrow()
    expect(() => KeteToolHelperProtocol.decodeCredit(new Uint8Array(3))).toThrow()
    expect(() => KeteToolHelperProtocol.decodeEOF(new Uint8Array(0))).toThrow()
  })
})

// Cross-language contract vectors, shared with
// packages/kete-root-helper/internal/protocol/protocol_test.go.

interface Vector {
  readonly name: string
  readonly type: string
  readonly typeByte: number
  readonly frameHex: string
  readonly decoded:
    | { readonly kind: "json"; readonly value: unknown }
    | { readonly kind: "raw"; readonly hex: string }
    | { readonly kind: "empty" }
    | { readonly kind: "u32"; readonly value: number }
    | { readonly kind: "u8"; readonly value: number }
    | { readonly kind: "stream_u32"; readonly stream: number; readonly value: number }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function loadVectors(): { readonly protocolVersion: number; readonly vectors: ReadonlyArray<Vector> } {
  const file = path.join(import.meta.dir, "../../../kete-root-helper/internal/protocol/testdata/vectors.json")
  return JSON.parse(readFileSync(file, "utf8"))
}

function decodeControl(type: number, body: Uint8Array): unknown {
  switch (type) {
    case KeteToolHelperProtocol.Type.helloC2H:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.HelloC2H, body)
    case KeteToolHelperProtocol.Type.helloH2C:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.HelloH2C, body)
    case KeteToolHelperProtocol.Type.spawn:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.Spawn, body)
    case KeteToolHelperProtocol.Type.spawned:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.Spawned, body)
    case KeteToolHelperProtocol.Type.kill:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.Kill, body)
    case KeteToolHelperProtocol.Type.exit:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.Exit, body)
    case KeteToolHelperProtocol.Type.error:
      return KeteToolHelperProtocol.decodeJson(KeteToolHelperProtocol.ErrorBody, body)
    default:
      throw new Error(`decodeControl: unhandled type 0x${type.toString(16)}`)
  }
}

describe("shared cross-language vectors", () => {
  const file = loadVectors()

  test("protocolVersion matches this implementation", () => {
    expect(file.protocolVersion).toBe(KeteToolHelperProtocol.protocolVersion)
  })

  for (const vector of file.vectors) {
    test(vector.name, () => {
      const raw = hexToBytes(vector.frameHex)
      const decoder = new KeteToolHelperProtocol.FrameDecoder({ maxFrame: 1024 * 1024 })
      const frames = decoder.push(raw)
      expect(frames).toHaveLength(1)
      const frame = frames[0]!
      expect(frame.type).toBe(vector.typeByte)

      switch (vector.decoded.kind) {
        case "json": {
          const got = decodeControl(frame.type, frame.body)
          expect(got).toEqual(vector.decoded.value)
          break
        }
        case "raw":
          expect(bytesToHex(frame.body)).toBe(vector.decoded.hex)
          break
        case "empty":
          expect(frame.body).toHaveLength(0)
          break
        case "u32":
          expect(KeteToolHelperProtocol.decodeStdinCredit(frame.body)).toBe(vector.decoded.value)
          break
        case "u8":
          expect(KeteToolHelperProtocol.decodeEOF(frame.body)).toBe(vector.decoded.value)
          break
        case "stream_u32": {
          const got = KeteToolHelperProtocol.decodeCredit(frame.body)
          expect(got).toEqual({ stream: vector.decoded.stream, n: vector.decoded.value })
          break
        }
      }
    })
  }
})
