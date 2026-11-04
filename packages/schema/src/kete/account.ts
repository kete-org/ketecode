// The `kete.account` plugin RPC (core/src/kete/account.ts): sign in to and out of the Kete account from
// a client (the desktop app's Settings -> Account page, the new-session prompt). The runtime runs
// `kete login` / `kete logout` as a child process; the key never crosses this RPC. Served by the
// existing `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP endpoint. Every method except
// `status` is refused by the server unless it is local-only (server/src/kete/account-gate.ts).

export * as KeteAccountRpc from "./account.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

/** The 403 text of the server gate: fixed, never echoes request values. */
export const localOnlyMessage =
  "Signing in or out is only available in the app on this computer. Use `kete login` or `kete logout` in a terminal instead."

export const Status = Schema.Struct({
  signedIn: Schema.Boolean,
  organization: optional(Schema.String),
  /** The platform host only (no scheme or path). */
  platform: optional(Schema.String),
  offline: Schema.Boolean,
  signingIn: Schema.Boolean,
}).annotate({ identifier: "KeteAccount.Status" })
export type Status = typeof Status.Type

export const Refused = Schema.Struct({
  kind: Schema.Literal("refused"),
  reason: Schema.Literals(["offline", "job-mode"]),
  message: Schema.String,
}).annotate({ identifier: "KeteAccount.Refused" })
export const Failed = Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }).annotate({
  identifier: "KeteAccount.Failed",
})

export const Login = Schema.Union([Schema.Struct({ kind: Schema.Literal("started"), url: Schema.String }), Refused, Failed]).annotate({
  identifier: "KeteAccount.Login",
})
export type Login = typeof Login.Type

export const Logout = Schema.Union([
  // `message`: signed out here, but with a caveat (e.g. the platform could not revoke the key).
  Schema.Struct({ kind: Schema.Literal("done"), message: optional(Schema.String) }),
  Refused,
  Failed,
]).annotate({
  identifier: "KeteAccount.Logout",
})
export type Logout = typeof Logout.Type

export const Changed = Schema.Struct({
  state: Schema.Literals(["signed-in", "signed-out", "failed", "cancelled"]),
  message: optional(Schema.String),
}).annotate({ identifier: "KeteAccount.Changed" })
export type Changed = typeof Changed.Type

export const ID = "kete.account"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: { input: Schema.Struct({}), output: Status },
    login: { input: Schema.Struct({}), output: Login },
    cancel: { input: Schema.Struct({}), output: Schema.Struct({ cancelled: Schema.Boolean }) },
    logout: { input: Schema.Struct({}), output: Logout },
  },
  events: { changed: { schema: Changed } },
})
