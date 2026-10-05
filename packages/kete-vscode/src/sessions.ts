// The chat's sessions as a native list, and links to them. The runtime's session list
// (`GET /api/session?directory=`) is parsed here, and `<scheme>://ketecode.kete-code/session?id=…`
// links name one session; the scheme is the host's (`vscode.env.uriScheme`: vscode, windsurf, cursor,
// vscodium, …), never hard-coded. Kept free of the `vscode` module so it can be unit-tested.

export type SessionItem = { readonly id: string; readonly title: string; readonly updated: number }

/** Session ids the runtime makes; anything else in a link or a response is ignored. */
const ID = /^[A-Za-z0-9_-]{1,128}$/
/** RFC 3986 scheme syntax (lower case, as `vscode.env.uriScheme` gives it). */
const SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/

/** Top-level, unarchived sessions from a list response, most recently updated first. */
export function parseSessions(body: unknown, limit = 50): SessionItem[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  return data
    .flatMap((item: unknown): SessionItem[] => {
      if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id)) return []
      if (typeof item.parentID === "string") return []
      const time = isRecord(item.time) ? item.time : {}
      if (typeof time.archived === "number") return []
      const updated = typeof time.updated === "number" ? time.updated : typeof time.created === "number" ? time.created : 0
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 200) : "Untitled session"
      return [{ id: item.id, title, updated }]
    })
    .sort((a, b) => b.updated - a.updated)
    .slice(0, limit)
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", or the date. */
export function ago(time: number, now: number) {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)} d ago`
  return new Date(time).toISOString().slice(0, 10)
}

/** The session a `<scheme>://<extension>/session?id=…` link names, if it is well formed. */
export function sessionFromLink(path: string, query: string) {
  if (path.replace(/\/+$/, "") !== "/session") return undefined
  const id = new URLSearchParams(query).get("id")
  return id && ID.test(id) ? id : undefined
}

/** A link that opens session `id` in the host editor. `scheme` is `vscode.env.uriScheme`. */
export function sessionLink(scheme: string, extensionID: string, id: string) {
  if (!SCHEME.test(scheme)) throw new Error(`not a URI scheme: ${scheme}`)
  return `${scheme}://${extensionID}/session?id=${encodeURIComponent(id)}`
}

export function isSessionID(value: unknown): value is string {
  return typeof value === "string" && ID.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
