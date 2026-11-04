// The `kete.handshake` RPC (schema/src/kete/handshake.ts): reports the protocol number, so a client
// can tell whether it can use this server. Needs no project or config, so it answers anywhere.

export * as KeteHandshake from "./handshake.js"

import { define } from "@opencode/plugin/effect/plugin"
import { KeteHandshakeRpc } from "@opencode/schema/kete/handshake"
import { Effect } from "effect"

export const Plugin = define({
  id: "kete.handshake",
  effect: (ctx) =>
    ctx.rpc
      .register(KeteHandshakeRpc.Definition, {
        get: () =>
          Effect.succeed({
            protocol: KeteHandshakeRpc.PROTOCOL,
            runtime: ctx.app.version,
            modes: ["code"],
          }),
      })
      .pipe(Effect.asVoid, Effect.orDie),
})
