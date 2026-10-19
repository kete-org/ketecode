// The `kete.share` plugin RPC (core/src/kete/share/plugin.ts), shared by core, the CLI, the TUI and the
// VS Code extension: preview what a session share would send (nothing is uploaded), then share or
// unshare it (docs/sharing.md, docs/platform/session-shares-v1.md). Served by the existing
// `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP endpoint.

export * as KeteShareRpc from "./share.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { NonNegativeInt, optional } from "../schema.js"

export const ID = "kete.share"

export const Visibility = Schema.Literals(["org", "link"])
export type Visibility = typeof Visibility.Type

/** Why nothing was shared. `failed` is a platform or network error; the others are refusals made before any upload. */
export const Refusal = Schema.Struct({
  kind: Schema.Literals([
    "job",
    "offline",
    "signed_out",
    "config_disabled",
    "org_disabled",
    "link_not_allowed",
    "child_session",
    "too_large",
    "changed",
    "location_mismatch",
    "already_shared",
    "failed",
  ]),
  message: Schema.String.check(Schema.isMaxLength(500)),
}).annotate({ identifier: "KeteShare.Refusal" })
export type Refusal = typeof Refusal.Type

/** Stored in the session's metadata (`kete.share`). `session` ties it to the session that made it. */
export const Record = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  visibility: Visibility,
  expires_at: Schema.String,
  session: Schema.String,
}).annotate({ identifier: "KeteShare.Record" })
export type Record = typeof Record.Type

const Target = Schema.Struct({ sessionID: Schema.String, visibility: optional(Visibility) })

export const PreviewOutput = Schema.Struct({
  refusal: optional(Refusal),
  counts: Schema.Struct({ messages: NonNegativeInt, tools: NonNegativeInt, diffs: NonNegativeInt }),
  bytes: NonNegativeInt,
  redactions: NonNegativeInt,
  truncated: Schema.Boolean,
  /** The visibility `share` would use. */
  visibility: Visibility,
  /** Whether the organization allows link sharing (or has not said). */
  linkAllowed: Schema.Boolean,
  maxDays: NonNegativeInt,
  existing: optional(Record),
  /** sha256 of the previewed snapshot; pass it to `share` so it uploads only what was previewed. */
  digest: optional(Schema.String),
})
export type PreviewOutput = typeof PreviewOutput.Type

export const ShareOutput = Schema.Struct({ record: optional(Record), refusal: optional(Refusal) })
export const UnshareOutput = Schema.Struct({ removed: optional(Schema.Boolean), refusal: optional(Refusal) })

export const Definition = Rpc.define({
  id: ID,
  methods: {
    preview: { input: Target, output: PreviewOutput },
    share: { input: Schema.Struct({ ...Target.fields, digest: optional(Schema.String) }), output: ShareOutput },
    unshare: { input: Schema.Struct({ sessionID: Schema.String }), output: UnshareOutput },
  },
  events: {},
})
