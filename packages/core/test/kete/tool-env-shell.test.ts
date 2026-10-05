// AC1–AC3 (task 2026-10-05-unattended-secret-hygiene) against the real shell tool: a command the
// agent runs prints its environment, and the output (what the model would see) is checked. The
// session environment stands in for the runtime's own (`Shell.create` uses it instead of
// `process.env` when set), so the test never touches the developer's real variables.
import { Brand } from "@opencode/util/kete/brand"
import path from "path"
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
import { tmpdir } from "../fixture/tmpdir"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "../lib/tool"

const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("ToolEnvTest.complete")(function* (id: Session.ID) {
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
  name: "test/tool-env-shell-plugins",
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

const isWindows = process.platform === "win32"
// Prints the environment one variable per line, on every platform.
const printEnv = isWindows ? "Get-ChildItem Env: | ForEach-Object { \"$($_.Name)=$($_.Value)\" }" : "env"

const secrets = {
  ANTHROPIC_API_KEY: "sk-ant-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  GITHUB_TOKEN: "ghp-secret",
  NPM_TOKEN: "npm-secret",
  OPENCODE_GATEWAY_KEY: "kete-gateway-secret",
  OPENCODE_SERVER_PASSWORD: "kete-server-secret",
  KETE_TOOL_ENV_PLAIN: "visible-plain",
}

/** Only what a shell needs to start, so the developer's own variables never reach the test. */
function baseEnvironment(): Record<string, string> {
  const names = ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR"]
  return Object.fromEntries(names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])))
}

const unattended = { "kete.unattended": { version: 1, budget: 5, timeout: 60_000 } }

/** Runs `env` through the shell tool in a fresh session and returns its output. */
const runEnv = (options: { readonly metadata?: Record<string, unknown>; readonly config?: unknown }) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        if (options.config !== undefined)
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, Brand.configFiles[0]), JSON.stringify(options.config)))
        const sessions = yield* Session.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
        const session = yield* sessions.create({
          title: "tool env test",
          location,
          model: sessionModel,
          ...(options.metadata ? { metadata: options.metadata as never } : {}),
        })
        yield* sessions.environment({ sessionID: session.id, variables: { ...baseEnvironment(), ...secrets } })
        const locations = yield* LocationServiceMap.Service
        return yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const registry = yield* Tool.Service
          const settled = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: { type: "tool-call" as const, id: "call-env", name: "shell", input: { command: printEnv } },
          })
          expect(settled.status).toBe("completed")
          const first = settled.content?.[0]
          return first && first.type === "text" ? first.text : ""
        }).pipe(Effect.provide(locations.get(location)), Effect.ensuring(locations.invalidate(location)))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

describe("KeteToolEnv through the shell tool", () => {
  it.live(
    "AC1: an unattended run's command sees neither provider keys nor Kete keys",
    () =>
      Effect.gen(function* () {
        const output = yield* runEnv({ metadata: unattended })
        expect(output).toContain("KETE_TOOL_ENV_PLAIN=visible-plain")
        for (const value of Object.values(secrets).filter((value) => value !== "visible-plain"))
          expect(output).not.toContain(value)
      }),
    { timeout: 20_000 },
  )

  it.live(
    "AC2: an interactive session keeps provider keys but never Kete's own credentials",
    () =>
      Effect.gen(function* () {
        const output = yield* runEnv({})
        expect(output).toContain("ANTHROPIC_API_KEY=sk-ant-secret")
        expect(output).toContain("GITHUB_TOKEN=ghp-secret")
        expect(output).not.toContain("kete-gateway-secret")
        expect(output).not.toContain("kete-server-secret")
      }),
    { timeout: 20_000 },
  )

  it.live(
    "AC3: kete.unattended.passEnv keeps a named variable, never a Kete credential",
    () =>
      Effect.gen(function* () {
        const output = yield* runEnv({
          metadata: unattended,
          config: { kete: { unattended: { passEnv: ["NPM_TOKEN", "OPENCODE_GATEWAY_KEY"] } } },
        })
        expect(output).toContain("NPM_TOKEN=npm-secret")
        expect(output).not.toContain("kete-gateway-secret")
        expect(output).not.toContain("sk-ant-secret")
      }),
    { timeout: 20_000 },
  )
})
