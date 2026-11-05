// WS1 1.2 against the real Session.Service: create validates `kete.sessionMode`, setMetadata locks it,
// children stay in their parent's mode. A Work create can't succeed until 1.3 (session-mode.test.ts covers it).
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "@opencode/schema/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { KeteSessionMode } from "@opencode/core/kete/session-mode"
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
const key = "kete.sessionMode"

const defectOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
  )

describe("kete.sessionMode on Session.create / setMetadata", () => {
  it.effect("a code session, with or without the key, stores no agent and the metadata as given", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const explicit = yield* session.create({ location, metadata: { [key]: "code" } })
      expect(explicit.agent).toBeUndefined()
      expect(explicit.metadata).toEqual({ [key]: "code" })
      const bare = yield* session.create({ location })
      expect(bare.agent).toBeUndefined()
      expect(bare.metadata).toBeUndefined()
    }),
  )

  it.effect("refuses an unknown mode and the unavailable work mode", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      for (const mode of ["chat", "work"]) {
        const error = yield* defectOf(session.create({ location, metadata: { [key]: mode } }))
        expect(error).toBeInstanceOf(KeteSessionMode.RefusedError)
        expect((error as Error).message).toContain(mode)
      }
    }),
  )

  it.effect("setMetadata refuses adding, changing and removing the key; an equal key passes", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const plain = yield* session.create({ location })
      expect(
        yield* defectOf(session.setMetadata({ sessionID: plain.id, metadata: { [key]: "code" } })),
      ).toBeInstanceOf(KeteSessionMode.LockedError)

      const created = yield* session.create({ location, metadata: { [key]: "code", other: 1 } })
      expect(
        yield* defectOf(session.setMetadata({ sessionID: created.id, metadata: { [key]: "work", other: 1 } })),
      ).toBeInstanceOf(KeteSessionMode.LockedError)
      expect(yield* defectOf(session.setMetadata({ sessionID: created.id, metadata: { other: 1 } }))).toBeInstanceOf(
        KeteSessionMode.LockedError,
      )
      yield* session.setMetadata({ sessionID: created.id, metadata: { [key]: "code", other: 2 } })
      expect((yield* session.get(created.id)).metadata).toEqual({ [key]: "code", other: 2 })
    }),
  )

  it.effect("a child carries its parent's key and can't take another mode", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const root = yield* session.create({ location, metadata: { [key]: "code" } })
      expect((yield* session.create({ parentID: root.id })).metadata).toEqual({ [key]: "code" })
      expect((yield* session.create({ parentID: root.id, metadata: {} })).metadata).toEqual({ [key]: "code" })
      expect(
        yield* defectOf(session.create({ parentID: root.id, metadata: { [key]: "work" } })),
      ).toBeInstanceOf(KeteSessionMode.RefusedError)
    }),
  )

  it.effect("an explicit agent is stored as given", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location, agent: Agent.ID.make("plan"), metadata: { [key]: "code" } })
      expect(String(created.agent)).toBe("plan")
    }),
  )
})

describe("kete.sessionMode on SessionTransfer.import", () => {
  it.effect("an import with an unknown or unavailable mode is refused; a code one is kept", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const template = yield* session.create({ location })
      for (const mode of ["chat", "work"]) {
        const error = yield* defectOf(
          transfer.import({ data: { info: { ...template, id: Session.ID.create(), metadata: { [key]: mode } }, messages: [] }, location }),
        )
        expect(error).toBeInstanceOf(KeteSessionMode.RefusedError)
      }
      const sessionID = Session.ID.create()
      yield* transfer.import({ data: { info: { ...template, id: sessionID, metadata: { [key]: "code" } }, messages: [] }, location })
      expect((yield* session.get(sessionID)).metadata).toEqual({ [key]: "code" })
    }),
  )
})
