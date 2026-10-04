// `kete job run`'s first sync in job mode (job mode piece A2, kete-code-platform docs/jobs.md §8
// item 6): the organization's managed agents, skills and policies fetched with the job's gateway key,
// in this process, after the connection is resolved and before the job's server starts.
//
// Fail closed: the job must not run without the policies it is bound by, and its gateway key is
// pinned to one agent (ADR 0020 rule 9), so `spec.agent` is required and must be one of the synced
// agents. A failed sync (network, a refused key, a platform error) or a managed skill that failed to
// download is an `error`; a missing or unknown agent is `refused` (a spec problem). Nothing is
// spawned and no session is created on either. On success the organization id goes to the server
// child (job-standalone.ts), whose sync plugin loads exactly the cache written here.

export * as KeteJobSync from "./job-sync.js"

import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteSync } from "@opencode/util/kete/sync/sync"

export type Input = {
  /** The job's gateway key (from its descriptor); sent as the Bearer, never logged. */
  readonly key: string
  readonly spec: { readonly agent?: string }
  readonly environment: KeteJobMode.Environment
  readonly config: string
  readonly data: string
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Aborts every request of the sync (the job was interrupted). */
  readonly signal?: AbortSignal
}

export type Result =
  | { readonly kind: "ok"; readonly organization: string }
  | { readonly kind: "error" | "refused"; readonly message: string }

/** At most this many agent slugs are listed in a refusal. */
const maxListed = 10

/** The whole first sync (the agents request and every skill download) ends within this. */
export const deadline = 120_000

export async function first(input: Input): Promise<Result> {
  const platform = KeteJobMode.endpoints(input.environment).platform
  if (!platform)
    return {
      kind: "error",
      message: `Job mode: ${KeteJobMode.platformURLPublicName} is not an http(s) URL; the job's agent can't be synced.`,
    }
  // Checked before the network: the gateway pins a job key to one agent, so no agent means no job.
  if (input.spec.agent === undefined)
    return { kind: "refused", message: "Job mode: the job spec must name an `agent` (a synced agent's slug); a job's key is pinned to one agent." }
  // Each request has its own timeout; this bounds them together and carries the job's interrupt.
  const bound = AbortSignal.any([AbortSignal.timeout(deadline), ...(input.signal ? [input.signal] : [])])
  const send = input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  // `native: undefined`: nothing here touches the OS key store, which job mode refuses.
  const outcome = await KeteSync.sync({
    config: input.config,
    data: input.data,
    native: undefined,
    credential: { platform, key: input.key },
    fetch: (url, init) => send(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, bound]) : bound }),
  })
  if (bound.aborted)
    return {
      kind: "error",
      message: input.signal?.aborted
        ? "Job mode: the job was interrupted during its first sync."
        : `Job mode: the first sync with the platform did not finish within ${deadline / 1000} seconds.`,
    }
  if (outcome.kind === "failed")
    return { kind: "error", message: `Job mode: the first sync with the platform failed: ${outcome.error.message}` }
  // `signed-out` is never returned with a credential.
  if (outcome.kind === "signed-out") return { kind: "error", message: "Job mode: the first sync with the platform did not run." }
  if (outcome.skills.failed.length > 0)
    return {
      kind: "error",
      message: `Job mode: the first sync could not download ${outcome.skills.failed.length} managed skill(s); the job needs them.`,
    }
  const response = outcome.cached.response
  const slugs = response.agents.map((agent) => agent.slug)
  if (!slugs.includes(input.spec.agent)) {
    const listed = slugs.slice(0, maxListed).join(", ")
    const more = slugs.length > maxListed ? ", …" : ""
    return {
      kind: "refused",
      message: `spec.agent "${input.spec.agent}" is not among ${response.organization.name}'s synced agents${slugs.length > 0 ? ` (${listed}${more})` : ""}.`,
    }
  }
  return { kind: "ok", organization: response.organization.id }
}
