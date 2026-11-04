// The `kete.handshake` plugin RPC (core/src/kete/handshake.ts): a client (the desktop and web app)
// asks a server which protocol it speaks before it uses the server. Served by the existing
// `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP endpoint and no location.
//
// `PROTOCOL` is the one place the number is defined; core, the app check and the e2e mock import it.
// Adding fields to `Result` is fine. Changing or removing one needs a `PROTOCOL` bump. Clients accept
// an exact match only.

export * as KeteHandshakeRpc from "./handshake.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"

export const PROTOCOL = 1

export const Result = Schema.Struct({
  protocol: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runtime: Schema.String,
  modes: Schema.Array(Schema.String),
}).annotate({ identifier: "KeteHandshake.Result" })
export type Result = typeof Result.Type

export const ID = "kete.handshake"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    get: { input: Schema.Struct({}), output: Result },
  },
  events: {},
})
