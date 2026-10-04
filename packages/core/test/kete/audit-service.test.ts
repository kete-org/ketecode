// Real-service coverage for kete/audit.ts: the permission `evaluate` hook registered after the
// unattended chain (policy, mode, ceiling, the late "ask becomes deny" hook), real `Session.Service`
// resolution (so a subagent's lines land in the root's file), and the tool/model/file/command
// handlers called the way kete/unattended.ts's `Plugin` wires them. Pure/writer-level coverage
// (redaction, the per-run cap, fail-closed) is in audit.test.ts.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeteAudit } from "@opencode/core/kete/audit"
import { KetePermissionCeiling } from "@opencode/core/kete/permission-ceiling"
import { KeteUnattended } from "@opencode/core/kete/unattended"
import { KeteUnattendedPolicy } from "@opencode/core/kete/unattended-policy"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, Agent.node, PluginHooks.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

const root = Session.ID.make("ses_audit_root")
const child = Session.ID.make("ses_audit_child")

/**
 * root (agent `rootAgent`) → child (agent `childAgent`), root carrying `kete.unattended`, child
 * without its own copy — the same setup unattended-service.test.ts uses to prove a subagent still
 * resolves to the root; here it also proves the subagent's audit lines land in the root's file.
 */
const setup = Effect.fn(function* (input: {
  readonly policy: KeteUnattendedPolicy.Policy | undefined
  readonly rootRules: Permission.Ruleset
  readonly dataDir: string
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
      item.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    })
  })

  const store = yield* SessionStore.Service
  const get: KeteUnattendedPolicy.Get = (sessionID) => store.get(sessionID).pipe(Effect.map(Option.fromNullishOr))
  const policyLookup: KeteUnattended.PolicyLookup = { session: get, agent: (agentID) => agents.resolve(agentID) }
  const ceilingLookup: KetePermissionCeiling.Lookup = {
    session: get,
    agent: (agentID) => agents.resolve(agentID),
    approved: Effect.succeed([]),
    policy: (sessionID) =>
      KeteUnattendedPolicy.resolve(get, sessionID).pipe(
        Effect.map((state) =>
          state.kind === "unattended" && state.invalid === undefined
            ? (state.policy.allow ?? []).map((rule): Permission.Rule => ({ ...rule, effect: "allow" }))
            : [],
        ),
      ),
  }

  const writer = KeteAudit.makeWriterState(input.dataDir, KeyedMutex.makeUnsafe<string>())
  const deps: KeteAudit.Deps = {
    writer,
    resolve: KeteAudit.makeResolveCache(get),
    stopReason: () => Effect.succeed(undefined),
    interrupt: () => Effect.void,
    stepModels: new Map(),
    shellStarts: new Map(),
  }
  // The root's file must exist before any hook writes to it, as run-checks.ts's `begin` guarantees
  // for an unattended family — never called for an interactive one (AC6), so this mirrors that.
  if (input.policy !== undefined)
    yield* KeteAudit.create(input.dataDir, root, {
      v: 1,
      ts: new Date().toISOString(),
      type: "run",
      event: "started",
      session_id: root,
      root_id: root,
      policy: input.policy,
      limits: { missing: [] },
    })

  const hooks = yield* PluginHooks.Service
  // Registered in plugin/internal.ts's order: the policy hook, the ceiling, the late deny hook,
  // then the read-only audit hook last (D1 B, kete/unattended.ts's Plugin installs it after applyLate).
  yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyPolicy(policyLookup, event))
  yield* hooks.register("permission", "evaluate", (event) => KetePermissionCeiling.apply(ceilingLookup, event))
  yield* hooks.register("permission", "evaluate", (event) => KeteUnattended.applyLate(get, event, { globalConfig: "/global-config" }))
  yield* hooks.register("permission", "evaluate", (event) => KeteAudit.onEvaluate(deps, event))

  return { deps }
})

const ask = Effect.fn(function* (sessionID: Session.ID, action: string, resource: string) {
  const permission = yield* Permission.Service
  return yield* permission.ask({ id: Permission.ID.create(), sessionID, action, resources: [resource] })
})

const readLines = async (dir: string, sessionID: string) => {
  const text = await readFile(path.join(dir, "audit", `${sessionID}.jsonl`), "utf8")
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

const fileExists = async (dir: string, sessionID: string) =>
  stat(path.join(dir, "audit", `${sessionID}.jsonl`)).then(
    () => true,
    () => false,
  )

describe("KeteAudit with the permission service", () => {
  it.effect("AC2: a denied ask (the unattended deny) produces a permission line with its reason", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* setup({ policy: { version: 1 }, rootRules: [], dataDir: tmp.path })
      yield* ask(root, "shell", "rm -rf /")
      const lines = yield* Effect.promise(() => readLines(tmp.path, root))
      const permission = lines.find((line) => line.type === "permission")
      expect(permission).toMatchObject({ action: "shell", effect: "deny", message: "unattended run: not allowed by this run's policy" })
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )

  it.effect("AC2: an allow rule in the run's policy produces a permission line with effect allow", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* setup({
        policy: { version: 1, allow: [{ action: "shell", resource: "safe *" }] },
        rootRules: [],
        dataDir: tmp.path,
      })
      yield* ask(root, "shell", "safe test")
      const lines = yield* Effect.promise(() => readLines(tmp.path, root))
      const permission = lines.find((line) => line.type === "permission")
      expect(permission).toMatchObject({ action: "shell", effect: "allow" })
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )

  it.effect("AC2: a subagent's permission lines land in the root's file, not its own", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* setup({
        policy: { version: 1, allow: [{ action: "shell", resource: "safe *" }] },
        rootRules: [],
        dataDir: tmp.path,
      })
      yield* ask(child, "shell", "safe test")
      const lines = yield* Effect.promise(() => readLines(tmp.path, root))
      expect(lines.find((line) => line.type === "permission" && line.session_id === child)).toMatchObject({
        root_id: root,
        effect: "allow",
      })
      expect(yield* Effect.promise(() => fileExists(tmp.path, child))).toBe(false)
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )

  it.effect("AC6: an interactive session writes nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* setup({ policy: undefined, rootRules: [{ action: "shell", resource: "*", effect: "ask" }], dataDir: tmp.path })
      yield* ask(root, "shell", "ls")
      expect(yield* Effect.promise(() => fileExists(tmp.path, root))).toBe(false)
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )

  it.effect("AC2: a tool call, a model step and a shell command each produce the expected line", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const { deps } = yield* setup({ policy: { version: 1 }, rootRules: [], dataDir: tmp.path })

      yield* KeteAudit.onToolAfter(deps, {
        tool: "edit",
        sessionID: root,
        agent: "rootAgent",
        messageID: "msg_1",
        id: "call_1",
        input: { path: "src/a.ts", oldString: "a", newString: "b" },
        status: "completed",
        result: { output: { files: [{ file: "src/a.ts", patch: "", additions: 1, deletions: 1, status: "modified" }], replacements: 1 } },
      } as any)

      deps.shellStarts.set("call_2", Date.now() - 5)
      yield* KeteAudit.onToolAfter(deps, {
        tool: "shell",
        sessionID: root,
        agent: "rootAgent",
        messageID: "msg_1",
        id: "call_2",
        input: { command: "bun test", workdir: "/project" },
        status: "completed",
        result: { output: { exit: 0, truncated: false, output: "ok", status: "completed" } },
      } as any)

      const started = { id: "evt_1", type: "session.step.started", created: 0, data: { sessionID: root, assistantMessageID: "msg_1", agent: "rootAgent", model: { id: "sonnet", providerID: "anthropic" }, started: 0 }, durable: { aggregateID: "agg", seq: 1, version: 1 } } as any
      const ended = { id: "evt_2", type: "session.step.ended", created: 0, data: { sessionID: root, assistantMessageID: "msg_1", finish: "stop", cost: 0.02, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, durable: { aggregateID: "agg", seq: 2, version: 1 } } as any
      yield* KeteAudit.onEvent(deps, started)
      yield* KeteAudit.onEvent(deps, ended)

      const lines = yield* Effect.promise(() => readLines(tmp.path, root))
      expect(lines.find((line) => line.type === "tool" && line.tool === "edit")).toMatchObject({ status: "completed" })
      expect(lines.find((line) => line.type === "file")).toMatchObject({ path: "src/a.ts", operation: "edit" })
      expect(lines.find((line) => line.type === "command")).toMatchObject({ command: "bun test", cwd: "/project", exit: 0 })
      expect(lines.find((line) => line.type === "model")).toMatchObject({ provider: "anthropic", model: "sonnet", cost_usd: 0.02 })

      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )
})
