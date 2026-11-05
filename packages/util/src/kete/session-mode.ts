// Kete Code's session modes (Code | Work), shared by the runtime (core/src/kete/session-mode.ts,
// which validates and locks the key) and the clients. A session's mode lives in its metadata under
// `metadataKey`; a session without the key is a Code session. The key can only be set when the
// session is created, never afterward, and a child session stays in its parent's mode.

export * as KeteSessionModes from "./session-mode.js"

export const metadataKey = "kete.sessionMode"

export const modes = ["code", "work"] as const
export type Mode = (typeof modes)[number]

export function parse(value: unknown): Mode | undefined {
  return modes.find((mode) => mode === value)
}
