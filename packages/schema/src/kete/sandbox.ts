// The `kete.sandbox` plugin RPC (core/src/kete/sandbox.ts), shared by core, the CLI and the TUI:
// whether the shell commands the agent runs go through the local OS sandbox (ADR 0013,
// docs/sandbox.md). Served by the existing `POST /api/rpc/:rpcID/:method`, so it needs no new HTTP
// endpoint. Carries no paths from the user's machine beyond what the settings name.

export * as KeteSandboxRpc from "./sandbox.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

/** `seatbelt`: macOS `sandbox-exec`. `bubblewrap`: Linux `bwrap`. */
export const Mechanism = Schema.Literals(["seatbelt", "bubblewrap"]).annotate({ identifier: "KeteSandbox.Mechanism" })
export type Mechanism = typeof Mechanism.Type

/**
 * - `on`: agent commands run in the sandbox.
 * - `off`: turned off (`KETE_SANDBOX=off` or `kete.sandbox.mode: "off"` in the global config).
 * - `unavailable`: this platform has no usable sandbox (Windows, Linux without a working `bwrap`);
 *   commands run unsandboxed, or are refused when the sandbox is required.
 * - `job`: a cloud or self-hosted job, whose commands run in the job's own sandbox instead.
 */
export const State = Schema.Literals(["on", "off", "unavailable", "job"]).annotate({ identifier: "KeteSandbox.State" })
export type State = typeof State.Type

export const Mode = Schema.Literals(["auto", "required", "off"]).annotate({ identifier: "KeteSandbox.Mode" })
export type Mode = typeof Mode.Type

export const Network = Schema.Literals(["approved", "none", "all"]).annotate({ identifier: "KeteSandbox.Network" })
export type Network = typeof Network.Type

export const MAX_REASON = 300

export const Status = Schema.Struct({
  state: State,
  platform: Schema.String,
  mechanism: optional(Mechanism),
  /** Why the sandbox is off or unavailable (at most 300 characters). */
  reason: optional(Schema.String.check(Schema.isMaxLength(MAX_REASON))),
  mode: Mode,
  network: Network,
  /** Settings a project's configuration tried to loosen and that were ignored. */
  ignored: Schema.Array(Schema.String),
}).annotate({ identifier: "KeteSandbox.Status" })
export type Status = typeof Status.Type

export const ID = "kete.sandbox"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: { input: Schema.Struct({}), output: Status },
  },
  events: {},
})
