// The permission actions and metadata the local sandbox uses (ADR 0013). No dependencies, so
// permission-mode.ts and unattended.ts can import it without a cycle through sandbox.ts.
//
// - `sandbox_off`: a shell command runs outside the sandbox. Checked for every unsandboxed command;
//   metadata `reason` says why: "requested" (the model asked; always asks a person, Plan blocks it),
//   "disabled" (turned off by the user) or "unavailable" (no sandbox on this platform). The last two
//   don't ask, but an organization policy that denies `sandbox_off` refuses them: that is how an
//   organization requires the sandbox.
// - `sandbox_network`: a command the model asked to run with network access. Always asks.
//
// `approvedKey` is set on a shell request's metadata by the permission hooks when a person approved
// the command — it asked and was allowed, every part matched a saved "Always allow", or an unattended
// run's policy allowed it. Such commands may use the network (`kete.sandbox.network: "approved"`).

export * as KeteSandboxActions from "./actions.js"

export const off = "sandbox_off"
export const network = "sandbox_network"

export const reasons = ["requested", "disabled", "unavailable"] as const
export type Reason = (typeof reasons)[number]

export const approvedKey = "kete.sandbox.approved"

/** Whether `action` is one of the sandbox's own permission actions. */
export function isSandboxAction(action: string) {
  return action === off || action === network
}

/** A `sandbox_off` check that doesn't ask: the sandbox is off or unavailable, not escaped per command. */
export function automatic(action: string, metadata: Readonly<Record<string, unknown>> | undefined) {
  return action === off && (metadata?.reason === "disabled" || metadata?.reason === "unavailable")
}

/** Records that a person approved the shell request carrying `metadata`. */
export function markApproved(metadata: Record<string, unknown> | undefined) {
  if (metadata) metadata[approvedKey] = true
}

export function approved(metadata: Readonly<Record<string, unknown>> | undefined) {
  return metadata?.[approvedKey] === true
}
