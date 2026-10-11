// The `kete.sync` plugin RPC (core/src/kete/sync/plugin.ts): what the platform sync has loaded, for
// clients that show something only when organization-managed agents exist (the TUI home screen's
// "Agents from your portal" notice, docs/home-notices.md). Served by the existing
// `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP endpoint. Carries counts and flags only:
// no organization name, agent names or account details.

export * as KeteSyncRpc from "./sync.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { NonNegativeInt } from "../schema.js"

export const Status = Schema.Struct({
  /** Whether an account is signed in now (`kete login`; read fresh on every call, so `kete logout` shows at once). */
  signedIn: Schema.Boolean,
  /** Managed agents in the loaded sync cache; 0 when nothing is cached. */
  managedAgents: NonNegativeInt,
  /** Offline mode (`--offline`, KETE_OFFLINE or `kete.offline`): nothing is synced. */
  offline: Schema.Boolean,
}).annotate({ identifier: "KeteSync.Status" })
export type Status = typeof Status.Type

export const ID = "kete.sync"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: { input: Schema.Struct({}), output: Status },
  },
  events: {},
})
