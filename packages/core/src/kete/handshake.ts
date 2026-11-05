// The `kete.handshake` RPC (schema/src/kete/handshake.ts): reports the protocol number, so a client
// can tell whether it can use this server. Needs no project or config, so it answers anywhere.
// Also serves `kete.modes` (schema/src/kete/modes.ts), the mode profiles the handshake's `modes` comes from.

export * as KeteHandshake from "./handshake.js"

import { define } from "@opencode/plugin/effect/plugin"
import { KeteHandshakeRpc } from "@opencode/schema/kete/handshake"
import { KeteModesRpc } from "@opencode/schema/kete/modes"
import { Effect } from "effect"
import { KeteModes } from "./modes.js"

export const Plugin = define({
  id: "kete.handshake",
  effect: (ctx) =>
    Effect.all([
      ctx.rpc.register(KeteHandshakeRpc.Definition, {
        get: () =>
          Effect.succeed({
            protocol: KeteHandshakeRpc.PROTOCOL,
            runtime: ctx.app.version,
            modes: KeteModes.available(),
          }),
      }),
      ctx.rpc.register(KeteModesRpc.Definition, {
        list: () => Effect.succeed(KeteModes.summaries()),
      }),
    ]).pipe(Effect.asVoid, Effect.orDie),
})
