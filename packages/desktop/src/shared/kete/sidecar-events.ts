import { Schema } from "effect"

// Main tells every window the runtime service stopped answering and is being restarted.
export class KeteSidecarRestarting extends Schema.TaggedClass<KeteSidecarRestarting>()("KeteSidecarRestarting", {}) {}

// The service answers again. `url` is its origin only; the credential never leaves main.
export class KeteSidecarReady extends Schema.TaggedClass<KeteSidecarReady>()("KeteSidecarReady", {
  url: Schema.String,
}) {}
