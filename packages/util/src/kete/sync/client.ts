// GET /api/v1/sync (docs/platform/sync-v1.md) with If-None-Match. Errors carry the platform's error
// code and request id, never the key.

import { Schema } from "effect"
import { ErrorResponse, SyncResponse } from "./contract.js"

export type Fetched =
  | { readonly kind: "updated"; readonly etag: string; readonly response: SyncResponse; readonly requestID?: string }
  | { readonly kind: "unchanged"; readonly etag: string; readonly requestID?: string }

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: "network" | "unauthorized" | "unavailable" | "invalid_response" | "rejected",
  ) {
    super(message)
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>
const timeout = 15_000

export async function fetchAgents(input: {
  platform: string
  key: string
  etag?: string
  fetch?: Fetch
  /** Whose key this is: an account's (a 401 says "Run `kete login`") or a job's (no such advice). */
  credential?: "account" | "job"
}): Promise<Fetched> {
  const send = input.fetch ?? fetch
  const response = await send(`${input.platform}/api/v1/sync`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.key}`,
      accept: "application/json",
      ...(input.etag ? { "if-none-match": input.etag } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  }).catch((error: unknown) => {
    throw new SyncError(
      error instanceof Error && error.name === "TimeoutError"
        ? `The platform at ${input.platform} did not answer within ${timeout / 1000} seconds`
        : `Could not reach the platform at ${input.platform}`,
      "network",
    )
  })
  const requestID = response.headers.get("x-kete-request-id") ?? undefined
  const reference = requestID ? ` (request ${requestID})` : ""
  if (response.status === 304) {
    await response.body?.cancel()
    return { kind: "unchanged", etag: response.headers.get("etag") ?? input.etag ?? "", requestID }
  }
  if (response.ok) {
    const etag = response.headers.get("etag")
    const body = Schema.decodeUnknownOption(SyncResponse)(await response.json().catch(() => undefined))
    if (body._tag === "None" || !etag)
      throw new SyncError(`The platform sent an unexpected sync response${reference}`, "invalid_response")
    return { kind: "updated", etag, response: body.value, requestID }
  }
  const error = Schema.decodeUnknownOption(ErrorResponse)(await response.json().catch(() => undefined))
  const detail = error._tag === "Some" ? `${error.value.error.code}: ${error.value.error.message}` : `HTTP ${response.status}`
  const errorReference = error._tag === "Some" && error.value.error.request_id ? ` (request ${error.value.error.request_id})` : reference
  if (response.status === 401 && input.credential === "job")
    throw new SyncError(`The platform refused the job's key (${detail})${errorReference}.`, "unauthorized")
  if (response.status === 401)
    throw new SyncError(`The platform no longer accepts this device's key (${detail})${errorReference}. Run \`kete login\` again.`, "unauthorized")
  if (response.status >= 500 || response.status === 429)
    throw new SyncError(`The platform is unavailable (${detail})${errorReference}`, "unavailable")
  throw new SyncError(`The platform rejected the sync request (${detail})${errorReference}`, "rejected")
}

export * as KeteSyncClient from "./client.js"
