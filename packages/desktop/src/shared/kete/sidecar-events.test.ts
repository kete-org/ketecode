import { expect, test } from "bun:test"
import { Schema } from "effect"
import { DesktopEvent } from "../ipc-rpc/events"
import { KeteSidecarReady, KeteSidecarRestarting } from "./sidecar-events"

const events = [
  [new KeteSidecarRestarting(), ["_tag"]],
  [new KeteSidecarReady({ url: "http://127.0.0.1:4100" }), ["_tag", "url"]],
] as const

for (const [event, keys] of events) {
  test(`${event._tag} carries only ${keys.join(", ")} and round-trips`, () => {
    const encoded = Schema.encodeSync(DesktopEvent)(event)

    expect(Object.keys(encoded).sort()).toEqual([...keys].sort())
    expect(Object.keys(encoded).some((key) => /pass|auth|token|secret/i.test(key))).toBe(false)
    expect(Schema.decodeUnknownSync(DesktopEvent)(encoded)).toEqual(event)
  })
}
