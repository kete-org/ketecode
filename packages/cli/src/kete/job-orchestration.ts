// `kete job run`'s check of an orchestrated job's spec section (jobs-v1 "Orchestrated jobs"; kete-code
// ADR 0012): only in job mode (the entrypoint copies it from a claim that carried it), and only with
// the job's own id (KETE_JOB_ID, set by the entrypoint), which the coordinator's `orchestrate` tool
// names in the platform's routes. Pure.

export * as KeteJobOrchestration from "./job-orchestration.js"

import { KeteEnv } from "@opencode/util/kete/env"
import { KeteOrchestrationSpec } from "@opencode/util/kete/orchestration-spec"

/** The internal name for KETE_JOB_ID (the env bridge renames it). */
export const jobIdVariable = "OPENCODE_JOB_ID"
export const jobIdPublicName = KeteEnv.publicName(jobIdVariable)

export type Resolved =
  | { readonly kind: "ok"; readonly value: { readonly jobID: string; readonly spec: KeteOrchestrationSpec.Spec } }
  | { readonly kind: "refused"; readonly message: string }

export function resolve(input: {
  readonly jobMode: boolean
  readonly spec: KeteOrchestrationSpec.Spec
  readonly environment: Record<string, string | undefined>
}): Resolved {
  if (!input.jobMode)
    return {
      kind: "refused",
      message: "orchestration: an orchestrated job runs only in job mode (a cloud job's runtime)",
    }
  const jobID = input.environment[jobIdVariable]
  if (jobID === undefined || !KeteOrchestrationSpec.validJobId(jobID))
    return { kind: "refused", message: `orchestration: ${jobIdPublicName} is not set to the job's id` }
  return { kind: "ok", value: { jobID, spec: input.spec } }
}
