// The `kete.add-dir` plugin RPC (core/src/kete/add-dir-plugin.ts), shared by core, the CLI and the TUI:
// asks the runtime whether folders may be added to a session (`--add-dir`, `/add-dir`), so a client can
// show a clear reason before it writes the `kete.dirs` session metadata (the metadata guard refuses
// too, but a refusal there reaches a client only as a generic error). Served by the existing
// `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP endpoint.

export * as KeteAddDirRpc from "./add-dir.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

/** Most folders one session can have, and so the most one `check` call looks at. */
export const MAX = 10

export const Verdict = Schema.Struct({
  /** The path as given. */
  path: Schema.String,
  /** The folder's real path, when it can be added. */
  real: optional(Schema.String),
  /** Why it can't be added. */
  reason: optional(Schema.String.check(Schema.isMaxLength(300))),
}).annotate({ identifier: "KeteAddDir.Verdict" })
export type Verdict = typeof Verdict.Type

export const CheckInput = Schema.Struct({ paths: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX)) })
export const CheckOutput = Schema.Struct({ verdicts: Schema.Array(Verdict) })

export const ID = "kete.add-dir"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    check: { input: CheckInput, output: CheckOutput },
  },
  events: {},
})
