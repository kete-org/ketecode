// The `kete.doctor` plugin RPC (core/src/kete/doctor.ts): what only the runtime knows for `kete doctor`
// and `/doctor` (util/src/kete/doctor.ts turns it into checks). Each config file the runtime would load
// is checked the way the loader checks it, because the loader drops an invalid file whole and only logs
// it; and the folder trust decision for the location. Served by the existing
// `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP endpoint. Read-only. The paths are this
// machine's own config files, for the person running the doctor; nothing here is sent anywhere else.

export * as KeteDoctorRpc from "./doctor.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

/** At most this many messages per file, each at most `MAX_MESSAGE` characters. */
export const MAX_MESSAGES = 10
export const MAX_MESSAGE = 300
/** At most this many held-back items in `Trust.held`. */
export const MAX_HELD = 20

/**
 * - `ok`: loads.
 * - `warnings`: loads, but some settings are ignored (unsupported or conflicting keys).
 * - `invalid`: not valid JSON or JSONC: the runtime ignores the whole file.
 * - `rejected`: valid JSON, but not a valid config: the runtime ignores the whole file.
 * - `unreadable`: exists but couldn't be read.
 */
export const FileState = Schema.Literals(["ok", "warnings", "invalid", "rejected", "unreadable"]).annotate({
  identifier: "KeteDoctor.FileState",
})
export type FileState = typeof FileState.Type

export const File = Schema.Struct({
  path: Schema.String,
  scope: Schema.Literals(["global", "project", "explicit"]),
  state: FileState,
  messages: Schema.Array(Schema.String),
}).annotate({ identifier: "KeteDoctor.File" })
export type File = typeof File.Type

/** The folder trust decision (docs/folder-trust.md). `clear`: the folder has nothing trust holds back. */
export const Trust = Schema.Struct({
  state: Schema.Literals(["trusted", "untrusted", "clear", "pending"]),
  /** Why it's trusted: `store` (`kete trust add` or the prompt), `run` (--trust-project-config), `job`. */
  reason: optional(Schema.Literals(["store", "run", "job"])),
  /** What is held back while untrusted (at most `MAX_HELD` items). */
  held: Schema.Array(Schema.String),
  /** How many items are held back in all. */
  heldCount: Schema.Number,
  /** Why the folder can never be trusted. */
  refusal: optional(Schema.String),
}).annotate({ identifier: "KeteDoctor.Trust" })
export type Trust = typeof Trust.Type

export const Report = Schema.Struct({
  files: Schema.Array(File),
  trust: Trust,
}).annotate({ identifier: "KeteDoctor.Report" })
export type Report = typeof Report.Type

export const ID = "kete.doctor"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    check: { input: Schema.Struct({}), output: Report },
  },
  events: {},
})
