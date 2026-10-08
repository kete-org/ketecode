// The chat panel's permission-mode toggle: Default -> Auto -> Ask -> Plan. Every state is the
// runtime's `kete.permissionMode` session metadata (core/src/kete/permission-mode.ts enforces it;
// the TUI, the CLI's --permission-mode and the extensions write the same key). Plan also selects
// upstream's `plan` agent (core/src/plugin/plan.ts) when it's offered, for its planning prompt; the
// mode is what makes it read-only. The toggle never writes `permissions` directly, and no mode turns
// "ask" or "deny" into "allow": even Auto still asks before high-risk commands.

import type { SessionMetadata } from "@opencode/client/promise"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"

export type Mode = KetePermissionModes.Mode
export const MODES = KetePermissionModes.cycle
export const LABEL = KetePermissionModes.label
export const DESCRIPTION = KetePermissionModes.description

export const PLAN_AGENT = "plan"
const METADATA_KEY = KetePermissionModes.metadataKey

/** The toggle's displayed state, from the composer's current agent and the session's metadata. */
export function derive(input: { agent?: string; metadata?: SessionMetadata; fallback?: Mode }): Mode {
  if (input.agent === PLAN_AGENT) return "plan"
  return KetePermissionModes.parse(input.metadata?.[METADATA_KEY]) ?? input.fallback ?? "default"
}

/** Cycles Default -> Auto -> Ask -> Plan -> Default. */
export function next(mode: Mode): Mode {
  return KetePermissionModes.next(mode)
}

/** Merges `mode`'s permission-mode key into `metadata`, keeping every other key. */
export function withMode(metadata: SessionMetadata | undefined, mode: Mode): SessionMetadata {
  return { ...metadata, [METADATA_KEY]: mode }
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

  /** `session.create`'s `metadata` field for this draft: undefined when nothing was chosen, so other
   *  callers see no change. */
  export function metadata(draftID: string): SessionMetadata | undefined {
    const mode = drafts.get(draftID)
    if (mode === undefined) return undefined
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

/** Selects the `plan` agent for Plan (remembering the one it replaced) and restores it when leaving Plan. */
export function selectAgent(agent: ApplyAgent, key: string, mode: Mode) {
  if (mode === "plan") {
    if (!agent.options().includes(PLAN_AGENT) || agent.current() === PLAN_AGENT) return
    rememberedAgent.set(key, agent.current())
    agent.select(PLAN_AGENT)
    return
  }
  if (agent.current() !== PLAN_AGENT) return
  // Nothing remembered (Plan was already selected when this session's toggle first mounted):
  // restore the first non-Plan agent offered, as the closest thing to "the default agent".
  const fallback = rememberedAgent.get(key) ?? agent.options().find((id) => id !== PLAN_AGENT)
  if (fallback) agent.select(fallback)
  rememberedAgent.delete(key)
}

/**
 * Applies `mode` to an existing session: GET-merge-PATCH `kete.permissionMode` (metadata is replaced
 * whole server-side, so the current value is read first — the same pattern the VS Code extension
 * uses), then selects or leaves the `plan` agent. The mode is written first, so Plan's read-only
 * rule is in force before the agent changes.
 */
export async function apply(input: { sdk: ModeSDK; sessionID: string; mode: Mode; agent: ApplyAgent }) {
  const { sdk, sessionID, mode, agent } = input
  const session = await sdk.session.get({ sessionID })
  await sdk.session.update({ sessionID, metadata: withMode(session.metadata, mode) })
  selectAgent(agent, sessionID, mode)
}

export * as KeteMode from "./mode.js"
