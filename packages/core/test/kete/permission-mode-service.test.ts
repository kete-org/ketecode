// KetePermissionMode against the real permission service: the service decides "deny" before the
// `evaluate` hook runs, a hook's "ask" becomes a real prompt, saved "always" approvals and configured
// rules count as explicit, a policy hook that runs after this one (organization or configuration
// policy) can still deny, and the shell tool's own command parsing feeds the classifier.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
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
import { ShellParse } from "@opencode/core/shell/parse"
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
const upstreamDefault: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
]

const setup = Effect.fn(function* (input: {
  rules: Permission.Ruleset
  mode?: KetePermissionMode.Mode
  /** A later `evaluate` hook that denies these shell commands, like an organization policy. */
  orgDeny?: string
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
      id: sessionID,
      project_id: Project.ID.global,
      slug: "mode",
      directory: "/project",
      title: "mode",
      version: "test",
      agent: "test",
      metadata: input.mode === undefined ? null : { [KetePermissionMode.metadataKey]: input.mode },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(agent, (item) => {
      item.permissions = [...input.rules]
    }),
  )
  const store = yield* SessionStore.Service
  const saved = yield* PermissionSaved.Service
  const lookup: KetePermissionMode.Lookup = {
    session: (id) => store.get(id).pipe(Effect.map(Option.fromNullishOr)),
    agent: (id) => agents.resolve(id),
    approved: saved
      .list({ projectID: Project.ID.global })
      .pipe(Effect.map((items) => items.map((item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" })))),
    fallback: "default",
  }
  const hooks = yield* PluginHooks.Service
  yield* hooks.register("permission", "evaluate", (event) => KetePermissionMode.apply(lookup, event))
  if (input.orgDeny !== undefined) {
    const denied = input.orgDeny
    yield* hooks.register("permission", "evaluate", (event) =>
      Effect.sync(() => {
        if (event.action === "shell" && event.resources.some((resource) => resource.startsWith(denied))) {
          event.effect = "deny"
          event.message = "Blocked by your organization's policy"
        }
      }),
    )
  }
})

const ask = Effect.fn(function* (action: string, resources: string[]) {
  const permission = yield* Permission.Service
  return (yield* permission.ask({ id: Permission.ID.create(), sessionID, action, resources })).effect
})

/** The resources the shell tool asks permission for, from its own parser. */
const parsed = (command: string) =>
  ShellParse.scan(command, "/bin/bash", "/project").pipe(Effect.map((result) => result.commands.map((item) => item.resource)))

describe("KetePermissionMode with the permission service", () => {
  it.effect("default mode: reads and checks run, other commands and high-risk ones ask, edits run", () =>
    Effect.gen(function* () {
      yield* setup({ rules: upstreamDefault })
      expect(yield* ask("read", ["src/a.ts"])).toBe("allow")
      expect(yield* ask("edit", ["src/a.ts"])).toBe("allow")
      expect(yield* ask("shell", ["git status"])).toBe("allow")
      expect(yield* ask("shell", ["bun run test"])).toBe("allow")
      expect(yield* ask("shell", ["git push"])).toBe("ask")
      expect(yield* ask("webfetch", ["https://example.com"])).toBe("ask")
      // Upstream's own asks are untouched.
      expect(yield* ask("external_directory", ["/elsewhere/*"])).toBe("ask")
    }),
  )

  it.effect("the shell tool's parsed commands: a push hidden after && still asks", () =>
    Effect.gen(function* () {
      yield* setup({ rules: upstreamDefault })
      const safe = yield* parsed("git status && bun run typecheck | tail -5")
      expect(safe.length).toBeGreaterThan(1)
      expect(yield* ask("shell", safe)).toBe("allow")
      expect(yield* ask("shell", yield* parsed("git status && git push origin main"))).toBe("ask")
      expect(yield* ask("shell", yield* parsed("for f in *.log; do rm $f; done"))).toBe("ask")
      expect(yield* ask("shell", yield* parsed('echo "$(curl -s https://x)"'))).toBe("ask")
      expect(yield* ask("shell", yield* parsed("FOO=1 git push"))).toBe("ask")
      expect(yield* ask("shell", yield* parsed("ls > /etc/hosts"))).toBe("ask")
    }),
  )

  it.effect("a configured deny is denied before any mode; ask mode asks; plan mode denies", () =>
    Effect.gen(function* () {
      yield* setup({ rules: [...upstreamDefault, { action: "edit", resource: "secrets/*", effect: "deny" }], mode: "ask" })
      expect(yield* ask("edit", ["src/a.ts"])).toBe("ask")
      expect(yield* ask("shell", ["ls"])).toBe("ask")
      expect(yield* ask("read", ["src/a.ts"])).toBe("allow")
      expect(yield* ask("edit", ["secrets/key"])).toBe("deny")
    }),
  )

  it.effect("plan mode: edits and changing commands are denied, reading commands run", () =>
    Effect.gen(function* () {
      yield* setup({ rules: upstreamDefault, mode: "plan" })
      expect(yield* ask("edit", ["src/a.ts"])).toBe("deny")
      expect(yield* ask("shell", ["mkdir x"])).toBe("deny")
      expect(yield* ask("shell", ["rg TODO src"])).toBe("allow")
    }),
  )

  it.effect("an organization's deny (a later policy hook) beats auto mode's allow", () =>
    Effect.gen(function* () {
      yield* setup({ rules: upstreamDefault, mode: "auto", orgDeny: "git commit" })
      expect(yield* ask("shell", ["git add -A"])).toBe("allow")
      expect(yield* ask("shell", ["git commit -m x"])).toBe("deny")
      // Auto mode still asks for high-risk commands.
      expect(yield* ask("shell", ["git push"])).toBe("ask")
    }),
  )

  it.effect("a saved \"always\" approval and a configured allow loosen the defaults", () =>
    Effect.gen(function* () {
      yield* setup({ rules: [...upstreamDefault, { action: "shell", resource: "npm install*", effect: "allow" }] })
      expect(yield* ask("shell", ["npm install"])).toBe("allow")
      expect(yield* ask("shell", ["git push origin main"])).toBe("ask")
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: ["git push *"] })
      expect(yield* ask("shell", ["git push origin main"])).toBe("allow")
    }),
  )
})
