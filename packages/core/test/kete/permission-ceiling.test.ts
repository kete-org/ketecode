import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KetePermissionCeiling } from "@opencode/core/kete/permission-ceiling"
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

describe("KetePermissionCeiling rules", () => {
  test("the stricter of two decisions", () => {
    expect(KetePermissionCeiling.stricter("allow", "ask")).toBe("ask")
    expect(KetePermissionCeiling.stricter("ask", "deny")).toBe("deny")
    expect(KetePermissionCeiling.stricter("allow", "allow")).toBe("allow")
  })

  test("a request is denied if any resource is, and asks if any does", () => {
    const rules: Permission.Ruleset = [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "edit", resource: "secret/*", effect: "deny" },
    ]
    expect(KetePermissionCeiling.decide("edit", ["a.ts", "secret/key"], rules)).toBe("deny")
    expect(KetePermissionCeiling.decide("edit", ["a.ts"], rules)).toBe("allow")
    expect(KetePermissionCeiling.decide("shell", ["ls"], rules)).toBe("ask")
  })
})

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
    ]),
    [Location.node.replace(current)],
  ),
)

const root = Session.ID.make("ses_root")
const child = Session.ID.make("ses_child")
const grandchild = Session.ID.make("ses_grandchild")

/** root (agent `reader`) → child (agent `writer`) → grandchild (agent `writer`). */
const setup = Effect.fn(function* (reader: Permission.Ruleset, policy: Permission.Ruleset = []) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const [id, parent, agent] of [
    [root, undefined, "reader"],
    [child, root, "writer"],
    [grandchild, child, "writer"],
  ] as const)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        parent_id: parent,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        agent,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("reader"), (item) => {
      item.permissions = [...reader]
    })
    editor.update(Agent.ID.make("writer"), (item) => {
      item.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    })
  })
  const store = yield* SessionStore.Service
  const saved = yield* PermissionSaved.Service
  const lookup: KetePermissionCeiling.Lookup = {
    session: (sessionID) => store.get(sessionID).pipe(Effect.map(Option.fromNullishOr)),
    agent: (agentID) => agents.resolve(agentID),
    approved: saved
      .list({ projectID: Project.ID.global })
      .pipe(
        Effect.map((items) =>
          items.map((item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" })),
        ),
      ),
    policy: () => Effect.succeed(policy),
  }
  const hooks = yield* PluginHooks.Service
  yield* hooks.register("permission", "evaluate", (event) => KetePermissionCeiling.apply(lookup, event))
})

const ask = Effect.fn(function* (sessionID: Session.ID, action: string, resource: string) {
  const permission = yield* Permission.Service
  return (yield* permission.ask({ id: Permission.ID.create(), sessionID, action, resources: [resource] })).effect
})

describe("KetePermissionCeiling with the permission service", () => {
  it.effect("a subagent can't do what the agent that started it can't", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
      ])
      // The writer child would allow everything on its own.
      expect(yield* ask(child, "read", "src/a.ts")).toBe("allow")
      expect(yield* ask(child, "edit", "src/a.ts")).toBe("deny")
      // Nothing matches `shell` for the reader, so it would ask: the child asks too.
      expect(yield* ask(child, "shell", "ls")).toBe("ask")
      // Every ancestor counts, not only the parent.
      expect(yield* ask(grandchild, "edit", "src/a.ts")).toBe("deny")
      // A root session is unaffected.
      expect(yield* ask(root, "read", "src/a.ts")).toBe("allow")
    }),
  )

  it.effect("a saved approval covers the ancestors as it does the child", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      expect(yield* ask(child, "shell", "ls")).toBe("ask")
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: ["ls"] })
      expect(yield* ask(child, "shell", "ls")).toBe("allow")
    }),
  )

  it.effect("a saved approval never overrides an ancestor's deny", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "edit", resource: "*", effect: "deny" }])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "edit", resources: ["*"] })
      expect(yield* ask(child, "edit", "src/a.ts")).toBe("deny")
    }),
  )

  it.effect("an unattended run's policy covers the ancestors as a saved approval does, but never an ancestor's deny", () =>
    Effect.gen(function* () {
      yield* setup(
        [{ action: "read", resource: "*", effect: "allow" }],
        [{ action: "shell", resource: "ls", effect: "allow" }],
      )
      // The reader parent would ask for shell; the child gets what the run's policy allows it.
      expect(yield* ask(child, "shell", "ls")).toBe("allow")
      expect(yield* ask(child, "shell", "rm -rf /")).toBe("ask")
    }),
  )
})
