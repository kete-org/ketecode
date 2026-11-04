import { expect, test } from "bun:test"
import { Schema } from "effect"
import { KeteHandshakeRpc } from "../../src/kete/handshake.js"

const decode = Schema.decodeUnknownSync(KeteHandshakeRpc.Result)
const valid = { protocol: KeteHandshakeRpc.PROTOCOL, runtime: "1.2.3", modes: ["code"] }

test("decodes a valid handshake result", () => {
  expect(decode(valid)).toEqual(valid)
})

test("rejects a result with a missing, negative, fractional or non-numeric protocol", () => {
  expect(() => decode({ runtime: "1", modes: [] })).toThrow()
  expect(() => decode({ ...valid, protocol: -1 })).toThrow()
  expect(() => decode({ ...valid, protocol: 1.5 })).toThrow()
})

test("rejects a non-string runtime", () => {
  expect(() => decode({ ...valid, runtime: 1 })).toThrow()
})
