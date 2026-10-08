// "Always allow" for a web fetch saves the URL's origin (scheme, host and port), not `*`: approving
// one site no longer approves every URL (kete/permission-mode.ts asks before web requests by default).

export * as KeteWebHost from "./web-host.js"

/** Saved patterns for `url`: the origin itself and everything under it. Unparseable → nothing saved. */
export function savePatterns(url: string): string[] {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return []
  }
  if (origin === "null") return []
  return [origin, `${origin}/*`]
}
