// AC4 against the real Session.Service (pattern: session-create.test.ts's "stores creation metadata"
// / "stores permission rules" cases): once `kete.unattended` is set at creation, `setMetadata` can't
// drop, change or add it — the guard dies (KeteUnattendedPolicy.LockedError, D1) rather than
// returning a typed error, so other metadata keys still update normally. D2: `setPermissions` is
// refused for the whole family while it's unattended; an interactive session is unaffected.
// AC3: a child created with its own metadata (a worktree subagent's `{}`, or any explicit value)
// still gets `kete.unattended` forced onto its own metadata (`inheritMetadata`), so a session
// resolving `KeteUnattendedPolicy` for that child never depends on a parent row that could later
// go missing.
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { KeteUnattendedPolicy } from "@opencode/core/kete/unattended-policy"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { promptLocationNode } from "../fixture/prompt-location"
import { globalProjectNode } from "../lib/project"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
      InstructionEntry.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("KeteUnattendedPolicy's guard on Session.setMetadata / setPermissions", () => {
  it.effect("AC4: refuses dropping, changing or adding kete.unattended; other keys still update", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const policy = { "kete.unattended": { version: 1, budget: 5 } }
      const created = yield* session.create({ location, metadata: { ...policy, other: 1 } })
      expect(created.metadata).toEqual({ ...policy, other: 1 })

      const dropped = yield* session.setMetadata({ sessionID: created.id, metadata: { other: 2 } }).pipe(Effect.exit)
      expect(Exit.isFailure(dropped)).toBe(true)
      expect(Cause.squash(Exit.isFailure(dropped) ? dropped.cause : Cause.empty)).toBeInstanceOf(
        KeteUnattendedPolicy.LockedError,
      )

      const changed = yield* session
        .setMetadata({ sessionID: created.id, metadata: { "kete.unattended": { version: 1, budget: 10 }, other: 2 } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(changed)).toBe(true)

      // Metadata is unchanged after both refusals.
      expect((yield* session.get(created.id)).metadata).toEqual({ ...policy, other: 1 })

      // Other keys still update, as long as kete.unattended is resubmitted unchanged.
      yield* session.setMetadata({ sessionID: created.id, metadata: { ...policy, other: 2 } })
      expect((yield* session.get(created.id)).metadata).toEqual({ ...policy, other: 2 })
    }),
  )

  it.effect("AC4: an interactive session's metadata is unaffected", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location, metadata: { thread: "a" } })
      yield* session.setMetadata({ sessionID: created.id, metadata: { thread: "b" } })
      expect((yield* session.get(created.id)).metadata).toEqual({ thread: "b" })
    }),
  )

  it.effect("refuses adding kete.unattended to a session that didn't have it", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const added = yield* session
        .setMetadata({ sessionID: created.id, metadata: { "kete.unattended": { version: 1 } } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(added)).toBe(true)
    }),
  )

  it.effect("D2: refuses setPermissions while a session's family is unattended", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location, metadata: { "kete.unattended": { version: 1 } } })
      const child = yield* session.create({ parentID: created.id })

      const onRoot = yield* session
        .setPermissions({ sessionID: created.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] })
        .pipe(Effect.exit)
      expect(Exit.isFailure(onRoot)).toBe(true)

      const onChild = yield* session
        .setPermissions({ sessionID: child.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] })
        .pipe(Effect.exit)
      expect(Exit.isFailure(onChild)).toBe(true)
    }),
  )

  it.effect("D2: an interactive session's setPermissions is unaffected", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const permissions = [{ action: "edit", resource: "*", effect: "deny" as const }]
      yield* session.setPermissions({ sessionID: created.id, permissions })
      expect((yield* session.get(created.id)).permissions).toEqual(permissions)
    }),
  )

  it.effect("AC3: a child created with its own explicit metadata {} (a worktree subagent) still carries kete.unattended", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const policy = { version: 1, budget: 5 }
      const root = yield* session.create({ location, metadata: { "kete.unattended": policy } })
      const child = yield* session.create({ parentID: root.id, metadata: {} })
      expect(child.metadata).toEqual({ "kete.unattended": policy })

      // Even a child with unrelated metadata of its own gets the key forced onto it.
      const otherChild = yield* session.create({ parentID: root.id, metadata: { worktree: "kete/agent-x" } })
      expect(otherChild.metadata).toEqual({ worktree: "kete/agent-x", "kete.unattended": policy })
    }),
  )

  it.effect("a plain child of an interactive session is unaffected", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const root = yield* session.create({ location })
      const child = yield* session.create({ parentID: root.id, metadata: {} })
      expect(child.metadata).toEqual({})
    }),
  )
})
