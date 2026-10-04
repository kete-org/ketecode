// A session's permission mode, chosen in an editor client (e.g. the VS Code extension's "Ask before
// edits" toggle) and kept in the session's metadata under `kete.permissionMode`, which subagent
// sessions inherit. "ask" asks before edits, shell commands and web fetches even when the agent's
// rules allow them. It only ever tightens: a denied request is never reached (the permission
// service decides deny before this hook), and nothing here turns "ask" or "deny" into "allow".
// Sessions without the key use `KETE_PERMISSION_MODE` from the runtime's environment, so an editor
// can set its default for new sessions.

export * as KetePermissionMode from "./permission-mode.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

export const metadataKey = "kete.permissionMode"
export const modes = ["default", "ask"] as const
export type Mode = (typeof modes)[number]

/** The actions "ask" mode asks before: file edits (edit, write, patch), shell commands and web fetches. */
export const guarded: ReadonlySet<string> = new Set(["edit", "shell", "webfetch"])

export function parse(value: unknown): Mode | undefined {
  return modes.find((mode) => mode === value)
}

/** Applies `mode` to one evaluation: "ask" turns an allowed guarded action into a prompt; nothing else changes. */
export function apply(event: { readonly action: string; effect: "allow" | "ask" | "deny" }, mode: Mode) {
  if (mode === "ask" && event.effect === "allow" && guarded.has(event.action)) event.effect = "ask"
}

export const Plugin = define({
  id: "kete.permission-mode",
  effect: Effect.fn(function* (ctx) {
    const raw = process.env.KETE_PERMISSION_MODE
    const fallback = parse(raw) ?? "default"
    if (raw !== undefined && raw !== "" && !parse(raw))
      yield* Effect.logWarning("ignoring KETE_PERMISSION_MODE: expected one of " + modes.join(", "), { value: raw })

    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.effect !== "allow" || !guarded.has(event.action)) return
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.option)
        const stored = session._tag === "Some" ? session.value.metadata?.[metadataKey] : undefined
        apply(event, parse(stored) ?? fallback)
      }),
    )
  }),
})
