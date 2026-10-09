// The coordinator routes of orchestrations-v1 (docs/platform/orchestrations-v1.md "Coordinator routes"),
// called by a coordinator turn's `orchestrate` tool with the turn's own job key (port A already allows
// the platform host). Every response is decoded with the contract mirror; errors carry the platform's
// code, reason, issues and request id, never the key. Bounded: one request at a time, a 30-second
// timeout, no retry (the tool reports the failure to the model, which may call again; re-sending the
// same proposal is a no-op on the platform).

export * as KeteOrchestrationClient from "./client.js"

import {
  OrchestrationCoordinatorResponse,
  OrchestrationErrorResponse,
  type OrchestrationCoordinatorView,
  type OrchestrationDecisionRequest,
  type OrchestrationPlanIssue,
  type OrchestrationPlanProposal,
} from "./contract.js"

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const timeoutMs = 30_000

export interface Target {
  /** The platform's origin (KETE_PLATFORM_URL, normalised). */
  readonly platform: string
  /** This turn's job id. */
  readonly jobID: string
  /** The turn's job key. */
  readonly key: string
  readonly fetch?: Fetch
}

export class OrchestrationError extends Error {
  override readonly name = "KeteOrchestrationClient.OrchestrationError"
  constructor(
    message: string,
    readonly detail: {
      readonly status?: number
      readonly code?: string
      readonly reason?: string
      readonly issues?: ReadonlyArray<OrchestrationPlanIssue>
      readonly requestID?: string
    } = {},
  ) {
    super(message)
  }
}

async function call(
  target: Target,
  method: "GET" | "PUT" | "POST",
  suffix: string,
  body?: unknown,
): Promise<OrchestrationCoordinatorView> {
  const send = target.fetch ?? fetch
  const url = `${target.platform}/api/v1/jobs/${encodeURIComponent(target.jobID)}/orchestration${suffix}`
  const response = await send(url, {
    method,
    headers: {
      authorization: `Bearer ${target.key}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    throw new OrchestrationError(
      error instanceof Error && error.name === "TimeoutError"
        ? `The platform did not answer within ${timeoutMs / 1000} seconds`
        : "Could not reach the platform",
    )
  })
  const requestID = response.headers.get("x-kete-request-id") ?? undefined
  const reference = requestID ? ` (request ${requestID})` : ""
  const json: unknown = await response.json().catch(() => undefined)
  if (response.ok) {
    const decoded = OrchestrationCoordinatorResponse.safeParse(json)
    if (!decoded.success)
      throw new OrchestrationError(`The platform sent an unexpected orchestration response${reference}`, {
        status: response.status,
        requestID,
      })
    return decoded.data.orchestration
  }
  const error = OrchestrationErrorResponse.safeParse(json)
  if (!error.success)
    throw new OrchestrationError(`The platform answered ${response.status}${reference}`, {
      status: response.status,
      requestID,
    })
  const e = error.data.error
  throw new OrchestrationError(`${e.message}${reference}`, {
    status: response.status,
    code: e.code,
    ...(e.reason === undefined ? {} : { reason: e.reason }),
    ...(e.issues === undefined ? {} : { issues: e.issues }),
    requestID,
  })
}

/** GET /api/v1/jobs/{id}/orchestration */
export const view = (target: Target) => call(target, "GET", "")

/** PUT /api/v1/jobs/{id}/orchestration/plan */
export const propose = (target: Target, proposal: OrchestrationPlanProposal) => call(target, "PUT", "/plan", proposal)

/** POST /api/v1/jobs/{id}/orchestration/decision */
export const decide = (target: Target, decision: OrchestrationDecisionRequest) =>
  call(target, "POST", "/decision", decision)
