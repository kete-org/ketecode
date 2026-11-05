// WS1 1.2: a session's mode (`kete.sessionMode`, Code | Work) is chosen at creation and then fixed.
// A session without the key is a Code session. A child stays in its parent's mode, and a Work
// session stores its profile's agent as the session's `agent` at create, so every `Agent.select`
// caller agrees. Pure, no services: session.ts and session/session.ts call these guards, and
// refusals die like KeteAddDir.RefusedError / KeteUnattendedPolicy.LockedError (session hooks can't fail).

export * as KeteSessionMode from "./session-mode.js"

import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import { Agent } from "@opencode/schema/agent"
import type { KeteModesRpc } from "@opencode/schema/kete/modes"
import { KeteSessionModes } from "@opencode/util/kete/session-mode"
import { KeteModes } from "./modes.js"
import type { SessionSchema } from "../session/schema.js"

export const metadataKey = KeteSessionModes.metadataKey

// util has no internal deps, so its mode list is a copy of the schema's; this fails to compile if they drift.
const _sameModes: [KeteSessionModes.Mode] extends [KeteModesRpc.Id]
  ? [KeteModesRpc.Id] extends [KeteSessionModes.Mode]
    ? true
    : never
  : never = true
void _sameModes

type Lookup = (id: KeteModesRpc.Id) => KeteModesRpc.Profile

export class RefusedError extends Error {
  constructor(reason: string) {
    super(`Can't create this session with "${metadataKey}": ${reason}`)
    this.name = "KeteSessionModeRefusedError"
  }
}

export class LockedError extends Error {
  constructor(reason: string) {
    super(`This session's "${metadataKey}" is locked: ${reason}`)
    this.name = "KeteSessionModeLockedError"
  }
}

/** The mode of already-validated metadata. */
export function mode(metadata: SessionSchema.Metadata | undefined): KeteSessionModes.Mode {
  return KeteSessionModes.parse(metadata?.[metadataKey]) ?? "code"
}

/**
 * Validates `kete.sessionMode` on a new session. Returns the metadata to store: `next`, with the
 * parent's key forced on when a child supplies its own metadata without it.
 */
export function guardCreate(
  parent: SessionSchema.Metadata | undefined,
  next: SessionSchema.Metadata | undefined,
  lookup: Lookup = KeteModes.get,
): Effect.Effect<SessionSchema.Metadata | undefined> {
  if (next === undefined) return Effect.succeed(undefined)
  if (metadataKey in next) {
    const requested = KeteSessionModes.parse(next[metadataKey])
    if (requested === undefined)
      return Effect.die(new RefusedError(`${JSON.stringify(next[metadataKey])} is not a session mode`))
    if (!lookup(requested).available)
      return Effect.die(new RefusedError(`the "${requested}" mode isn't available yet`))
  }
  if (parent === undefined) return Effect.succeed(next)
  // A child that leaves the key out inherits it; one that names a different mode is refused.
  const stored = metadataKey in next || !(metadataKey in parent) ? next : { ...next, [metadataKey]: parent[metadataKey] }
  if (mode(stored) !== mode(parent)) return Effect.die(new RefusedError("a child session must stay in its parent's mode"))
  return Effect.succeed(stored)
}

/** Refuses a metadata update that adds, changes or drops `kete.sessionMode`. */
export function guardMetadata(
  current: SessionSchema.Metadata | undefined,
  next: SessionSchema.Metadata,
): Effect.Effect<void> {
  const before = current?.[metadataKey]
  const after = next[metadataKey]
  if (before === undefined && after === undefined) return Effect.void
  if (before === undefined)
    return Effect.die(new LockedError("it can only be set when the session is created, not added afterward"))
  if (!isDeepStrictEqual(before, after)) return Effect.die(new LockedError("it can't be changed or removed while set"))
  return Effect.void
}

/** The agent a session of this mode starts with. Code returns none: today's default chain (`default_agent`, then build) stays in charge. */
export function agent(metadata: SessionSchema.Metadata | undefined, lookup: Lookup = KeteModes.get): Agent.ID | undefined {
  const current = mode(metadata)
  return current === "code" ? undefined : Agent.ID.make(lookup(current).agent)
}
