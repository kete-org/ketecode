// Web fetch redirects (PR #20 review): `fetch` follows redirects on its own, so an approved URL could
// lead to content from any other site without asking. The web fetch tool now fetches with
// `redirect: "manual"` and follows redirects here: a hop to another origin is asked for (like a new
// fetch) before it is requested; same-origin hops aren't. At most `MAX_REDIRECTS` hops, http(s) only.

export * as KeteWebRedirect from "./web-redirect.js"

import { Effect } from "effect"

export const MAX_REDIRECTS = 10

export class RedirectError extends Error {}

interface Response {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
}

export const follow = <R extends Response, E1, E2, Q1, Q2>(input: {
  readonly url: string
  readonly fetch: (url: string) => Effect.Effect<R, E1, Q1>
  /** Asks permission for a URL on an origin not approved yet. */
  readonly approve: (url: string) => Effect.Effect<void, E2, Q2>
}): Effect.Effect<R, E1 | E2 | RedirectError, Q1 | Q2> =>
  Effect.gen(function* () {
    const approved = new Set([new URL(input.url).origin])
    let url = input.url
    for (let hop = 0; ; hop++) {
      const response = yield* input.fetch(url)
      const location = response.headers.location
      if (response.status < 300 || response.status >= 400 || !location) return response
      if (hop >= MAX_REDIRECTS) return yield* Effect.fail(new RedirectError(`Too many redirects (more than ${MAX_REDIRECTS})`))
      const next = new URL(location, url)
      if (next.protocol !== "http:" && next.protocol !== "https:")
        return yield* Effect.fail(new RedirectError(`Redirect to a non-HTTP URL: ${next.protocol}`))
      if (!approved.has(next.origin)) {
        yield* input.approve(next.toString())
        approved.add(next.origin)
      }
      url = next.toString()
    }
  })
