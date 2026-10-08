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
// `approvedKey` is set on a shell request's metadata when a person approved that very request: by the
// permission service when the person's reply to it is "once" or "always" (core/src/permission.ts —
// not on other pending requests an "always" resolves without showing them), and by the sandbox's
// last `evaluate` hook (`KeteSandbox.ApprovalPlugin`) when the final decision is "allow" because an
// unattended run's policy allowed it (`policyKey`, set by kete/unattended.ts). A saved "Always allow"
// grants running a command, not network. Approved commands may use the network inside the sandbox
// (`kete.sandbox.network: "approved"`).

export * as KeteSandboxActions from "./actions.js"

export const off = "sandbox_off"
export const network = "sandbox_network"

export const reasons = ["requested", "disabled", "unavailable"] as const
export type Reason = (typeof reasons)[number]

export const approvedKey = "kete.sandbox.approved"
export const policyKey = "kete.sandbox.policyAllowed"

/** Whether `action` is one of the sandbox's own permission actions. */
export function isSandboxAction(action: string) {
  return action === off || action === network
}

/** A `sandbox_off` check that doesn't ask: the sandbox is off or unavailable, not escaped per command. */
export function automatic(action: string, metadata: Readonly<Record<string, unknown>> | undefined) {
  return action === off && (metadata?.reason === "disabled" || metadata?.reason === "unavailable")
}

/** Records that a person approved the request carrying `metadata` (only shell requests carry a
 * metadata object the sandbox reads it from). */
export function markApproved(metadata: Record<string, unknown> | undefined) {
  if (metadata) metadata[approvedKey] = true
}

/** Records that an unattended run's policy allowed the shell request carrying `metadata`. */
export function markPolicyAllowed(metadata: Record<string, unknown> | undefined) {
  if (metadata) metadata[policyKey] = true
}

/** The approval hook's rule, given the final decision. */
export function approve(event: { readonly action: string; readonly effect: string; readonly metadata?: Record<string, unknown> }) {
  if (event.action !== "shell" || !event.metadata) return
  if (event.effect === "allow" && event.metadata[policyKey] === true) markApproved(event.metadata)
}

export function approved(metadata: Readonly<Record<string, unknown>> | undefined) {
  return metadata?.[approvedKey] === true
}
