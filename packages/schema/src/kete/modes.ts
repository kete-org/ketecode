// Mode profiles (core/src/kete/modes/*.jsonc) and the `kete.modes` plugin RPC that lists them.
// Served by the handshake plugin (core/src/kete/handshake.ts) through `POST /api/rpc/:rpcID/:method`.
//
// Adding fields is fine. Changing or removing one breaks the mode switch (WS1 1.4). Unknown keys are
// rejected by the loader, so decode a profile with `onExcessProperty: "error"`.
// Nothing here is enforced yet: the profile fields describe a mode, enforcement arrives with WS1 1.3.

export * as KeteModesRpc from "./modes.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"

export const Id = Schema.Literals(["code", "work"]).annotate({ identifier: "KeteModes.Id" })
export type Id = typeof Id.Type

export const Shell = Schema.Struct({
  run: Schema.Literals(["any", "allowlist", "off"]),
  allow: Schema.Array(Schema.String),
  windows: Schema.Literals(["same", "off"]),
}).annotate({ identifier: "KeteModes.Shell" })
export type Shell = typeof Shell.Type

export const Profile = Schema.Struct({
  id: Id,
  name: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  available: Schema.Boolean,
  files: Schema.Literals(["workspace", "granted"]),
  shell: Shell,
  network: Schema.Literals(["default", "off"]),
  git: Schema.Boolean,
  web: Schema.Boolean,
  mcp: Schema.Boolean,
  approvals: Schema.Literals(["default", "action-class"]),
  outputs: Schema.Literals(["in-place", "kete-outputs"]),
}).annotate({ identifier: "KeteModes.Profile" })
export type Profile = typeof Profile.Type

export const Summary = Schema.Struct({
  id: Id,
  name: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  available: Schema.Boolean,
}).annotate({ identifier: "KeteModes.Summary" })
export type Summary = typeof Summary.Type

export const ID = "kete.modes"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    list: { input: Schema.Struct({}), output: Schema.Array(Summary) },
  },
  events: {},
})
