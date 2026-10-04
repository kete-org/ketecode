// The chat panel's Auto -> Ask -> Plan toggle. "Auto" and "Ask" are the runtime's
// `kete.permissionMode` session metadata (core/src/kete/permission-mode.ts, "default"/"ask" — the
// extension's own toggle writes the same key); "Plan" is upstream's `plan` agent
// (core/src/plugin/plan.ts), selected like any other agent. The toggle only ever narrows
// permissions: it never writes `permissions` directly and never turns "ask" into "allow".

import type { SessionMetadata } from "@opencode/client/promise"

export const MODES = ["auto", "ask", "plan"] as const
export type Mode = (typeof MODES)[number]

export const PLAN_AGENT = "plan"
const METADATA_KEY = "kete.permissionMode"

/** The toggle's displayed state, from the composer's current agent and the session's metadata. */
export function derive(input: { agent?: string; metadata?: SessionMetadata; fallback?: Mode }): Mode {
  if (input.agent === PLAN_AGENT) return "plan"
  const value = input.metadata?.[METADATA_KEY]
  if (value === "ask") return "ask"
  if (value === "default") return "auto"
  return input.fallback ?? "auto"
}

/** Cycles Auto -> Ask -> Plan -> Auto, skipping Plan when the `plan` agent isn't available. */
export function next(mode: Mode, planAvailable: boolean): Mode {
  let index = MODES.indexOf(mode)
  for (let step = 0; step < MODES.length; step++) {
    index = (index + 1) % MODES.length
    const candidate = MODES[index]!
    if (candidate !== "plan" || planAvailable) return candidate
  }
  return mode
}

/** Merges `mode`'s permission-mode key into `metadata`, keeping every other key. Plan writes nothing
 *  here: it's an agent choice, applied separately (see `apply`). */
export function withMode(metadata: SessionMetadata | undefined, mode: Exclude<Mode, "plan">): SessionMetadata {
  return { ...metadata, [METADATA_KEY]: mode === "ask" ? "ask" : "default" }
}

/**
 * A new session's mode, chosen before it exists. Keyed by the new-session draft's ID
 * (`new-session/composer-adapter.ts`'s `props.draftID`); read once at `session.create` and cleared,
 * so a stale draft never leaks its mode into an unrelated session.
 */
export namespace KeteModeDraft {
  const drafts = new Map<string, Mode>()

  export function set(draftID: string, mode: Mode) {
    drafts.set(draftID, mode)
  }

  export function get(draftID: string): Mode | undefined {
    return drafts.get(draftID)
  }

  /** `session.create`'s `metadata` field for this draft: undefined when nothing (or Plan, an agent
   *  choice) needs to travel through metadata, so other callers see no change. */
  export function metadata(draftID: string): SessionMetadata | undefined {
    const mode = drafts.get(draftID)
    if (mode === undefined || mode === "plan") return undefined
    return withMode(undefined, mode)
  }

  export function clear(draftID: string) {
    drafts.delete(draftID)
  }
}

// The web UI's agent selector (composer/model.ts's `view.agent`) always has a current agent and only
// ever selects a named one — there's no "no agent" state to select back into — so both members here
// deal in plain strings, never undefined.
export type ApplyAgent = {
  current: () => string
  options: () => string[]
  select: (name: string) => void
}

/** Only the SDK surface `apply` needs, so it's testable without the real client: the real
 *  `ServerSDK["api"]` satisfies this structurally (`Composer.tsx` passes it straight through). */
export type ModeSDK = {
  session: {
    get: (input: { sessionID: string }) => Promise<{ metadata?: SessionMetadata }>
    update: (input: { sessionID: string; metadata: SessionMetadata }) => Promise<unknown>
  }
}

// The agent Plan mode replaces, per session, so leaving Plan restores it instead of stranding the
// session on the `plan` agent.
const rememberedAgent = new Map<string, string>()

/**
 * Applies `mode` to an existing session: Auto/Ask GET-merge-PATCH `kete.permissionMode` (metadata is
 * replaced whole server-side, so the current value is read first — the same pattern the VS Code
 * extension uses, kete-vscode/src/extension.ts:1247-1276); Plan selects the `plan` agent, remembering
 * the agent it replaced so leaving Plan restores it (or the default agent, if none was remembered).
 */
export async function apply(input: { sdk: ModeSDK; sessionID: string; mode: Mode; agent: ApplyAgent }) {
  const { sdk, sessionID, mode, agent } = input
  if (mode === "plan") {
    rememberedAgent.set(sessionID, agent.current())
    agent.select(PLAN_AGENT)
    return
  }
  if (agent.current() === PLAN_AGENT) {
    // Nothing remembered (Plan was already selected when this session's toggle first mounted):
    // restore the first non-Plan agent offered, as the closest thing to "the default agent".
    const fallback = rememberedAgent.get(sessionID) ?? agent.options().find((id) => id !== PLAN_AGENT)
    if (fallback) agent.select(fallback)
    rememberedAgent.delete(sessionID)
  }
  const session = await sdk.session.get({ sessionID })
  const metadata = withMode(session.metadata, mode)
  await sdk.session.update({ sessionID, metadata })
}

export * as KeteMode from "./mode.js"
