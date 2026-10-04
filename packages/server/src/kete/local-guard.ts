// Host and Origin checks in front of every `kete serve` server, before authentication.
//
// The server runs commands and edits files, and listens on this machine. The password already
// protects the API; this adds the browser-facing defences (CLAUDE.md §9):
// - DNS rebinding: a page on attacker.example can re-point its own name at 127.0.0.1, so the browser
//   sends `Host: attacker.example`. Only IP literals, `localhost`, the name the server was bound to,
//   and hosts allowed explicitly (KETE_SERVER_ALLOWED_HOSTS) are accepted. An IP literal can't be
//   rebound, so LAN pairing by address keeps working.
// - Cross-site requests: a request with an `Origin` must come from the server's own origin, from an
//   origin passed with `--cors`, or from the desktop app's custom schemes. Other localhost ports and
//   upstream's hosted app (opencode.ai) are not trusted.
// Preflight requests are checked too, so a rejected origin never learns what the API allows.

import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

/** Internal name of KETE_SERVER_ALLOWED_HOSTS (the CLI's env bridge renames KETE_* to OPENCODE_*). */
export const allowedHostsVariable = "OPENCODE_SERVER_ALLOWED_HOSTS"

// Origins that web pages cannot claim: the desktop app's renderer and Tauri.
const appOrigins = new Set(["oc://renderer", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])

export type Options = {
  /** The hostname the server was bound to, e.g. 127.0.0.1 or a LAN name. */
  readonly hostname: string
  /** Origins allowed with `--cors`. */
  readonly cors?: ReadonlyArray<string>
  /**
   * Extra host names, e.g. a forwarded Codespaces host. A leading dot allows the name and every
   * subdomain (`.app.github.dev`).
   */
  readonly allowedHosts?: ReadonlyArray<string>
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export function check(headers: { host?: string; origin?: string }, options: Options): Verdict {
  const host = headers.host
  if (!host) return { ok: false, reason: "missing Host header" }
  const name = hostname(host)
  if (name === undefined) return { ok: false, reason: "invalid Host header" }
  if (!allowedHost(name, options)) return { ok: false, reason: `host ${name} is not allowed` }
  const origin = headers.origin
  if (origin === undefined) return { ok: true }
  if (appOrigins.has(origin) || options.cors?.includes(origin)) return { ok: true }
  if (sameOrigin(origin, host)) return { ok: true }
  return { ok: false, reason: `origin ${origin} is not allowed` }
}

export function allowedHostsFromEnvironment(environment: Record<string, string | undefined> = process.env) {
  return (environment[allowedHostsVariable] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "")
}

/** Wraps the server's app: rejected requests get 403 and never reach authentication or routing. */
export function middleware(options: Options) {
  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const verdict = check({ host: request.headers.host, origin: request.headers.origin }, options)
      if (verdict.ok) return yield* app
      yield* Effect.logWarning("request rejected by the local server guard", { reason: verdict.reason })
      return HttpServerResponse.text("Forbidden", { status: 403, headers: { "cache-control": "no-store" } })
    })
}

function allowedHost(name: string, options: Options) {
  if (name === "localhost" || isIP(name)) return true
  if (name === options.hostname.toLowerCase()) return true
  return (options.allowedHosts ?? []).some((allowed) =>
    allowed.startsWith(".") ? name === allowed.slice(1) || name.endsWith(allowed) : name === allowed,
  )
}

/** The lower-cased host name of a Host header, without port or IPv6 brackets. */
function hostname(host: string) {
  if (!URL.canParse(`http://${host}`)) return undefined
  const url = new URL(`http://${host}`)
  if (url.username || url.password || url.pathname !== "/") return undefined
  return url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase()
}

function sameOrigin(origin: string, host: string) {
  if (!URL.canParse(origin)) return false
  const url = new URL(origin)
  return (url.protocol === "http:" || url.protocol === "https:") && url.host === new URL(`http://${host}`).host
}

function isIP(name: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || (name.includes(":") && /^[0-9a-f:.]+$/.test(name))
}

export * as KeteLocalGuard from "./local-guard"
