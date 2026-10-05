// End-to-end AC2-AC6: `kete job run` against a real embedded server (routes, database, permission
// and unattended plugins) with a fake model (`TestLLM`), imported directly from the CLI's
// job-run.ts (see that file's header for why the cross-package import works without a `references`
// entry in tsconfig.json — plain relative imports don't need one; only `tsgo -b`'s own project
// DAG does).
import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { expect } from "bun:test"
import { App } from "@opencode/core/app"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ModelsDev } from "@opencode/core/models-dev"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient, LLMEvent } from "../../../ai/src"
import { OpenAIChat } from "../../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../../ai/src/testing"
import { initRepo } from "../../../core/test/fixture/git"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { JobGit } from "../../../cli/src/kete/job-git"
import { JobRun } from "../../../cli/src/kete/job-run"
import { KeteJobProjectConfig } from "../../../cli/src/kete/job-project-config"
import { createEmbeddedRoutes } from "../../src/routes"

const setup = Effect.fn(function* () {
  const tmp = yield* tmpdirScoped()
  const data = path.join(tmp.path, "data")
  const repoDir = path.join(tmp.path, "repo")
  yield* Effect.promise(async () => {
    await fs.mkdir(repoDir, { recursive: true })
    await initRepo(repoDir)
  })

  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
  // A session can make incidental model calls beyond the ones a test pushes for (e.g. a title
  // summary); answer those with a short, cheap default so a test's own queued responses stay
  // reserved for the steps it's actually asserting on.
  yield* llm.always(TestLLM.text("(untitled)", "fallback"))
  const model = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "job-model", provider: "test", route: OpenAIChat.route }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 200_000, output: 8_192 },
      // Absurdly expensive on purpose: a handful of tokens must be enough to exceed a tiny budget.
      cost: [
        {
          input: Money.USDPerMillionTokens.make(100_000_000),
          output: Money.USDPerMillionTokens.make(100_000_000),
          cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
        },
      ],
    },
  )
  const replacements: LayerNode.Replacements = [
    Global.node.replace(
      Global.layerWith({
        data,
        cache: path.join(tmp.path, "cache"),
        config: path.join(tmp.path, "config"),
        state: path.join(tmp.path, "state"),
        tmp: path.join(tmp.path, "tmp"),
        bin: path.join(tmp.path, "cache", "bin"),
        log: path.join(data, "log"),
        repos: path.join(data, "repos"),
      }),
    ),
    Database.node.replace(Database.node),
    Bus.node.replace(Bus.node),
    App.node.replace(App.node),
    ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
    Watcher.node.replace(Watcher.configured({ enabled: false })),
    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
    SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) })),
  ]
  const context = yield* Layer.build(
    createEmbeddedRoutes(
      { config: { content: JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }) } },
      replacements,
    ).pipe(Layer.provide(HttpServer.layerServices)),
  )
  const webHandler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))

  let requestCount = 0
  const countedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestCount++
    const request = input instanceof Request ? input : new Request(input, init)
    return webHandler(request)
  }) as typeof fetch

  const { OpenCode } = yield* Effect.promise(() => import("@opencode/client/promise"))
  const client = OpenCode.make({ baseUrl: "http://kete.local", fetch: countedFetch })

  const runDeps: JobRun.Deps = {
    client,
    git: JobGit,
    readFile: (file) => fs.readFile(file, "utf8"),
    stat: (file) => fs.stat(file),
    exists: (file) =>
      fs
        .access(file)
        .then(() => true)
        .catch(() => false),
    realpath: (file) => fs.realpath(file),
    dataDir: data,
    auditDir: path.join(data, "audit"),
    auditPollTimeoutMs: 3_000,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: () => {},
    stderr: () => {},
    onInterrupt: () => () => {},
    randomId: () => crypto.randomUUID(),
    attached: false,
    inspectProjectConfig: (directory, stop) => KeteJobProjectConfig.inspect(directory, stop),
  }

  return { client, llm, repoDir, data, runDeps, requests: () => requestCount }
})

const validPolicy = { version: 1 as const, budget: 5, timeout: 5 }

it.live("AC2: creates a worktree and branch, no POST /api/worktree call", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.llm.push(TestLLM.text("done", "step-1"))

    const spec: JobRun.Spec = { version: 1, prompt: "say done", policy: validPolicy }
    const before = s.requests()
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: s.repoDir, json: false }, s.runDeps),
    )
    expect(exitCode).toBe(0)
    expect(result.isolated).toBe(true)
    expect(result.worktree).toBeDefined()
    expect(result.worktree).toContain(path.join(s.data, "worktree"))
    expect(result.branch).toMatch(/^kete\/job\//)

    const branchInWorktree = yield* Effect.promise(() => $`git -C ${result.worktree!} branch --show-current`.text())
    expect(branchInWorktree.trim()).toBe(result.branch!)
    const headInRepo = yield* Effect.promise(() => $`git -C ${s.repoDir} rev-parse HEAD`.text())
    const headInWorktree = yield* Effect.promise(() => $`git -C ${result.worktree!} rev-parse HEAD`.text())
    expect(headInWorktree.trim()).toBe(headInRepo.trim())

    // No worktree endpoint request among the requests this run made: every request went through
    // /api/location, /api/session, /api/event, /api/session/.../prompt, /api/experimental/session/.../wait.
    expect(s.requests()).toBeGreaterThan(before)
  }),
)

it.live("AC3 + AC5: completes a run that writes a file, only in the worktree — the checkout untouched", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.llm.push(
      TestLLM.tool("call-write", "write", { path: "hello.txt", content: "hi" }),
      TestLLM.text("done", "step-2"),
    )

    const spec: JobRun.Spec = { version: 1, prompt: "write hello.txt", policy: validPolicy }
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: s.repoDir, json: false }, s.runDeps),
    )
    expect(exitCode).toBe(0)
    expect(result.outcome).toBe("completed")
    expect(result.text).toBe("done")

    const writtenInWorktree = yield* Effect.promise(() =>
      fs
        .access(path.join(result.worktree!, "hello.txt"))
        .then(() => true)
        .catch(() => false),
    )
    expect(writtenInWorktree).toBe(true)
    const writtenInRepo = yield* Effect.promise(() =>
      fs
        .access(path.join(s.repoDir, "hello.txt"))
        .then(() => true)
        .catch(() => false),
    )
    expect(writtenInRepo).toBe(false)
    const repoStatus = yield* Effect.promise(() => $`git -C ${s.repoDir} status --porcelain`.text())
    expect(repoStatus.trim()).toBe("")
  }),
)

it.live("AC4 + AC6: a write to .kete/kete.jsonc is denied even with a matching allow rule; the run still completes", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.llm.push(
      TestLLM.tool("call-write", "write", { path: ".kete/kete.jsonc", content: "{}" }),
      TestLLM.text("done", "step-3"),
    )

    const spec: JobRun.Spec = {
      version: 1,
      prompt: "write .kete/kete.jsonc",
      policy: { version: 1, budget: 5, timeout: 5, allow: [{ action: "edit", resource: "*" }] },
    }
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: s.repoDir, json: false }, s.runDeps),
    )
    expect(exitCode).toBe(0)
    expect(result.outcome).toBe("completed")
    expect(result.denied).toHaveLength(1)
    expect(result.denied[0]?.action).toBe("edit")
    expect(result.denied[0]?.message).toContain("Kete configuration")

    const written = yield* Effect.promise(() =>
      fs
        .access(path.join(result.worktree!, ".kete", "kete.jsonc"))
        .then(() => true)
        .catch(() => false),
    )
    expect(written).toBe(false)
  }),
)

it.live("AC4: the time limit stops a hanging run", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.llm.push(TestLLM.hangAfter())

    const spec: JobRun.Spec = { version: 1, prompt: "hang", policy: { version: 1, budget: 5, timeout: 0.01 } }
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: s.repoDir, json: false }, s.runDeps),
    )
    expect(exitCode).toBe(3)
    expect(result.outcome).toBe("time_limit")
  }),
)

it.live("AC4: the budget stops a run whose first step already exceeds it", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    // Real usage this time (unlike the other tests' TestLLM.tool/text, whose 0-token responses
    // never accrue any cost): at $100/token (see setup's cost table) a handful of tokens is
    // already well over this test's budget.
    yield* s.llm.push(
      TestLLM.complete(
        { reason: { normalized: "tool-calls" }, usage: { inputTokens: 10, outputTokens: 10, nonCachedInputTokens: 10 } },
        LLMEvent.toolCall({ id: "call-1", name: "write", input: { path: "a.txt", content: "x" } }),
      ),
    )
    yield* s.llm.push(TestLLM.text("more", "step-b"))

    const spec: JobRun.Spec = { version: 1, prompt: "spend a lot", policy: { version: 1, budget: 0.0001, timeout: 5 } }
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: s.repoDir, json: false }, s.runDeps),
    )
    expect(exitCode).toBe(4)
    expect(result.outcome).toBe("budget")
  }),
)

it.live("not a git repository: runs in place, isolated: false", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    const plain = path.join(s.data, "..", "not-a-repo")
    yield* Effect.promise(() => fs.mkdir(plain, { recursive: true }))
    yield* s.llm.push(TestLLM.text("done", "step-plain"))

    const spec: JobRun.Spec = { version: 1, prompt: "say done", policy: validPolicy }
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: plain, json: false }, s.runDeps),
    )
    expect(exitCode).toBe(0)
    expect(result.isolated).toBe(false)
    expect(result.worktree).toBeUndefined()
    expect(result.directory).toBe(plain)
  }),
)

/** Job mode (a cloud job): the entrypoint already prepared cwd as the worktree; `kete` runs no git. */
const throwingGit: JobRun.Git = {
  run: async () => {
    throw new Error("git must not run in job mode")
  },
  worktreeAdd: async () => {
    throw new Error("git worktree add must not run in job mode")
  },
  worktreeDiscard: async () => {
    throw new Error("git worktree remove must not run in job mode")
  },
}

it.live("job mode: runs in the prepared worktree (cwd) with no git call; writes land there", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.llm.push(
      TestLLM.tool("call-write", "write", { path: "hello.txt", content: "hi" }),
      TestLLM.text("done", "step-job-mode"),
    )

    const spec: JobRun.Spec = { version: 1, prompt: "write hello.txt", policy: validPolicy, branch: "kete/job/prepared" }
    const { exitCode, result } = yield* Effect.promise(() =>
      JobRun.run({ spec, cwd: s.repoDir, json: false, jobMode: true }, { ...s.runDeps, git: throwingGit }),
    )
    expect(exitCode).toBe(0)
    expect(result.outcome).toBe("completed")
    expect(result.isolated).toBe(true)
    expect(result.worktree).toBe(s.repoDir)
    expect(result.branch).toBe("kete/job/prepared")
    expect(result.directory).toBe(s.repoDir)

    const written = yield* Effect.promise(() => fs.readFile(path.join(s.repoDir, "hello.txt"), "utf8"))
    expect(written).toBe("hi")
    const worktrees = yield* Effect.promise(() =>
      fs
        .access(path.join(s.data, "worktree"))
        .then(() => true)
        .catch(() => false),
    )
    expect(worktrees).toBe(false)
  }),
)

it.live("job mode: refused without spec.branch or without .git, before any session", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    const before = s.requests()
    const noBranch = yield* Effect.promise(() =>
      JobRun.run(
        { spec: { version: 1, prompt: "x", policy: validPolicy }, cwd: s.repoDir, json: false, jobMode: true },
        { ...s.runDeps, git: throwingGit },
      ),
    )
    expect(noBranch.exitCode).toBe(2)
    expect(noBranch.result.message).toContain("spec.branch")

    const plain = path.join(s.data, "..", "not-a-repo")
    yield* Effect.promise(() => fs.mkdir(plain, { recursive: true }))
    const noGitDir = yield* Effect.promise(() =>
      JobRun.run(
        { spec: { version: 1, prompt: "x", policy: validPolicy, branch: "kete/job/x" }, cwd: plain, json: false, jobMode: true },
        { ...s.runDeps, git: throwingGit },
      ),
    )
    expect(noGitDir.exitCode).toBe(2)
    expect(noGitDir.result.message).toContain("no .git")
    expect(s.requests()).toBe(before)
  }),
)
