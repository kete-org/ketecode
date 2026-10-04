// KeteUnattended relies on the permission service deciding "deny" before the `evaluate` hook runs
// (an unattended policy's "allow" only ever loosens an "ask"), and on the hooks running in the same
// order plugin/internal.ts registers them: the policy hook, then permission mode, then the subagent
// ceiling (all `pre`), then the late "ask becomes deny" hook (`post`, last). This checks the whole
// chain against the real service, the way permission-mode-service.test.ts and permission-ceiling.test.ts do.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteRunChecks } from "@opencode/core/kete/run-checks"
import { KetePermissionCeiling } from "@opencode/core/kete/permission-ceiling"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { KeteUnattended } from "@opencode/core/kete/unattended"
import { KeteUnattendedPolicy } from "@opencode/core/kete/unattended-policy"
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
import { KeteUnattendedSchema } from "@opencode/schema/kete/unattended"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

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

const root = Session.ID.make("ses_ua_root")
const child = Session.ID.make("ses_ua_child")

/**
 * root (agent `rootAgent`) → child (agent `childAgent`), inserted directly with its own
 * `metadata: {}` rather than through `Session.create` — as a session created before every family
 * member carried its own copy of `kete.unattended` would look, so `resolve`'s defensive
 * ancestor walk is what finds the root's policy here, not the child's own metadata.
 */
const globalConfig = "/global-config"

const setup = Effect.fn(function* (input: {
  readonly policy: KeteUnattendedPolicy.Policy | undefined
  readonly rootRules: Permission.Ruleset
  readonly childRules?: Permission.Ruleset
  /** Registers KetePermissionMode's hook in "ask" mode, between the policy hook and the ceiling. */
  readonly askMode?: boolean
}) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: root,
      project_id: Project.ID.global,
      slug: root,
      directory: "/project",
      title: root,
      version: "test",
      agent: "rootAgent",
      metadata: input.policy === undefined ? null : { "kete.unattended": input.policy },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: child,
      parent_id: root,
      project_id: Project.ID.global,
      slug: child,
      directory: "/project",
      title: child,
      version: "test",
      agent: "childAgent",
      // No copy of its own; resolve must walk up to the root to find the policy.
      metadata: {},
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("rootAgent"), (item) => {
      item.permissions = [...input.rootRules]
    })
    editor.update(Agent.ID.make("childAgent"), (item) => {
      item.permissions = [...(input.childRules ?? [{ action: "*", resource: "*", effect: "allow" }])]
    })
  })

  const store = yield* SessionStore.Service
  const saved = yield* PermissionSaved.Service
  const get: KeteUnattendedPolicy.Get = (sessionID) => store.get(sessionID).pipe(Effect.map(Option.fromNullishOr))
  const policyLookup: KeteUnattended.PolicyLookup = { session: get, agent: (agentID) => agents.resolve(agentID) }
  const ceilingLookup: KetePermissionCeiling.Lookup = {
    session: get,
    agent: (agentID) => agents.resolve(agentID),
    approved: saved
      .list({ projectID: Project.ID.global })
      .pipe(
        Effect.map((items) =>
          items.map((item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" })),
        ),
      ),
    policy: (sessionID) =>
      KeteUnattendedPolicy.resolve(get, sessionID).pipe(
        Effect.map((state) => (state.kind === "unattended" && state.invalid === undefined ? (state.policy.allow ?? []).map((rule): Permission.Rule => ({ ...rule, effect: "allow" })) : [])),
      ),
  }

  const hooks = yield* PluginHooks.Service
  // Registered in the order plugin/internal.ts wires them: policy (pre, early), mode (pre), ceiling
  // (pre, later), the late "ask becomes deny" hook (post, last).
  yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyPolicy(policyLookup, event))
  if (input.askMode) yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => KetePermissionMode.apply(event, "ask")))
  yield* hooks.register("permission", "evaluate", (event) => KetePermissionCeiling.apply(ceilingLookup, event))
  yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyLate(get, event, { globalConfig }))
})

const ask = Effect.fn(function* (sessionID: Session.ID, action: string, resource: string) {
  const permission = yield* Permission.Service
  return yield* permission.ask({ id: Permission.ID.create(), sessionID, action, resources: [resource] })
})

describe("KeteUnattended with the permission service", () => {
  it.effect("AC1: denies an ask in an unattended family without a permission.asked event", () =>
    Effect.gen(function* () {
      yield* setup({ policy: { version: 1 }, rootRules: [] })
      const permission = yield* Permission.Service
      const result = yield* ask(root, "shell", "rm -rf /")
      expect(result.effect).toBe("deny")
      // Permission.ask only publishes Permission.Event.Asked, and adds a pending request, when the
      // decision is "ask" (permission.ts:223-229): an empty pending list proves neither happened.
      expect(yield* permission.list()).toHaveLength(0)
    }),
  )

  it.effect("AC2: an allow rule in the run's policy lets a matching ask through; a deny rule still wins over it", () =>
    Effect.gen(function* () {
      yield* setup({
        policy: { version: 1, allow: [{ action: "shell", resource: "safe *" }, { action: "edit", resource: "*" }] },
        rootRules: [{ action: "edit", resource: "secrets/*", effect: "deny" }],
      })
      expect((yield* ask(root, "shell", "safe test")).effect).toBe("allow")
      expect((yield* ask(root, "shell", "danger")).effect).toBe("deny")
      // The policy's edit allow can't override the agent's own deny rule.
      expect((yield* ask(root, "edit", "secrets/key")).effect).toBe("deny")
    }),
  )

  it.effect("AC2: the policy can't allow what permission mode denies", () =>
    Effect.gen(function* () {
      yield* setup({
        policy: { version: 1, allow: [{ action: "edit", resource: "*" }] },
        rootRules: [{ action: "*", resource: "*", effect: "allow" }],
        askMode: true,
      })
      // Without "ask" mode the policy would let this through; mode tightens "allow" to "ask" after
      // the policy hook runs, and the late hook then denies the remaining "ask" — never "allow".
      expect((yield* ask(root, "edit", "src/a.ts")).effect).toBe("deny")
    }),
  )

  it.effect("AC2: the policy can't allow what the subagent permission ceiling denies", () =>
    Effect.gen(function* () {
      yield* setup({
        policy: { version: 1, allow: [{ action: "shell", resource: "*" }] },
        rootRules: [{ action: "shell", resource: "*", effect: "deny" }],
        childRules: [{ action: "*", resource: "*", effect: "allow" }],
      })
      // The child's own rules allow shell, and the policy would too; the root's deny still caps it.
      expect((yield* ask(child, "shell", "ls")).effect).toBe("deny")
    }),
  )

  it.effect("D2: editing Kete configuration is denied in an unattended family even when the policy and the agent both allow edit", () =>
    Effect.gen(function* () {
      yield* setup({
        policy: { version: 1, allow: [{ action: "edit", resource: "*" }] },
        rootRules: [{ action: "edit", resource: "*", effect: "allow" }],
      })
      expect((yield* ask(root, "edit", ".kete/kete.jsonc")).effect).toBe("deny")
      expect((yield* ask(root, "edit", "src/a.ts")).effect).toBe("allow")
    }),
  )

  it.effect("D2: an interactive session's own edit rules are unaffected — .kete/kete.jsonc is allowed like any other path", () =>
    Effect.gen(function* () {
      yield* setup({ policy: undefined, rootRules: [{ action: "edit", resource: "*", effect: "allow" }] })
      expect((yield* ask(root, "edit", ".kete/kete.jsonc")).effect).toBe("allow")
    }),
  )

  it.effect("AC3: a subagent of an unattended session is also unattended, resolved by walking to the root", () =>
    Effect.gen(function* () {
      yield* setup({
        policy: { version: 1, allow: [{ action: "shell", resource: "safe *" }] },
        rootRules: [],
        childRules: [{ action: "*", resource: "*", effect: "allow" }],
      })
      // The child session was inserted with its own metadata: {}, and still resolves the root's
      // policy, never falling back to an interactive default.
      expect((yield* ask(child, "shell", "safe test")).effect).toBe("allow")
      expect((yield* ask(child, "shell", "rm -rf /")).effect).toBe("deny")
      expect((yield* ask(child, "question", "anything")).effect).toBe("deny")
    }),
  )

  it.effect("AC6: an interactive family is unaffected", () =>
    Effect.gen(function* () {
      yield* setup({ policy: undefined, rootRules: [{ action: "shell", resource: "*", effect: "ask" }] })
      expect((yield* ask(root, "shell", "ls")).effect).toBe("ask")
    }),
  )

  it.effect("an interactive session with a missing parent row behaves as before: an ask produces a permission.asked pending request", () =>
    Effect.gen(function* () {
      // session_v2.parent_id has no FK; this reproduces a session whose parent row was never (or
      // no longer) there. Neither session carries kete.unattended, so KeteUnattendedPolicy.resolve
      // must find interactive, not fail closed.
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const orphan = Session.ID.make("ses_ua_orphan")
      const missingParent = Session.ID.make("ses_ua_missing_parent")
      yield* db
        .insert(SessionTable)
        .values({
          id: orphan,
          parent_id: missingParent,
          project_id: Project.ID.global,
          slug: orphan,
          directory: "/project",
          title: orphan,
          version: "test",
          agent: "rootAgent",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("rootAgent"), (item) => {
          item.permissions = []
        })
      })
      const store = yield* SessionStore.Service
      const get: KeteUnattendedPolicy.Get = (sessionID) => store.get(sessionID).pipe(Effect.map(Option.fromNullishOr))
      const policyLookup: KeteUnattended.PolicyLookup = { session: get, agent: (agentID) => agents.resolve(agentID) }
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyPolicy(policyLookup, event))
      yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyLate(get, event, { globalConfig }))

      const permission = yield* Permission.Service
      const result = yield* ask(orphan, "shell", "ls")
      expect(result.effect).toBe("ask")
      expect(yield* permission.list()).toHaveLength(1)
    }),
  )

  it.effect("a child that carries its own copy of kete.unattended stays unattended even when the root row is gone", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const orphanChild = Session.ID.make("ses_ua_orphan_child")
      const goneRoot = Session.ID.make("ses_ua_gone_root")
      const policy = { version: 1 as const, allow: [{ action: "shell", resource: "safe *" }] }
      yield* db
        .insert(SessionTable)
        .values({
          id: orphanChild,
          parent_id: goneRoot, // never inserted: as if the root row was deleted
          project_id: Project.ID.global,
          slug: orphanChild,
          directory: "/project",
          title: orphanChild,
          version: "test",
          agent: "rootAgent",
          metadata: { "kete.unattended": policy },
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("rootAgent"), (item) => {
          item.permissions = []
        })
      })
      const store = yield* SessionStore.Service
      const get: KeteUnattendedPolicy.Get = (sessionID) => store.get(sessionID).pipe(Effect.map(Option.fromNullishOr))
      const policyLookup: KeteUnattended.PolicyLookup = { session: get, agent: (agentID) => agents.resolve(agentID) }
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyPolicy(policyLookup, event))
      yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyLate(get, event, { globalConfig }))

      expect((yield* ask(orphanChild, "shell", "safe test")).effect).toBe("allow")
      expect((yield* ask(orphanChild, "shell", "danger")).effect).toBe("deny")
    }),
  )
})

// AC3: job mode implies unattended (kete/run-checks.ts). A separate harness: KeteRunChecks.make
// needs Config and KeteBudget's Permission dependency to construct, on top of the services above.
const itRunChecks = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
      Global.node,
      Config.node,
    ]),
    [Location.node.replace(current), Config.node.replace(Config.testLayer([]))],
  ),
)

describe("KeteRunChecks: job mode implies unattended", () => {
  const jobRoot = Session.ID.make("ses_job_root")
  const previous = process.env.OPENCODE_JOB_MODE
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENCODE_JOB_MODE
    else process.env.OPENCODE_JOB_MODE = previous
  })

  itRunChecks.effect("an interactive session in job mode is refused before KeteBudget, classified 'refused'", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: jobRoot,
          project_id: Project.ID.global,
          slug: jobRoot,
          directory: "/project",
          title: jobRoot,
          version: "test",
          agent: "rootAgent",
          // No kete.unattended: interactive by KeteUnattendedPolicy.resolve.
          metadata: {},
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      process.env.OPENCODE_JOB_MODE = "1"
      const checker = yield* KeteRunChecks.make
      const failure = yield* checker({ sessionID: jobRoot, agent: Agent.ID.make("rootAgent"), cost: 0 }).pipe(Effect.flip)
      expect(failure.error.type).toBe("unattended")
      expect(KeteUnattendedSchema.classify(failure.error.message)).toBe("refused")
    }),
  )

  itRunChecks.effect("job mode off: an interactive session falls through to KeteBudget (no budget configured, so it passes)", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const id = Session.ID.make("ses_job_off")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test", agent: "rootAgent", metadata: {} })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      delete process.env.OPENCODE_JOB_MODE
      const checker = yield* KeteRunChecks.make
      yield* checker({ sessionID: id, agent: Agent.ID.make("rootAgent"), cost: 0 })
    }),
  )
})
