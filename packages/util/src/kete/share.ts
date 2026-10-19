// Session shares (docs/platform/session-shares-v1.md): POST/PUT/DELETE /api/v1/shares with the
// account's key. Errors are typed, keep the request id, and never carry the key or the request body.

import { Schema } from "effect"
import { ErrorResponse } from "./sync/contract.js"

export type Visibility = "org" | "link"

export type Options = {
  readonly platform: string
  readonly key: string
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  readonly signal?: AbortSignal
}

export type Body = { readonly session_id: string; readonly title: string; readonly visibility: Visibility; readonly snapshot: unknown }
export type UpdateBody = { readonly title: string; readonly snapshot: unknown }

/** `value` without C0/C1 control characters: platform text is printed to terminals (no escape sequences). */
export const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "")

// https, or http only to this machine (a local platform in development). Printable ASCII only.
const ShareUrl = Schema.String.check(
  Schema.isPattern(/^(https:\/\/[\x21-\x2e\x30-\x7e]|http:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?([/?#]|$))[\x21-\x7e]*$/i),
  Schema.isMaxLength(2048),
)

export const Created = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  url: ShareUrl,
  visibility: Schema.Literals(["org", "link"]),
  expires_at: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/)),
  created_at: Schema.String,
})
export type Created = typeof Created.Type

export type ErrorCode =
  | "unauthorized"
  | "share_disabled"
  | "share_link_not_allowed"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "server"
  | "network"
  | "timeout"
  | "invalid_response"

export class ShareError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = "ShareError"
  }
}

const timeout = 15_000

/** The sync policy for sharing; absent from the platform means `org`, 30 days. */
export function policy(response?: { readonly share?: { readonly mode: "disabled" | "org" | "link"; readonly max_days: number } }) {
  return response?.share ?? { mode: "org" as const, max_days: 30 }
}

async function send(options: Options, method: string, path: string, body?: unknown): Promise<Response> {
  const request = options.fetch ?? fetch
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeout)])
  try {
    return await request(`${options.platform}/api/v1/shares${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw new ShareError("The share request was cancelled", "network")
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new ShareError(`The platform at ${options.platform} did not answer within ${timeout / 1000} seconds`, "timeout")
    throw new ShareError(`Could not reach the platform at ${options.platform}`, "network")
  }
}

async function fail(response: Response): Promise<never> {
  const header = response.headers.get("x-kete-request-id") ?? undefined
  // Platform text ends up in a terminal: control characters are removed.
  const parsed = Schema.decodeUnknownOption(ErrorResponse)(await response.json().catch(() => undefined))
  const code = parsed._tag === "Some" ? parsed.value.error.code : undefined
  const raw = (parsed._tag === "Some" ? parsed.value.error.request_id : undefined) ?? header
  const requestId = raw === undefined ? undefined : printable(raw)
  const reference = requestId ? ` (request ${requestId})` : ""
  const detail = parsed._tag === "Some" ? printable(parsed.value.error.message) : `HTTP ${response.status}`
  if (response.status === 401)
    throw new ShareError(`The platform no longer accepts this device's key${reference}. Run \`kete login\` again.`, "unauthorized", requestId)
  if (response.status === 403 && code === "share_link_not_allowed")
    throw new ShareError(`Your organization does not allow link sharing${reference}`, "share_link_not_allowed", requestId)
  if (response.status === 403 && code === "share_disabled")
    throw new ShareError(`Your organization has turned session sharing off${reference}`, "share_disabled", requestId)
  if (response.status === 404) throw new ShareError(`The share no longer exists${reference}`, "not_found", requestId)
  if (response.status === 413) throw new ShareError(`The session is too large to share${reference}`, "payload_too_large", requestId)
  if (response.status === 429) throw new ShareError(`The platform is rate limiting shares; try again later${reference}`, "rate_limited", requestId)
  if (response.status >= 500) throw new ShareError(`The platform is unavailable${reference}`, "server", requestId)
  throw new ShareError(`The platform rejected the share request: ${detail}${reference}`, "invalid_response", requestId)
}

async function created(response: Response): Promise<Created> {
  if (!response.ok) return fail(response)
  const header = response.headers.get("x-kete-request-id")
  const requestId = header === null ? undefined : printable(header)
  const body = Schema.decodeUnknownOption(Created)(await response.json().catch(() => undefined))
  if (body._tag === "None") throw new ShareError("The platform sent an unexpected share response", "invalid_response", requestId)
  return body.value
}

export async function create(options: Options, body: Body): Promise<Created> {
  return created(await send(options, "POST", "", body))
}

export async function update(options: Options, id: string, body: UpdateBody): Promise<Created> {
  return created(await send(options, "PUT", `/${encodeURIComponent(id)}`, body))
}

/** Resolves on 204; a 404 rejects with code `not_found` (callers treat it as already gone). */
export async function remove(options: Options, id: string): Promise<void> {
  const response = await send(options, "DELETE", `/${encodeURIComponent(id)}`)
  if (response.status === 204) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  return fail(response)
}

export * as KeteShareClient from "./share.js"
