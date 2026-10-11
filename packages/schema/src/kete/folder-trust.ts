// The `kete.folder.trust` plugin RPC (core/src/kete/folder-trust/rpc.ts): whether the runtime trusts
// the location's folder (docs/folder-trust.md). The TUI asks it, for its own directory, before loading a
// project's `.kete/plugins/` TUI plugins, which run in its own process: it sends the plugin directories
// it would load (and the directory of each local plugin the server's plugin list reports) and gets
// back, for each one the runtime knows and still trusts, a digest of its files now; it imports only a
// directory whose own digest is the same. It reloads them on the `changed` event
// once the folder is trusted. Served by the existing `POST /api/rpc/:rpcID/:method`, so it needs no new
// HTTP endpoint. Answers only with paths the client sent.

export * as KeteFolderTrustRpc from "./folder-trust.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"

export const Status = Schema.Struct({
  /** True only when the folder is trusted (store, run trust or job mode); unknown, clear or untrusted is false. */
  trusted: Schema.Boolean,
}).annotate({ identifier: "KeteFolderTrust.Status" })
export type Status = typeof Status.Type

export const Plugins = Schema.Struct({
  /** As in `Status`. */
  trusted: Schema.Boolean,
  /** The requested plugin directories that may load, each with a digest of its files now
   * (util/src/kete/folder-trust.ts `pluginDigest`, `targetDigest`): project plugin code only while the
   * folder is trusted and its files are still the trusted ones; a local plugin the machine-level
   * config names in any folder. A directory missing from it may not load. */
  plugins: Schema.Array(Schema.Struct({ directory: Schema.String, digest: Schema.String })),
}).annotate({ identifier: "KeteFolderTrust.Plugins" })
export type Plugins = typeof Plugins.Type

export const ID = "kete.folder.trust"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: { input: Schema.Struct({ directories: Schema.Array(Schema.String) }), output: Plugins },
  },
  events: { changed: { schema: Status } },
})
