// KetePermissionMode relies on the permission service deciding "deny" before the `evaluate` hook runs,
// and on a hook's "ask" becoming a real prompt. This checks both against the real service.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
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
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, PluginHooks.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

const sessionID = Session.ID.make("ses_mode")
const agent = Agent.ID.make("test")

const setup = Effect.fn(function* (rules: Permission.Ruleset) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "mode", directory: "/project", title: "mode", version: "test", agent: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(agent, (item) => {
      item.permissions = [...rules]
    }),
  )
  // The plugin's decision for a session in "ask" mode.
  const hooks = yield* PluginHooks.Service
  yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => KetePermissionMode.apply(event, "ask")))
})

const ask = Effect.fn(function* (action: string, resource: string) {
  const permission = yield* Permission.Service
  return (yield* permission.ask({ id: Permission.ID.create(), sessionID, action, resources: [resource] })).effect
})

describe("KetePermissionMode with the permission service", () => {
  it.effect("an allowed edit or command asks; reads stay allowed; a denied edit stays denied", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "allow" },
        { action: "edit", resource: "secrets/*", effect: "deny" },
      ])
      expect(yield* ask("edit", "src/a.ts")).toBe("ask")
      expect(yield* ask("shell", "ls")).toBe("ask")
      expect(yield* ask("read", "src/a.ts")).toBe("allow")
      expect(yield* ask("edit", "secrets/key")).toBe("deny")
    }),
  )
})
