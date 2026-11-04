// Gate in front of the `kete.account` plugin RPC (core/src/kete/account.ts). Signing in or out changes
// the machine's stored credentials, so every method except `status` is served only when the caller is
// the local owner. A plugin RPC handler never sees its caller, so the decision is made here, from how
// the server was started:
// - bound to a loopback hostname (not 0.0.0.0, not a LAN name), so a LAN or paired client can't reach it;
// - not on a unix socket;
// - no remote tunnel URL (the tunnel dials from loopback, so a peer-address check would not catch it);
// - not running in a remote session (SSH, Codespaces, dev containers).
// Refusals are 403 with a fixed text that never echoes request values.

import { KeteAccountRpc } from "@opencode/schema/kete/account"
import { KeteOffline } from "@opencode/util/kete/offline"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

const remoteVariables = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CODESPACES", "REMOTE_CONTAINERS"]

export type Server = {
  readonly hostname: string
  readonly socket?: string
  readonly remoteURLs: ReadonlyArray<string>
  readonly environment: Record<string, string | undefined>
}

/** Whether this server may serve credential-changing account methods. */
export function local(server: Server): boolean {
  if (server.socket) return false
  if (!KeteOffline.isLoopbackHost(server.hostname)) return false
  if (server.remoteURLs.length > 0) return false
  return !remoteVariables.some((name) => (server.environment[name] ?? "") !== "")
}

/** Whether a request targets a `kete.account` method other than `status`. Matches decoded path segments. */
export function gated(path: string): boolean {
  const segments = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
  const index = segments.findIndex((segment) => segment.includes(KeteAccountRpc.ID))
  if (index === -1) return false
  return !(segments[index] === KeteAccountRpc.ID && segments[index + 1] === "status" && segments.length === index + 2)
}

export type Verdict = { readonly ok: true } | { readonly ok: false }

export function check(request: { readonly path: string }, server: Server): Verdict {
  return gated(request.path) && !local(server) ? { ok: false } : { ok: true }
}

/** Wraps the server's app: a refused request gets 403 and never reaches authentication or routing. */
export function middleware(options: {
  readonly hostname: string
  readonly socket?: string
  readonly remoteURLs?: () => ReadonlyArray<string>
  readonly environment?: Server["environment"]
}) {
  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://localhost").pathname
      const verdict = check(
        { path },
        {
          hostname: options.hostname,
          socket: options.socket,
          remoteURLs: options.remoteURLs?.() ?? [],
          environment: options.environment ?? process.env,
        },
      )
      if (verdict.ok) return yield* app
      yield* Effect.logWarning("account request refused: the server is not local-only")
      return HttpServerResponse.text(KeteAccountRpc.localOnlyMessage, {
        status: 403,
        headers: { "cache-control": "no-store" },
      })
    })
}

export * as KeteAccountGate from "./account-gate"
