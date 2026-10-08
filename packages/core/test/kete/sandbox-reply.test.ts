// The OS sandbox's network mark comes from a person's reply to that very request (core/src/permission.ts,
// kete/sandbox/actions.ts): "once" or "always" marks it; a request an "always" resolves without being
// shown is not marked; "reject" marks nothing.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteSandboxActions } from "@opencode/core/kete/sandbox/actions"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const current = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") })))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

const sessionID = Session.ID.make("ses_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "test", directory: "/project", title: "test", version: "test", agent: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  // Every shell request asks.
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = [{ action: "shell", resource: "*", effect: "ask" }]
    }),
  )
})

/** Starts a shell permission check and waits until it is pending; returns its metadata object. */
const pending = (id: string, command: string) =>
  Effect.gen(function* () {
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<void>()
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Permission.Event.Asked.type && (event.data as Permission.Request).id === id
        ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const metadata: Record<string, unknown> = { command }
    const fiber = yield* service
      .assert({ id: Permission.ID.create(id), sessionID, action: "shell", resources: [command], save: [command], metadata })
      .pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(asked)
    return { fiber, metadata }
  })

describe("sandbox network mark from the person's reply", () => {
  it.effect("once and always mark the answered request only; requests an always resolves are not marked", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* Permission.Service
      const first = yield* pending("per_first", "make serve")
      // The same command again, waiting behind the first: the "always" below resolves it unseen.
      const second = yield* pending("per_second", "make serve")
      yield* service.reply({ requestID: Permission.ID.create("per_first"), reply: "always" })
      expect((yield* Fiber.join(first.fiber))._tag).toBe("Success")
      // Resolved by the "always" (allowed, never shown) — and not marked.
      expect((yield* Fiber.join(second.fiber))._tag).toBe("Success")
      expect(KeteSandboxActions.approved(first.metadata)).toBe(true)
      expect(KeteSandboxActions.approved(second.metadata)).toBe(false)

      const third = yield* pending("per_third", "npm install")
      yield* service.reply({ requestID: Permission.ID.create("per_third"), reply: "once" })
      yield* Fiber.join(third.fiber)
      expect(KeteSandboxActions.approved(third.metadata)).toBe(true)

      const fourth = yield* pending("per_fourth", "curl example.com")
      yield* service.reply({ requestID: Permission.ID.create("per_fourth"), reply: "reject" })
      yield* Fiber.join(fourth.fiber)
      expect(KeteSandboxActions.approved(fourth.metadata)).toBe(false)
    }),
  )
})
