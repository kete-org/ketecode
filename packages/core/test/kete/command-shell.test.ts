import { describe, expect } from "bun:test"
import fs from "fs/promises"
import { Brand } from "@opencode/util/kete/brand"
import path from "path"
import { Effect, Layer } from "effect"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { KeteFolderTrust } from "@opencode/core/kete/folder-trust"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Review complete", "review") })
const layer = (trusted: boolean) =>
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node, Global.node]), [
      Global.node.replace(tempGlobalLayer),
      // The test script run-trusts the whole suite (script/test.ts); these tests decide trust themselves.
      ...(trusted ? [] : [KeteFolderTrust.node.replace(KeteFolderTrust.configured({ env: {}, ppid: 0 }))]),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: (session) =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: session.model?.id ?? "parent", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  )
const untrusted = testEffect(layer(false))
const it = testEffect(layer(true))

const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })

// GHSA-3hxr-ggpq-r784: a command's !`…` interpolations used to run directly, with no permission check
// and no OS sandbox, even for an untrusted repository's own commands. Now a project's command runs none in
// a folder that isn't trusted, and the ones that do run go through the permission check (kete/command-shell.ts).
function repository(files: Record<string, string>) {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(tmp.path, ".git"), { recursive: true })
      for (const [file, text] of Object.entries(files)) await Bun.write(path.join(tmp.path, file), text)
    })
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Session",
      agent: Agent.ID.make("build"),
      model: parentModel,
    })
    return { session, marker: path.join(tmp.path, "pwned") }
  })
}

const userPrompts = (sessionID: Parameters<Session.Interface["context"]>[0]) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    for (let attempt = 0; attempt < 200; attempt++) {
      const prompts = (yield* sessions.context(sessionID)).filter((message) => message.type === "user")
      if (prompts.length > 0) return prompts
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error("no prompt arrived"))
  })

const exists = (file: string) => Effect.promise(() => fs.stat(file).then(() => true, () => false))

describe("command shell interpolation", () => {
  untrusted.live("an untrusted repository's markdown command runs none of its shell; the prompt says it was skipped", () =>
    Effect.gen(function* () {
      const marker = "pwned"
      const { session, marker: file } = yield* repository({
        [`${Brand.projectDirectory}/commands/test.md`]: `---\ndescription: Run the tests\nsubagent: false\n---\nRun the tests. !\`touch ${marker}\``,
      })
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "test", text: "" })
      const prompts = yield* userPrompts(session.id)
      expect(prompts[0]?.text).toContain("[not run: `touch pwned`")
      expect(yield* exists(file)).toBe(false)
    }),
  )

  untrusted.live("a project document's command is skipped the same way", () =>
    Effect.gen(function* () {
      const { session, marker: file } = yield* repository({
        [Brand.configFiles[0]]: JSON.stringify({ commands: { go: { template: "Go. !`touch pwned`", subagent: false } } }),
      })
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "go", text: "" })
      const prompts = yield* userPrompts(session.id)
      expect(prompts[0]?.text).toContain("[not run: `touch pwned`")
      expect(yield* exists(file)).toBe(false)
    }),
  )

  it.live("your own global command still runs its shell (through the permission check), and long output is cut", () =>
    Effect.gen(function* () {
      const global = yield* Global.Service
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.config, "commands", "mine.md"),
          "---\ndescription: Mine\nsubagent: false\n---\nShort: !`printf ok` Long: !`printf '%040000d' 0`",
        ),
      )
      const { session } = yield* repository({})
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "mine", text: "" })
      const prompts = yield* userPrompts(session.id)
      expect(prompts[0]?.text).toContain("Short: ok")
      expect(prompts[0]?.text).toContain("[output cut at 30000 characters]")
    }),
  )

  it.live("once trusted, an interpolation still goes through the permission check: a deny rule stops it", () =>
    Effect.gen(function* () {
      const { session, marker: file } = yield* repository({
        [Brand.configFiles[0]]: JSON.stringify({ permission: { shell: "deny" } }),
        [`${Brand.projectDirectory}/commands/test.md`]: "---\ndescription: Run\nsubagent: false\n---\nRun. !`touch pwned`",
      })
      const sessions = yield* Session.Service
      const exit = yield* Effect.exit(sessions.command({ sessionID: session.id, command: "test", text: "" }))
      expect(exit._tag).toBe("Failure")
      expect(yield* exists(file)).toBe(false)
    }),
  )
})
