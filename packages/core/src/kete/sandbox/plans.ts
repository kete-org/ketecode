// What the shell tool decided for one spawn (sandbox.ts), read back where shell.ts spawns. Kept apart
// from sandbox.ts so shell.ts imports only this and the profile builders, not the plugin's services.

export * as KeteSandboxPlans from "./plans.js"

import { KeteBubblewrap } from "./bubblewrap.js"
import type { Policy } from "./policy.js"
import { KeteSeatbelt } from "./seatbelt.js"

export interface Plan {
  readonly mechanism: "seatbelt" | "bubblewrap"
  readonly executable: string
  readonly policy: Policy
  readonly cwd: string
}

// Keyed by the invocation object itself, so a plan lives exactly as long as its spawn request.
const plans = new WeakMap<object, Plan>()

export function attach(invocation: object, plan: Plan) {
  plans.set(invocation, plan)
}

/** Builds the command line once, so a path the sandbox can't use fails before anything spawns. */
export function validate(plan: Plan) {
  if (plan.mechanism === "seatbelt") KeteSeatbelt.profile(plan.policy)
  else KeteBubblewrap.args(plan.policy, plan.cwd)
}

/** The command line to spawn: sandboxed if the shell tool attached a plan, unchanged otherwise. */
export function wrap(invocation: object, file: string, args: ReadonlyArray<string>): { file: string; args: string[] } {
  const plan = plans.get(invocation)
  if (!plan) return { file, args: [...args] }
  if (plan.mechanism === "seatbelt") return KeteSeatbelt.command(plan.policy, file, args)
  return KeteBubblewrap.command(plan.executable, plan.policy, plan.cwd, file, args)
}
