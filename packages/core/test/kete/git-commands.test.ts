import { describe, expect, test } from "bun:test"
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
import { KeteGitCommands } from "@opencode/core/kete/git-commands"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Review complete", "review") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node]), [
      Global.node.replace(tempGlobalLayer),
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
  ),
)

const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })

// /commit and /pr (kete/git-commands.ts): plain prompts, and a config command of the same name wins.
function repository(files: Record<string, string>) {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(tmp.path, ".git"), { recursive: true })
      for (const [file, text] of Object.entries(files)) await Bun.write(path.join(tmp.path, file), text)
    })
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Session",
      agent: Agent.ID.make("build"),
      model: parentModel,
    })
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

describe("/commit and /pr", () => {
  test("the templates never run shell themselves: the agent's commands go through permissions", () => {
    for (const template of [KeteGitCommands.COMMIT, KeteGitCommands.PR]) expect(/!`[^`]+`/.test(template)).toBe(false)
  })

  test("the templates keep the safety rules", () => {
    expect(KeteGitCommands.COMMIT).toContain("Never use `git add -A`")
    expect(KeteGitCommands.COMMIT).toContain("Don't push.")
    expect(KeteGitCommands.COMMIT).toContain("Don't use `--no-verify` or `--amend`")
    expect(KeteGitCommands.COMMIT).toContain("default branch")
    expect(KeteGitCommands.PR).toContain("Never force-push.")
    expect(KeteGitCommands.PR).toContain("Don't merge, approve, or request reviewers")
    expect(KeteGitCommands.PR).toContain("don't install anything")
    // Messages never go through a quoted shell argument; the base is the remote's, freshly fetched.
    expect(KeteGitCommands.COMMIT).toContain("git commit -F <file>")
    expect(KeteGitCommands.COMMIT).toContain("Never put the message in")
    expect(KeteGitCommands.COMMIT).toContain("don't print or quote their contents")
    expect(KeteGitCommands.COMMIT).toContain("HEAD is detached")
    expect(KeteGitCommands.PR).toContain("git fetch <remote> <base>")
    expect(KeteGitCommands.PR).toContain("system temp directory (outside the repository")
    expect(KeteGitCommands.PR).toContain("already exists")
  })

  test("render fills the path and the person's notes as written", () => {
    const text = KeteGitCommands.render("In ${path}: $ARGUMENTS / $ARGUMENTS", "/work/$&repo", " fix $& the $1 typo ")
    expect(text).toBe("In /work/$&repo: fix $& the $1 typo / fix $& the $1 typo")
    expect(KeteGitCommands.render("Notes: $ARGUMENTS", "/x", "  ")).toBe("Notes: (none)")
    // One pass: a path that contains the placeholder text isn't filled in again.
    expect(KeteGitCommands.render("${path} | $ARGUMENTS", "/a/$ARGUMENTS", "n")).toBe("/a/$ARGUMENTS | n")
    for (const template of [KeteGitCommands.COMMIT, KeteGitCommands.PR]) {
      const text = KeteGitCommands.render(template, "/x", "y")
      expect(text).not.toContain("$ARGUMENTS")
      expect(text).not.toContain("${path}")
    }
  })

  it.live("/commit sends the commit prompt with the person's notes", () =>
    Effect.gen(function* () {
      const session = yield* repository({})
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "commit", text: "the login typo" })
      const prompts = yield* userPrompts(session.id)
      expect(prompts[0]?.text).toContain("Create a git commit for the current changes in")
      expect(prompts[0]?.text).toContain("Notes from the person (optional): the login typo")
    }),
  )

  it.live("/pr sends the pull request prompt", () =>
    Effect.gen(function* () {
      const session = yield* repository({})
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "pr", text: "main draft" })
      const prompts = yield* userPrompts(session.id)
      expect(prompts[0]?.text).toContain("Open a pull request")
      expect(prompts[0]?.text).toContain("What the person wrote (optional): main draft")
    }),
  )

  it.live("a commit command in the config replaces the built-in one", () =>
    Effect.gen(function* () {
      const session = yield* repository({
        [`${Brand.projectDirectory}/commands/commit.md`]: "---\ndescription: Our commit\nsubagent: false\n---\nOur own commit flow. $ARGUMENTS",
      })
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "commit", text: "x" })
      const prompts = yield* userPrompts(session.id)
      expect(prompts[0]?.text).toContain("Our own commit flow. x")
      expect(prompts[0]?.text).not.toContain("Create a git commit")
    }),
  )
})
