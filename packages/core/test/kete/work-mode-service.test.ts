// Work mode against the real permission service and the session store: the service runs the `evaluate`
// hook, a Work root and a child stored without metadata are both held to the Work files rule (the mode
// is read from the root-most session), a Code session is not, and the refusal lands in the root's audit
// file. Sessions are inserted as rows (as permission-mode-service.test.ts does): Work isn't available
// through `Session.create` until WS1 1.4, and the tests don't override that.
import { afterAll, beforeAll, describe, expect } from "bun:test"
import nfs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { KeteAudit } from "@opencode/core/kete/audit"
import { KeteModes } from "@opencode/core/kete/modes"
import { KeteWorkMode } from "@opencode/core/kete/work-mode"
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

const rules: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
const ids = { work: Session.ID.make("ses_svc_work"), child: Session.ID.make("ses_svc_child"), code: Session.ID.make("ses_svc_code") }

const fs = {
  existsSafe: (value: string) => Effect.sync(() => nfs.existsSync(value)),
  resolve: (value: string) => Effect.sync(() => FSUtil.resolve(value)),
  readLink: (value: string) => Effect.try({ try: () => nfs.readlinkSync(value), catch: (error) => error }),
} as unknown as KeteWorkMode.Deps["fs"]

let tmp: string
let location_: string
let granted: string
beforeAll(() => {
  tmp = nfs.realpathSync(nfs.mkdtempSync(path.join(os.tmpdir(), "kete-work-svc-")))
  location_ = path.join(tmp, "work")
  granted = path.join(tmp, "granted")
  for (const dir of [location_, granted, path.join(tmp, "sibling"), path.join(tmp, "data")]) nfs.mkdirSync(dir, { recursive: true })
})
afterAll(() => nfs.rmSync(tmp, { recursive: true, force: true }))

const setup = Effect.fn(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const row = (id: Session.ID, extra: Pick<typeof SessionTable.$inferInsert, "metadata" | "parent_id">) =>
    db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test", agent: Agent.ID.make("test"), ...extra })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  yield* row(ids.work, { metadata: { "kete.sessionMode": "work" } })
  yield* row(ids.child, { metadata: null, parent_id: ids.work })
  yield* row(ids.code, { metadata: null })
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (item) => {
      item.permissions = [...rules]
    }),
  )
  const store = yield* SessionStore.Service
  const writer = KeteAudit.makeWriterState(path.join(tmp, "data"), KeyedMutex.makeUnsafe<string>())
  const deps: KeteWorkMode.Deps = {
    profile: KeteModes.get("work"),
    platform: "linux",
    directory: location_,
    session: (id) => store.get(id).pipe(Effect.map(Option.fromNullishOr)),
    roots: () => Effect.succeed([location_, granted]),
    fs,
    audit: (root, line) => KeteAudit.appendWork(writer, root, line),
    cache: new Map(),
    gated: new Set(),
  }
  const hooks = yield* PluginHooks.Service
  yield* hooks.register("permission", "evaluate", (event) => KeteWorkMode.onEvaluate(deps, event))
})

const ask = Effect.fn(function* (sessionID: Session.ID, action: string, resources: string[]) {
  const permission = yield* Permission.Service
  return (yield* permission.ask({ id: Permission.ID.create(), sessionID, action, resources })).effect
})

describe("KeteWorkMode with the permission service", () => {
  it.effect("a Work root and its child are held to the granted folders; a Code session is not", () =>
    Effect.gen(function* () {
      yield* setup()
      const outside = path.join(tmp, "sibling", "x.txt")
      for (const id of [ids.work, ids.child]) {
        expect(yield* ask(id, "read", ["a.txt"])).toBe("allow")
        expect(yield* ask(id, "read", [path.join(granted, "f.txt")])).toBe("allow")
        expect(yield* ask(id, "read", [outside])).toBe("deny")
        expect(yield* ask(id, "edit", ["../x.txt"])).toBe("deny")
        expect(yield* ask(id, "external_directory", [path.join(tmp, "sibling", "*")])).toBe("deny")
      }
      expect(yield* ask(ids.code, "read", [outside])).toBe("allow")
      expect(yield* ask(ids.code, "external_directory", [path.join(tmp, "sibling", "*")])).toBe("allow")
      const file = path.join(tmp, "data", "audit", `${ids.work}.jsonl`)
      const written = nfs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      // Three refusals each for the root and the child (outside read, ../ edit, outside folder), all in the root's file.
      expect(written).toHaveLength(6)
      expect(written.every((line) => line.type === "work_refusal" && line.root_id === ids.work)).toBe(true)
      expect(nfs.existsSync(path.join(tmp, "data", "audit", `${ids.child}.jsonl`))).toBe(false)
    }),
  )
})
