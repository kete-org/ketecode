// The local OS sandbox (ADR 0013, task 2026-10-08-local-sandbox) against the real shell tool and the
// real sandbox: sandbox-exec on macOS, bwrap on Linux. Skipped where neither works (Windows, Linux
// without bubblewrap or user namespaces): the probe says why. CI installs bubblewrap so these run.
//
// The permission service is a stub that allows everything, so these test the sandbox, not the
// permission hooks (sandbox.test.ts covers those).
import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { Tool } from "@opencode/core/tool"
import { KeteSandboxProbe } from "@opencode/core/kete/sandbox/probe"
import { tmpdir } from "../fixture/tmpdir"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "../lib/tool"

const probe = await KeteSandboxProbe.probe()
// CI sets KETE_SANDBOX_TESTS=required, so a broken bwrap fails there instead of skipping quietly.
if (!probe.available && process.env.KETE_SANDBOX_TESTS === "required")
  throw new Error(`sandbox-shell.test.ts: the sandbox is required here but unavailable: ${probe.reason}`)
if (!probe.available) console.log(`sandbox-shell.test.ts skipped: ${probe.reason}`)

const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("SandboxTest.complete")(function* (id: Session.ID) {
        const session = yield* store.get(id)
        if (!session) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID: id,
          assistantMessageID,
          agent: session.agent ?? Agent.ID.make("code"),
          model: sessionModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID: id,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (id) => complete(id).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const shellPluginSupervisor = makeLocationNode({
  name: "test/sandbox-shell-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    Tool.node,
    Global.node,
    Location.node,
  ],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      SessionExecution.node,
      LocationServiceMap.node,
      filesystem,
      FSUtil.node,
      Global.node,
    ]),
    [
      SessionExecution.node.replace(executionNode),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(shellPluginSupervisor),
    ],
  ),
)

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
}

interface Run {
  readonly text: string
  readonly exit: number | undefined
}

type Command = { readonly command: string; readonly sandbox?: "network" | "off" }

/** Runs each command through the shell tool in one session, in a fresh git repository. */
const inRepository = <A>(body: (dir: string, run: (input: Command) => Effect.Effect<Run>) => Effect.Effect<A>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => fs.realpath(tmp.path))
        git(dir, "init", "-q")
        git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
        const sessions = yield* Session.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(dir) })
        const session = yield* sessions.create({ title: "sandbox test", location, model: sessionModel })
        const locations = yield* LocationServiceMap.Service
        return yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const registry = yield* Tool.Service
          let calls = 0
          const run = (input: Command) =>
            Effect.gen(function* () {
              const settled = yield* executeTool(registry, {
                sessionID: session.id,
                ...toolIdentity,
                call: { type: "tool-call" as const, id: `call-${++calls}`, name: "shell", input },
              })
              expect(settled.status).toBe("completed")
              const text = (settled.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
              const output = (settled as { output?: { exit?: number } }).output
              return { text, exit: output?.exit }
            })
          return yield* body(dir, run)
        }).pipe(Effect.provide(locations.get(location)), Effect.ensuring(locations.invalidate(location)))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

const DENIED = /operation not permitted|read-only file system/i

describe.skipIf(!probe.available)("the local OS sandbox through the shell tool", () => {
  it.live(
    "writes inside the workspace and commits with git",
    () =>
      inRepository((dir, run) =>
        Effect.gen(function* () {
          const write = yield* run({ command: "mkdir -p src && echo hello > src/a.txt && cat src/a.txt" })
          expect(write.text).toContain("hello")
          expect(write.exit).toBe(0)
          const commit = yield* run({
            command:
              "git add -A && git -c user.email=t@example.com -c user.name=t commit -q -m work && git branch -q topic && git log --oneline | wc -l",
          })
          expect(commit.exit).toBe(0)
          expect(commit.text).toMatch(/\b2\b/)
          expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "src", "a.txt"), "utf8"))).toBe("hello\n")
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "blocks git config and hooks, and keeps .git in place",
    () =>
      inRepository((dir, run) =>
        Effect.gen(function* () {
          const before = yield* Effect.promise(() => fs.readFile(path.join(dir, ".git", "config"), "utf8"))
          const config = yield* run({ command: "printf '[core]\\n\\tfsmonitor = touch /tmp/pwned\\n' >> .git/config" })
          expect(config.exit).not.toBe(0)
          expect(config.text).toMatch(DENIED)
          expect(yield* Effect.promise(() => fs.readFile(path.join(dir, ".git", "config"), "utf8"))).toBe(before)

          const hook = yield* run({ command: "mkdir -p .git/hooks; printf 'echo pwned' > .git/hooks/pre-commit" })
          expect(hook.exit).not.toBe(0)
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, ".git", "hooks", "pre-commit")).exists())).toBe(false)

          const moved = yield* run({ command: "mv .git .git-moved" })
          expect(moved.exit).not.toBe(0)
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, ".git-moved", "config")).exists())).toBe(false)
          // The model is told why and how to retry.
          expect(config.text).toContain("OS sandbox")
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "blocks Kete Code configuration, and leaves no placeholder behind",
    () =>
      inRepository((dir, run) =>
        Effect.gen(function* () {
          const file = yield* run({ command: `echo '{"permissions":[]}' > kete.jsonc` })
          expect(file.exit).not.toBe(0)
          const directory = yield* run({ command: "mkdir -p .kete && echo '{}' > .kete/kete.jsonc" })
          expect(directory.exit).not.toBe(0)
          const claude = yield* run({ command: "mkdir -p .claude/agents && echo x > .claude/agents/a.md" })
          expect(claude.exit).not.toBe(0)
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, "kete.jsonc")).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, ".kete", "kete.jsonc")).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, ".claude", "agents", "a.md")).exists())).toBe(false)
          // Linux placeholders are removed after the command.
          const left = yield* Effect.promise(() => fs.readdir(dir))
          expect(left.filter((name) => ["kete.json", "kete.jsonc", ".kete", ".claude", ".agents"].includes(name))).toEqual([])
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "can't read credentials or write outside the workspace",
    () =>
      inRepository((_dir, run) =>
        Effect.gen(function* () {
          const home = Global.Path.home
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(home, ".ssh"), { recursive: true })
            await fs.writeFile(path.join(home, ".ssh", "id_sandbox_test"), "PRIVATE-KEY-MATERIAL\n")
            await fs.writeFile(path.join(home, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n")
          })
          const read = yield* run({ command: `cat "${home}/.ssh/id_sandbox_test"` })
          expect(read.exit).not.toBe(0)
          expect(read.text).not.toContain("PRIVATE-KEY-MATERIAL")
          const hosts = yield* run({ command: `cat "${home}/.ssh/known_hosts"` })
          expect(hosts.text).toContain("github.com")

          // The isolated test home sits in macOS's per-user temp directory, which the sandbox may write.
          const outside = path.join(process.platform === "darwin" ? "/Users/Shared" : home, `outside-${Date.now()}.txt`)
          const write = yield* run({ command: `echo x > "${outside}"` })
          expect(write.exit).not.toBe(0)
          expect(yield* Effect.promise(() => Bun.file(outside).exists())).toBe(false)
        }),
      ),
    { timeout: 30_000 },
  )

  // Linux: the sandbox has its own network namespace, so even this machine's loopback is out of reach.
  if (process.platform === "linux")
    it.live(
      "has no network unless asked for, then has it (Linux: not even the host's loopback)",
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("pong") })),
          (server) =>
            inRepository((_dir, run) =>
              Effect.gen(function* () {
                const url = `http://127.0.0.1:${server.port}/`
                const blocked = yield* run({ command: `curl -sS -m 5 ${url}` })
                expect(blocked.text).not.toContain("pong")
                expect(blocked.exit).not.toBe(0)
                const allowed = yield* run({ command: `curl -sS -m 5 ${url}`, sandbox: "network" })
                expect(allowed.text).toContain("pong")
              }),
            ),
          (server) => Effect.promise(() => server.stop(true)),
        ),
      { timeout: 30_000 },
    )

  // macOS: this machine (loopback and its own addresses) stays reachable; anything else is refused
  // at once with EPERM. 192.0.2.1 is a documentation address: with network it just times out.
  if (process.platform === "darwin")
    it.live(
      "has no network unless asked for, then has it (macOS: other hosts refused)",
      () =>
        inRepository((_dir, run) =>
          Effect.gen(function* () {
            const connect = `python3 -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('192.0.2.1', 80))"`
            const blocked = yield* run({ command: connect })
            expect(blocked.exit).not.toBe(0)
            expect(blocked.text).toMatch(/operation not permitted/i)
            const allowed = yield* run({ command: connect, sandbox: "network" })
            expect(allowed.text).not.toMatch(/operation not permitted/i)
          }),
        ),
      { timeout: 30_000 },
    )

  it.live(
    'sandbox: "off" runs the command outside the sandbox',
    () =>
      inRepository((dir, run) =>
        Effect.gen(function* () {
          const result = yield* run({ command: "printf '# outside\\n' >> .git/config", sandbox: "off" })
          expect(result.exit).toBe(0)
          expect(result.text).toContain("outside the OS sandbox")
          expect(yield* Effect.promise(() => fs.readFile(path.join(dir, ".git", "config"), "utf8"))).toContain("# outside")
        }),
      ),
    { timeout: 30_000 },
  )
})
