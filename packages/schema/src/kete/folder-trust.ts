// The `kete.folder.trust` plugin RPC (core/src/kete/folder-trust/rpc.ts): whether the runtime trusts
// the location's folder (docs/folder-trust.md). The TUI asks it before loading a project's
// `.kete/plugins/` TUI plugins, which run in its own process, and reloads them on the `changed` event
// once the folder is trusted. Served by the existing `POST /api/rpc/:rpcID/:method`, so it needs no new
// HTTP endpoint. Carries no paths and nothing the project's config says.

export * as KeteFolderTrustRpc from "./folder-trust.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"

export const Status = Schema.Struct({
  /** True only when the folder is trusted (store, run trust or job mode); unknown, clear or untrusted is false. */
  trusted: Schema.Boolean,
}).annotate({ identifier: "KeteFolderTrust.Status" })
export type Status = typeof Status.Type

export const ID = "kete.folder.trust"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: { input: Schema.Struct({}), output: Status },
  },
  events: { changed: { schema: Status } },
})
