// The client side of the platform's CLI login (docs/platform/cli-login-v1.md): PKCE, the loopback
// callback listener, and the /api/v1/cli/* calls. The command handlers in ./login.ts, ./logout.ts and
// ./whoami.ts only wire these to the terminal, so everything here takes plain inputs and is tested
// directly (test/kete/cli-login.test.ts).
//
// Secrets: the PKCE verifier, the authorization code and the API key never go into an error message,
// a log line or anything printed. Errors carry the platform's error code and request id instead.

import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import { Schema } from "effect"
import { Brand } from "@opencode/util/kete/brand"

export const callbackTimeout = 5 * 60 * 1000
const requestTimeout = 15_000

// ---------------------------------------------------------------------------------------------------
// PKCE (RFC 7636, S256) and state

const base64url = (bytes: Buffer) => bytes.toString("base64url")

export function pkce() {
  // 32 random bytes → a 43-character verifier, the minimum length RFC 7636 allows and the platform expects.
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: challengeFor(verifier) }
}

export function challengeFor(verifier: string) {
  return base64url(createHash("sha256").update(verifier).digest())
}

export function state() {
  return base64url(randomBytes(32))
}

/** The hostname, made to fit the platform's device_name rules: 1-100 printable characters. */
export function deviceName(hostname = os.hostname()) {
  const cleaned = hostname.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 100)
  return cleaned === "" ? "unknown device" : cleaned
}

// ---------------------------------------------------------------------------------------------------
// Platform URL

export class LoginError extends Error {}

/**
 * The platform URL as an origin plus path, without a trailing slash. Plain HTTP is only accepted for
 * this machine: the key comes back in the response, so it must not cross a network unencrypted.
 */
export function platformURL(raw: string, source: string) {
  if (!URL.canParse(raw)) throw new LoginError(`${source} is not a valid URL: ${raw}`)
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash)
    throw new LoginError(`${source} must not contain credentials, a query or a fragment`)
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    throw new LoginError(`${source} must use https (plain http is only allowed for localhost): ${url.origin}`)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new LoginError(`${source} must be an https URL`)
  // URL parsing lets characters like "," or "!" into a host (a pasted trailing comma, say), which
  // no browser can open: only DNS names, IPv4 and bracketed IPv6 hosts are accepted.
  if (!validHost(url.hostname))
    throw new LoginError(`${source} has an invalid host "${url.hostname}"; check for stray characters such as a trailing comma: ${raw}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

function validHost(hostname: string) {
  if (/^\[[0-9a-f:.]+\]$/i.test(hostname)) return true
  return (
    hostname.length <= 253 &&
    hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function authorizeURL(input: {
  platform: string
  port: number
  state: string
  challenge: string
  device: string
}) {
  const url = new URL(`${input.platform}/cli/authorize`)
  url.searchParams.set("port", String(input.port))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("device_name", input.device)
  return url.href
}

// ---------------------------------------------------------------------------------------------------
// Loopback callback listener

export type Callback = {
  readonly port: number
  /** Resolves with the authorization code; rejects on denial, timeout or `close()`. */
  readonly code: Promise<string>
  readonly close: () => void
}

/**
 * Listens on 127.0.0.1 (never another interface) for the platform's redirect to
 * `/callback?code=…&state=…`. Only a request with the expected Host and state is accepted; anything
 * else is refused and the listener keeps waiting, so a stray or forged request cannot end the login.
 * The listener closes after the first accepted callback, on denial, or after `timeout` ms.
 */
export function listen(input: { state: string; port?: number; timeout?: number }): Callback {
  const settle: { resolve: (code: string) => void; reject: (error: Error) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  }
  const code = new Promise<string>((resolve, reject) => Object.assign(settle, { resolve, reject }))
  // The browser can settle this before the caller awaits it (a quick "Deny"); that is not an unhandled rejection.
  code.catch(() => undefined)
  const done = { value: false }
  const server = (() => {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: input.port ?? 0,
        fetch: (request) => respond(request),
      })
    } catch (error) {
      throw new LoginError(
        input.port === undefined
          ? `Could not open a local port for the sign-in callback: ${message(error)}`
          : `Could not listen on 127.0.0.1:${input.port} (is it in use?): ${message(error)}`,
      )
    }
  })()
  const port = server.port
  if (port === undefined || port < 1024)
    throw new LoginError("The sign-in callback needs a port from 1024 to 65535; pass one with --port")

  const finish = (outcome: { code: string } | { error: Error }) => {
    if (done.value) return
    done.value = true
    clearTimeout(timer)
    // Let the response that settled the login flush before the listener goes away.
    setTimeout(() => void server.stop(true), 50)
    if ("code" in outcome) settle.resolve(outcome.code)
    else settle.reject(outcome.error)
  }
  const timer = setTimeout(
    () =>
      finish({
        error: new LoginError(
          `Timed out after ${Math.round((input.timeout ?? callbackTimeout) / 60_000)} minutes waiting for the browser. Run \`${Brand.cliName} login\` again.`,
        ),
      }),
    input.timeout ?? callbackTimeout,
  )

  function respond(request: Request) {
    const url = new URL(request.url)
    // A page on another site can make the browser send requests here; so can DNS rebinding with the
    // victim's Host. Only the exact loopback Host the platform redirects to is accepted.
    if (request.headers.get("host") !== `127.0.0.1:${port}`) return page(421, "Wrong address", "")
    if (url.pathname !== "/callback") return page(404, "Not found", "")
    if (request.method !== "GET") return page(405, "Method not allowed", "")
    if (done.value) return page(410, "Already finished", "This sign-in already finished. You can close this tab.")
    if (url.searchParams.get("state") !== input.state)
      return page(
        400,
        "Sign-in not recognised",
        `This sign-in link doesn't match the one your terminal started. Run \`${Brand.cliName} login\` again.`,
      )
    const error = url.searchParams.get("error")
    if (error !== null) {
      finish({
        error: new LoginError(
          error === "access_denied"
            ? "Sign-in was cancelled in the browser. Run `" + Brand.cliName + " login` to try again."
            : `The platform refused the sign-in (${error.slice(0, 64)}).`,
        ),
      })
      return page(200, "Sign-in cancelled", "Nothing was changed. You can close this tab.")
    }
    const received = url.searchParams.get("code")
    if (received === null || received === "" || received.length > 256)
      return page(400, "Sign-in not recognised", "The link has no valid sign-in code.")
    finish({ code: received })
    return page(
      200,
      `Signed in to ${Brand.displayName}`,
      "Your terminal is finishing the sign-in. You can close this tab.",
    )
  }

  return {
    port,
    code,
    close: () => finish({ error: new LoginError("Sign-in was stopped") }),
  }
}

function page(status: number, title: string, body: string) {
  const escape = (text: string) =>
    text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(Brand.displayName)}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f5f2; --fg: #1c1a17; --muted: #6b655c; --card: #fff; --line: #e4dfd7; --brand: #6e47f5; }
@media (prefers-color-scheme: dark) { :root { --bg: #141311; --fg: #f1ede6; --muted: #a39c91; --card: #1d1b18; --line: #2e2b27; --brand: #a38cfa; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 26rem; margin: 1rem; padding: 2rem; background: var(--card); border: 1px solid var(--line); border-top: 4px solid var(--brand); border-radius: 12px; }
.brand { font-weight: 700; letter-spacing: .02em; color: var(--brand); font-size: .875rem; text-transform: uppercase; }
h1 { font-size: 1.375rem; margin: .5rem 0; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><div class="brand">${escape(Brand.displayName)}</div><h1>${escape(title)}</h1><p>${escape(body)}</p></main></body>
</html>`
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The page's own URL carries the one-time code; don't leak it to anything the page might load.
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  })
}

// ---------------------------------------------------------------------------------------------------
// Platform API

// kete-code-platform packages/shared/src/api/v1/cli.ts, CliTokenResponse.
const TokenResponse = Schema.Struct({
  api_key: Schema.String,
  key_id: Schema.String,
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
  gateway_url: Schema.String,
})
export type Token = typeof TokenResponse.Type

// kete-code-platform packages/shared/src/api/v1/errors.ts.
const ErrorResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String, request_id: Schema.optional(Schema.String) }),
})

// packages/shared/src/api/v1/me.ts.
const MeResponse = Schema.Struct({
  key: Schema.Struct({ id: Schema.String, name: Schema.String, kind: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
  balance_micros: Schema.Finite,
  currency: Schema.String,
})
export type Me = typeof MeResponse.Type

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code: "network" | "unavailable" | "expired" | "denied" | "invalid_key" | "rejected" | "invalid_response",
  ) {
    super(message)
  }
}

export async function exchange(input: {
  platform: string
  code: string
  verifier: string
  device: string
  fetch?: Fetch
}) {
  const response = await call(input.platform, "/api/v1/cli/token", {
    fetch: input.fetch,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code, code_verifier: input.verifier, device_name: input.device }),
  })
  if (!response.ok) throw await failure(input.platform, response, "sign-in")
  const body = Schema.decodeUnknownOption(TokenResponse)(await response.json().catch(() => undefined))
  if (body._tag === "None") throw new PlatformError("The platform sent an unexpected sign-in response.", "invalid_response")
  const gateway = body.value.gateway_url
  if (!URL.canParse(gateway) || !["http:", "https:"].includes(new URL(gateway).protocol))
    throw new PlatformError("The platform sent an invalid gateway URL.", "invalid_response")
  return body.value
}

/** Revokes a CLI key. Succeeds when the platform says the key is already unusable (401). */
export async function revoke(input: { platform: string; key: string; fetch?: Fetch }) {
  const response = await call(input.platform, "/api/v1/cli/logout", {
    fetch: input.fetch,
    method: "POST",
    headers: { authorization: `Bearer ${input.key}` },
  })
  if (response.ok || response.status === 401) return
  throw await failure(input.platform, response, "sign-out")
}

export async function me(input: { platform: string; key: string; fetch?: Fetch }) {
  const response = await call(input.platform, "/api/v1/me", {
    fetch: input.fetch,
    method: "GET",
    headers: { authorization: `Bearer ${input.key}`, accept: "application/json" },
  })
  if (!response.ok) throw await failure(input.platform, response, "account check")
  const body = Schema.decodeUnknownOption(MeResponse)(await response.json().catch(() => undefined))
  if (body._tag === "None") throw new PlatformError("The platform sent an unexpected account response.", "invalid_response")
  return body.value
}

async function call(platform: string, path: string, init: RequestInit & { fetch?: Fetch }) {
  const send = init.fetch ?? fetch
  return send(`${platform}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(requestTimeout) }).catch(
    (error: unknown) => {
      throw new PlatformError(
        error instanceof Error && error.name === "TimeoutError"
          ? `The ${Brand.displayName} platform at ${platform} did not answer within ${requestTimeout / 1000} seconds.`
          : `Could not reach the ${Brand.displayName} platform at ${platform}. Check your connection and the platform URL.`,
        "network",
      )
    },
  )
}

async function failure(platform: string, response: Response, action: string) {
  const parsed = Schema.decodeUnknownOption(ErrorResponse)(await response.json().catch(() => undefined))
  const error = parsed._tag === "Some" ? parsed.value.error : undefined
  const requestID = error?.request_id ?? response.headers.get("x-kete-request-id") ?? undefined
  const reference = requestID ? ` (request ${requestID})` : ""
  if (response.status >= 500 || response.status === 429)
    return new PlatformError(
      response.status === 429
        ? `The platform is rate limiting requests. Wait a minute and try again${reference}.`
        : `The ${Brand.displayName} platform at ${platform} is unavailable (HTTP ${response.status}). Try again shortly${reference}.`,
      "unavailable",
    )
  if (error?.code === "expired")
    return new PlatformError(
      `The sign-in code expired or was already used. Run \`${Brand.cliName} login\` again${reference}.`,
      "expired",
    )
  if (response.status === 401 || error?.code === "invalid_key")
    return new PlatformError(`The platform no longer accepts this device's key${reference}.`, "invalid_key")
  if (response.status === 403 || error?.code === "forbidden")
    return new PlatformError(`The platform refused the ${action}: ${error?.message ?? "forbidden"}${reference}.`, "denied")
  // The platform answers an unknown code, or a verifier that doesn't match, with a plain invalid_request.
  const retry = action === "sign-in" ? ` Run \`${Brand.cliName} login\` again.` : ""
  return new PlatformError(
    `The platform rejected the ${action} (HTTP ${response.status}${error ? `, ${error.code}: ${error.message}` : ""})${reference}.${retry}`,
    "rejected",
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as CliLogin from "./cli-login"
