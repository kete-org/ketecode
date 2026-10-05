// The `kete.local-models` plugin RPC (core/src/kete/local-models.ts), shared by core, the CLI, the
// TUI and the web UI: what each local model server (Ollama, LM Studio, vLLM) is doing, and a request
// to look at them again. Served by the existing `POST /api/rpc/:rpcID/:method`, so it needs no new
// HTTP endpoint. Never carries API keys, headers or URL credentials.

export * as KeteLocalModelsRpc from "./local-models.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

export const ProviderID = Schema.Literals(["ollama", "lmstudio", "vllm"]).annotate({
  identifier: "KeteLocalModels.ProviderID",
})
export type ProviderID = typeof ProviderID.Type

/** `blocked`: offline mode is on and the server isn't on this machine or a private network, so it
 * isn't contacted at all (no request, no API key sent). */
export const State = Schema.Literals(["reachable", "unreachable", "not_configured", "blocked"]).annotate({
  identifier: "KeteLocalModels.State",
})
export type State = typeof State.Type

/** Where the server's URL came from: config `providers.<id>.settings.baseURL`, an environment variable, or the default. */
export const Source = Schema.Literals(["config", "env", "default"]).annotate({ identifier: "KeteLocalModels.Source" })
export type Source = typeof Source.Type

export const MAX_ERROR = 300

export const ContextWarning = Schema.Struct({
  model: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "KeteLocalModels.ContextWarning" })
export type ContextWarning = typeof ContextWarning.Type

export const ProviderStatus = Schema.Struct({
  id: ProviderID,
  state: State,
  /** The base URL tried, without credentials or query. */
  url: Schema.String,
  source: Source,
  /** Models the server lists (reachable only). */
  models: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** A short reason (at most 300 characters; never URLs, headers or keys) when unreachable or blocked. */
  error: optional(Schema.String.check(Schema.isMaxLength(MAX_ERROR))),
  /** A plain-http host that isn't this machine: code sent to it crosses the network unencrypted. */
  insecure: Schema.Boolean,
  /** How to start or point Kete at the server. */
  hint: Schema.String,
  contextWarnings: optional(Schema.Array(ContextWarning)),
}).annotate({ identifier: "KeteLocalModels.ProviderStatus" })
export type ProviderStatus = typeof ProviderStatus.Type

export const Status = Schema.Struct({
  offline: Schema.Boolean,
  providers: Schema.Array(ProviderStatus),
}).annotate({ identifier: "KeteLocalModels.Status" })
export type Status = typeof Status.Type

export const ID = "kete.local-models"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: { input: Schema.Struct({}), output: Status },
    rediscover: {
      input: Schema.Struct({ provider: optional(ProviderID) }),
      output: Schema.Void,
    },
  },
  events: { rediscover: { schema: Schema.Struct({ provider: ProviderID }) } },
})
