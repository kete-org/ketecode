import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Money } from "@opencode/schema/money"
import { Worktree as WorktreeSchema } from "@opencode/schema/worktree"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { AppProcess } from "@opencode/util/process"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { KeteGit } from "@opencode/core/kete/git"
import { KeteWorktrees } from "@opencode/core/kete/worktrees"
import { KeteSessionMove } from "@opencode/core/kete/session-move"
import { KeteStaleWrite } from "@opencode/core/kete/stale-write"
import { FileAccess } from "@opencode/core/file-access"
import { Environment } from "@opencode/core/environment/index"
import { KeteWorktreeName } from "@opencode/core/kete/worktree-name"
import { SessionMove } from "@opencode/core/session/move"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Plugin } from "@opencode/core/plugin"
import { Project } from "@opencode/core/project"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { Worktree } from "@opencode/core/worktree"
import { WorktreeStrategies } from "@opencode/core/worktree/strategies"
import { initRepo } from "../fixture/git"
import { Brand } from "@opencode/util/kete/brand"
import { tmpdir } from "../fixture/tmpdir"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "../lib/tool"

const childText = "child final response"
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const record = (overrides: Partial<KeteWorktrees.Record> = {}): KeteWorktrees.Record => ({
  sessionID: Session.ID.make("ses_child"),
  projectID: Project.ID.make("prj_1"),
  root: "/data/worktree/abc/agent-x",
  branch: "kete/agent-x",
  base: "0123456789abcdef0123",
  source: "/repo",
  ...overrides,
})

// A child answers at once. By its title, it first commits a file ("commit") or leaves one
// uncommitted ("dirty") in its own directory.
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("KeteWorktreesTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        completed.add(sessionID)
        const session = yield* store.get(sessionID)
        const directory = session?.location.directory
        if (directory && session?.title?.includes("commit"))
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(directory, "feature.txt"), "feature\n")
            await $`git add feature.txt`.cwd(directory).quiet()
            await $`git commit -m feature`.cwd(directory).quiet()
          })
        if (directory && session?.title?.includes("dirty"))
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "draft.txt"), "draft\n"))
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: childText })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const plugins = makeLocationNode({
  name: "test/kete-worktrees-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(KeteWorktrees.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(KeteSessionMove.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(KeteStaleWrite.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    Tool.node,
    PluginHooks.node,
    Worktree.node,
    WorktreeStrategies.node,
    Project.node,
    FileAccess.node,
    Environment.node,
    KV.node,
    FSUtil.node,
    Global.node,
    AppProcess.node,
  ],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      KV.node,
      Session.node,
      SessionExecution.node,
      LocationServiceMap.node,
      Worktree.node,
      AppProcess.node,
      FSUtil.node,
      Project.node,
    ]),
    [
      SessionExecution.node.replace(executionNode),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(plugins),
    ],
  ),
)

/** A parent session at the root of a new git repository with one commit. */
/** Like `setup`, with `config` written as the repository's Kete configuration file (uncommitted). */
const setupWith = (config?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(dir.path))
    if (config !== undefined)
      yield* Effect.promise(() => Bun.write(path.join(dir.path, Brand.configFiles[0]), JSON.stringify(config)))
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }) })
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(parent.location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
      }),
    ).pipe(Effect.provide(locations.get(parent.location)))
    const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
    const run = (id: string, input: Record<string, unknown>) =>
      executeTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: { type: "tool-call", id, name: SubagentTool.name, input: { agent: "reviewer", ...input } },
      })
    const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
    const call = { agent: toolIdentity.agent, messageID: toolIdentity.messageID }
    /** Fires `tool`'s execute.before hooks as `sessionID`, as if the model called it with `input`. */
    const before = (tool: string, sessionID: Session.ID, input: Record<string, unknown>) =>
      hooks.trigger("tool", "execute.before", {
        tool,
        sessionID,
        ...call,
        id: Tool.CallID.make(`call-${tool}-${Math.random()}`),
        input,
      })
    /** Fires `tool`'s execute.after hooks for a completed call. */
    const after = (tool: string, sessionID: Session.ID, input: Record<string, unknown>, output?: unknown) =>
      hooks.trigger("tool", "execute.after", {
        tool,
        sessionID,
        ...call,
        id: Tool.CallID.make(`call-${tool}-${Math.random()}`),
        input,
        status: "completed",
        result: { content: [], ...(output === undefined ? {} : { output }) },
      })
    /** Fires the session_move tool's execute.before hooks as `sessionID` calling it with `input`. */
    const move = (sessionID: Session.ID, input: Record<string, unknown>) =>
      hooks.trigger("tool", "execute.before", {
        tool: "opencode_session_move",
        sessionID,
        agent: toolIdentity.agent,
        messageID: toolIdentity.messageID,
        id: Tool.CallID.make(`call-move-${Math.random()}`),
        input,
      })
    const git = (directory: string, ...args: string[]) =>
      Effect.promise(() => $`git ${args}`.cwd(directory).quiet().nothrow())
    return { dir: dir.path, sessions, parent, run, git, move, before, after }
  })

const setup = setupWith()

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

const Content = Schema.Array(Schema.Struct({ text: Schema.String }))
const text = (result: { readonly content?: unknown }) =>
  Schema.decodeUnknownSync(Content)(result.content ?? [])
    .map((part) => part.text)
    .join("\n")

describe("KeteWorktrees helpers", () => {
  test("only the session a record names owns the worktree", () => {
    const metadata = { [KeteWorktrees.metadataKey]: record() }
    expect(KeteWorktrees.owned({ id: Session.ID.make("ses_child"), metadata })).toEqual(record())
    expect(KeteWorktrees.owned({ id: Session.ID.make("ses_grandchild"), metadata })).toBeUndefined()
    expect(KeteWorktrees.owned({ id: Session.ID.make("ses_child"), metadata: { other: 1 } })).toBeUndefined()
  })

  test("finds the repository directory from a session's subpath", () => {
    const location = Location.Ref.make({ directory: AbsolutePath.make(path.join("/repo", "packages", "app")) })
    expect(KeteWorktrees.projectDirectory({ location, subpath: undefined })).toBe(location.directory)
    expect(KeteWorktrees.projectDirectory({ location, subpath: "packages/app" as KeteWorktreesSubpath })).toBe(
      path.resolve("/repo"),
    )
  })

  test("describes the branch, its commits and uncommitted changes", () => {
    const note = KeteWorktrees.describe(record(), { commits: 2, changes: 1 })
    expect(note).toContain('branch="kete/agent-x"')
    expect(note).toContain("2 commits since 0123456789ab, and 1 uncommitted change in its worktree")
    expect(note).toContain("git merge kete/agent-x")
    expect(note).toContain("Uncommitted changes aren't on the branch")
    expect(KeteWorktrees.describe(record(), { commits: 1, changes: 0 })).not.toContain("Uncommitted")
  })
})

type KeteWorktreesSubpath = NonNullable<Parameters<typeof KeteWorktrees.projectDirectory>[0]["subpath"]>

describe("KeteWorktreeName", () => {
  test("accepts one ordinary path segment", () => {
    for (const name of ["agent-brave-otter", "feature_1", "v2.0"]) expect(KeteWorktreeName.valid(name)).toBe(true)
  })

  test("refuses separators, dot segments, and names Windows can't hold", () => {
    for (const name of [
      "",
      " ",
      "..",
      ".",
      "../x",
      "a/b",
      "a\\b",
      "c:x",
      "x.",
      "x ",
      " x",
      "CON",
      "nul.txt",
      "a\u0001",
    ])
      expect(KeteWorktreeName.valid(name)).toBe(false)
  })
})

describe("KeteStaleWrite rules", () => {
  test("remembers the latest fingerprint per session and file, and forgets the oldest past the limit", () => {
    const seen = new KeteStaleWrite.Seen(2)
    seen.set("s1", "/a", "1")
    seen.set("s1", "/b", "2")
    seen.set("s2", "/a", "3")
    expect(seen.get("s1", "/a")).toBeUndefined()
    expect(seen.get("s1", "/b")).toBe("2")
    expect(seen.get("s2", "/a")).toBe("3")
    seen.set("s2", "/a", "missing")
    expect(seen.get("s2", "/a")).toBeUndefined()
  })

  test("refuses to overwrite an unread or changed file, never a new or untracked one", () => {
    expect(KeteStaleWrite.refusal("a.ts", "missing", undefined)).toBeUndefined()
    expect(KeteStaleWrite.refusal("a.ts", "untracked", undefined)).toBeUndefined()
    expect(KeteStaleWrite.refusal("a.ts", "h1", "h1")).toBeUndefined()
    expect(KeteStaleWrite.refusal("a.ts", "h1", undefined)).toContain("hasn't read it")
    expect(KeteStaleWrite.refusal("a.ts", "h2", "h1")).toContain("changed since this session last read it")
  })
})

describe("KeteWorktrees.guard", () => {
  it.live("only removes a detached worktree with commits no branch holds when forced", () =>
    Effect.gen(function* () {
      const { dir, git } = yield* setup
      const worktree = path.join(dir, "..", `${path.basename(dir)}-detached`)
      yield* git(dir, "worktree", "add", "--detach", worktree)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })))
      yield* git(worktree, "commit", "--allow-empty", "-m", "orphan")

      const removed: boolean[] = []
      const strategy: WorktreeStrategies.Strategy = {
        id: WorktreeSchema.StrategyID.make("git"),
        create: () => Effect.die("unused"),
        list: () => Effect.succeed([]),
        remove: (input) => Effect.sync(() => void removed.push(input.force)),
      }
      const guarded = KeteWorktrees.guard(strategy, yield* KeteGit.make)
      const directory = AbsolutePath.make(worktree)

      const refused = yield* guarded.remove({ directory, force: false }).pipe(Effect.flip)
      expect(refused).toBeInstanceOf(WorktreeSchema.OperationError)
      expect(refused).toMatchObject({
        forceRequired: true,
        message: expect.stringContaining("1 commit that no branch"),
      })
      expect(removed).toEqual([])

      yield* guarded.remove({ directory, force: true })
      expect(removed).toEqual([true])

      yield* git(worktree, "branch", "keep-it")
      yield* guarded.remove({ directory, force: false })
      expect(removed).toEqual([true, false])
    }),
  )
})

describe("subagent worktrees", () => {
  it.live("runs a child on its own branch and reports the commits it made", () =>
    Effect.gen(function* () {
      const { dir, sessions, parent, run, git } = yield* setup
      const result = yield* run("call-commit", { description: "commit feature", prompt: "add it", worktree: true })
      expect(result).toMatchObject({ status: "completed", metadata: { status: "completed" } })

      const child = yield* sessions.get(outputSessionID(result.metadata))
      const owned = KeteWorktrees.owned(child)
      expect(owned?.branch).toStartWith("kete/agent-")
      expect(`${child.location.directory}`).toBe(owned!.root)
      expect(child.location.directory).not.toBe(parent.location.directory)
      expect(text(result)).toContain(`<worktree branch="${owned!.branch}"`)
      expect(text(result)).toContain("1 commit since")

      // The commit is on the branch, and the parent's checkout is untouched.
      expect((yield* git(dir, "log", "--format=%s", owned!.branch)).stdout.toString()).toContain("feature")
      expect(yield* Effect.promise(() => exists(path.join(dir, "feature.txt")))).toBe(false)

      // The child's prompt told it where it works.
      const prompt = (yield* sessions.inbox(child.id)).find((item) => item.type === "user")
      expect(prompt?.type === "user" ? prompt.payload.text : "").toContain(`on branch ${owned!.branch}`)
    }),
  )

  it.live("removes the worktree and branch of a child that changed nothing, and refuses to continue it", () =>
    Effect.gen(function* () {
      const { dir, sessions, parent, run, git } = yield* setup
      const result = yield* run("call-nothing", { description: "look around", prompt: "read", worktree: true })
      expect(result).toMatchObject({ status: "completed" })
      expect(text(result)).toContain("changed nothing, so its worktree and branch")

      const childID = outputSessionID(result.metadata)
      const owned = KeteWorktrees.owned(yield* sessions.get(childID))
      expect(yield* Effect.promise(() => exists(owned!.root))).toBe(false)
      expect((yield* git(dir, "branch", "--list", owned!.branch)).stdout.toString().trim()).toBe("")
      yield* sessions.wait(childID)
      expect((yield* sessions.get(childID)).location.directory).toBe(parent.location.directory)

      const continued = yield* run("call-continue", { description: "again", prompt: "more", sessionID: childID })
      expect(continued).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("its worktree was removed") },
      })
    }),
  )

  it.live("keeps a worktree with uncommitted changes and says so", () =>
    Effect.gen(function* () {
      const { sessions, run } = yield* setup
      const result = yield* run("call-dirty", { description: "dirty draft", prompt: "draft", worktree: true })
      expect(text(result)).toContain("1 uncommitted change in its worktree")
      const owned = KeteWorktrees.owned(yield* sessions.get(outputSessionID(result.metadata)))
      expect(yield* Effect.promise(() => exists(path.join(owned!.root, "draft.txt")))).toBe(true)
    }),
  )

  it.live("keeps other sessions out of a subagent's worktree", () =>
    Effect.gen(function* () {
      const { sessions, parent, run } = yield* setup
      const result = yield* run("call-leased", { description: "commit feature", prompt: "add it", worktree: true })
      const child = yield* sessions.get(outputSessionID(result.metadata))
      const owned = KeteWorktrees.owned(child)!
      const locations = yield* LocationServiceMap.Service
      const worktrees = yield* KeteWorktrees.make.pipe(Effect.provide(locations.get(parent.location)))
      expect((yield* worktrees.leasedTo(owned.root, parent.id))?.sessionID).toBe(child.id)
      expect(yield* worktrees.leasedTo(path.join(owned.root, "src"), parent.id)).toBeDefined()
      expect(yield* worktrees.leasedTo(owned.root, child.id)).toBeUndefined()
      expect(yield* worktrees.leasedTo(parent.location.directory, parent.id)).toBeUndefined()
    }),
  )

  it.live("keeps other sessions out of a subagent's worktree, through the tool and every other move", () =>
    Effect.gen(function* () {
      const { sessions, parent, run, move } = yield* setup
      const result = yield* run("call-move", { description: "commit feature", prompt: "add it", worktree: true })
      const owned = KeteWorktrees.owned(yield* sessions.get(outputSessionID(result.metadata)))!

      const refused = yield* move(parent.id, { directory: owned.root }).pipe(Effect.flip)
      expect(refused.message).toContain(`${owned.root} is subagent`)
      yield* move(parent.id, { directory: parent.location.directory })

      // The UI and HTTP API move through SessionMove, which refuses too.
      const direct = yield* sessions
        .move({ sessionID: parent.id, directory: AbsolutePath.make(owned.root) })
        .pipe(Effect.flip)
      expect(direct).toBeInstanceOf(SessionMove.DestinationUnavailableError)
    }),
  )

  it.live("session_move moves only the current session or its subagents", () =>
    Effect.gen(function* () {
      const { dir, sessions, parent, move } = yield* setup
      const other = yield* sessions.create({ location: parent.location, title: "someone else's" })
      const child = yield* sessions.create({ parentID: parent.id, title: "child" })
      const refused = yield* move(parent.id, { sessionID: other.id, directory: dir }).pipe(Effect.flip)
      expect(refused.message).toContain("can only move the current session or one of its subagents")
      yield* move(parent.id, { sessionID: child.id, directory: dir })
    }),
  )

  it.live("session_move asks external_directory for a destination outside the repository", () =>
    Effect.gen(function* () {
      const { sessions, parent, move } = yield* setup
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* sessions.setPermissions({
        sessionID: parent.id,
        permissions: [{ action: "external_directory", resource: "*", effect: "deny" }],
      })
      const refused = yield* move(parent.id, { directory: outside.path }).pipe(Effect.flip)
      expect(refused.message).toContain("external_directory")
      // Inside the repository nothing is asked.
      yield* move(parent.id, { directory: path.join(parent.location.directory, ".") })
    }),
  )

  it.live("refuses worktree names that would land outside the worktree directory", () =>
    Effect.gen(function* () {
      const { parent } = yield* setup
      const worktrees = yield* Worktree.Service
      for (const name of ["../escape", "..", "a/b", "a\\b", ""]) {
        const error = yield* worktrees.create({ projectID: parent.projectID, name }).pipe(Effect.flip)
        expect(error).toMatchObject({ message: expect.stringContaining("Invalid worktree name") })
      }
    }),
  )

  it.live("a write can't overwrite a version of a file its session hasn't seen", () =>
    Effect.gen(function* () {
      const { dir, sessions, parent, before, after } = yield* setup
      const other = yield* sessions.create({ location: parent.location, title: "other agent" })
      const file = path.join(dir, "notes.md")
      yield* Effect.promise(() => fs.writeFile(file, "one\n"))
      const write = (sessionID: Session.ID) => before("write", sessionID, { path: "notes.md", content: "mine\n" })

      // Never read: refused. A new file: allowed.
      expect((yield* write(parent.id).pipe(Effect.flip)).message).toContain("hasn't read it")
      yield* before("write", parent.id, { path: "new.md", content: "x" })

      // Read, then written: allowed.
      yield* after("read", parent.id, { path: "notes.md" })
      yield* write(parent.id)

      // Another session changes it: the first session's next write is refused until it reads again.
      yield* after("read", other.id, { path: "notes.md" })
      yield* Effect.promise(() => fs.writeFile(file, "two\n"))
      yield* after("write", other.id, { path: "notes.md" }, { target: file })
      expect((yield* write(parent.id).pipe(Effect.flip)).message).toContain("changed since this session last read it")
      yield* write(other.id)
      yield* after("read", parent.id, { path: "notes.md" })
      yield* write(parent.id)

      // A session's own edits and patches count as seen.
      yield* Effect.promise(() => fs.writeFile(file, "three\n"))
      yield* after("edit", parent.id, { path: "notes.md" })
      yield* write(parent.id)
      yield* Effect.promise(() => fs.writeFile(file, "four\n"))
      yield* after(
        "patch",
        parent.id,
        { patchText: "" },
        { applied: [{ type: "update", resource: "notes.md", target: file }] },
      )
      yield* write(parent.id)
    }),
  )

  it.live("asks before an agent-created worktree runs the project's setup script", () =>
    Effect.gen(function* () {
      const { sessions, parent, run } = yield* setup
      const projects = yield* Project.Service
      yield* projects.update({ projectID: parent.projectID, commands: { start: "touch setup-ran" } })
      yield* sessions.setPermissions({
        sessionID: parent.id,
        permissions: [{ action: "shell", resource: "touch setup-ran", effect: "deny" }],
      })
      const refused = yield* run("call-setup-denied", { description: "look", prompt: "read", worktree: true })
      // Upstream reports a denied permission as the tool's standard permission rejection.
      expect(refused).toMatchObject({
        status: "error",
        error: { type: "permission.rejected", message: "Permission denied: shell" },
      })
      expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)

      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [] })
      const allowed = yield* run("call-setup-allowed", { description: "commit feature", prompt: "add", worktree: true })
      const owned = KeteWorktrees.owned(yield* sessions.get(outputSessionID(allowed.metadata)))!
      expect(yield* Effect.promise(() => exists(path.join(owned.root, "setup-ran")))).toBe(true)
    }),
  )

  it.live('kete.subagents.worktree "background" isolates background subagents that may edit', () =>
    Effect.gen(function* () {
      const { sessions, run } = yield* setupWith({ kete: { subagents: { worktree: "background" } } })
      const background = yield* run("call-auto", { description: "commit feature", prompt: "add", background: true })
      const owned = () =>
        sessions.get(outputSessionID(background.metadata)).pipe(Effect.map((child) => KeteWorktrees.owned(child)))
      expect((yield* owned())?.branch).toStartWith("kete/agent-")

      // Foreground subagents, and an explicit `worktree: false`, share the checkout.
      const foreground = yield* run("call-fg", { description: "look", prompt: "read" })
      expect(KeteWorktrees.owned(yield* sessions.get(outputSessionID(foreground.metadata)))).toBeUndefined()
      const declined = yield* run("call-no", { description: "look", prompt: "read", background: true, worktree: false })
      expect(KeteWorktrees.owned(yield* sessions.get(outputSessionID(declined.metadata)))).toBeUndefined()
    }),
  )

  it.live("sweeps the clean worktree of a deleted subagent but keeps its branch's commits", () =>
    Effect.gen(function* () {
      const { dir, sessions, parent, run, git } = yield* setup
      const result = yield* run("call-sweep", { description: "commit feature", prompt: "add it", worktree: true })
      const childID = outputSessionID(result.metadata)
      const owned = KeteWorktrees.owned(yield* sessions.get(childID))!
      yield* sessions.remove(childID)

      const locations = yield* LocationServiceMap.Service
      const worktrees = yield* KeteWorktrees.make.pipe(Effect.provide(locations.get(parent.location)))
      yield* worktrees.sweep
      expect(yield* Effect.promise(() => exists(owned.root))).toBe(false)
      expect((yield* git(dir, "log", "--format=%s", owned.branch)).stdout.toString()).toContain("feature")
    }),
  )
})
