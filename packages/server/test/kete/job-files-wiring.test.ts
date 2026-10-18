// Piece A3 wiring: job mode's replacement list confines kete's in-process working-tree access
// (Environment driver, FSUtil wrapper, ripgrep-backed file search), refuses to start when the
// working tree can't be opened with openat2 (AC2), and — on Linux, with the real syscalls — an
// embedded server's read tool refuses a planted symlink while an ordinary write works (AC1).
import fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { App } from "@opencode/core/app"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Environment } from "@opencode/core/environment/index"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ModelsDev } from "@opencode/core/models-dev"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { SessionMessage } from "@opencode/schema/session-message"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../../ai/src"
import { OpenAIChat } from "../../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../../ai/src/testing"
import { initRepo } from "../../../core/test/fixture/git"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { makeFake } from "../../../util/test/kete/fixture/fake-syscalls"
import { KeteJobServer } from "../../src/kete/job-server"
import type { ServerOptions } from "../../src/options"
import { createEmbeddedRoutes } from "../../src/routes"
import { fakeConfine } from "./fake-confine"

/** The node a replacement replaces (the replacement's one symbol-keyed field holds `{source}`). */
const sourceName = (replacement: LayerNode.Replacement) => {
  const symbol = Object.getOwnPropertySymbols(replacement)[0]!
  return (replacement as unknown as Record<symbol, { source: { name: string } }>)[symbol]!.source.name
}

describe("replacement list", () => {
  test("includes the Environment, FSUtil and FileSystemSearch replacements, rooted at cwd", () => {
    let opened: string | undefined
    const list = KeteJobServer.replacements({}, { kind: "on" }, {}, (root) => {
      opened = root
      return fakeConfine(process.cwd())(root)
    })
    expect(opened).toBe(process.cwd())
    const names = list.map(sourceName)
    expect(names).toContain(Environment.node.name)
    expect(names).toContain(FSUtil.node.name)
    expect(names).toContain(FileSystemSearch.node.name)
    expect(list.length).toBe(11)
    expect(KeteJobServer.replacements({}, { kind: "off" }, {}, () => {
      throw new Error("never called when job mode is off")
    })).toEqual([])
  })

  test("refuses to start when openat2 is unavailable (ENOSYS) or the host isn't Linux (AC2)", () => {
    const real = realpathSync(process.cwd())
    expect(() =>
      KeteJobServer.replacements({}, { kind: "on" }, {}, () =>
        KeteConfinedFs.open(real, makeFake({ rootPath: real, enosys: true }).sys, "linux"),
      ),
    ).toThrow(/openat2 unavailable: ENOSYS\); refusing to start/)
    if (process.platform !== "linux")
      expect(() => KeteJobServer.replacements({}, { kind: "on" }, {})).toThrow(/can't confine its file access/)
  })
})

const unattended = { version: 1 as const, budget: 100, timeout: 30 }

const linux = process.platform === "linux"

const server = Effect.fn(function* (repoDir: string, data: string, tmp: string) {
  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
  yield* llm.always(TestLLM.text("(untitled)", "fallback"))
  const model = SessionRunnerModel.resolved(LanguageModel.make({ id: "job-model", provider: "test", route: OpenAIChat.route }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 8_192 },
    cost: [
      {
        input: Money.USDPerMillionTokens.make(0),
        output: Money.USDPerMillionTokens.make(0),
        cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
      },
    ],
  })
  const serverOptions: ServerOptions = {}
  const replacements: LayerNode.Replacements = [
    Global.node.replace(
      Global.layerWith({
        data,
        cache: path.join(tmp, "cache"),
        config: path.join(tmp, "config"),
        state: path.join(tmp, "state"),
        tmp: path.join(tmp, "tmp"),
        bin: path.join(tmp, "cache", "bin"),
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
    ...KeteJobServer.replacements(serverOptions, { kind: "on" }, {}, () => KeteConfinedFs.open(repoDir, KeteLinuxFfi.linux())),
  ]
  const context = yield* Layer.build(createEmbeddedRoutes(serverOptions, replacements).pipe(Layer.provide(HttpServer.layerServices)))
  const webHandler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
  const fetchFn = (async (request: RequestInfo | URL, init?: RequestInit) =>
    webHandler(request instanceof Request ? request : new Request(request, init))) as typeof fetch
  const { OpenCode } = yield* Effect.promise(() => import("@opencode/client/promise"))
  return { client: OpenCode.make({ baseUrl: "http://kete.local", fetch: fetchFn }), llm }
})

if (linux)
  it.live("(Linux) the read tool refuses a planted symlink; an ordinary write works", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const base = realpathSync(tmp.path)
      const repoDir = path.join(base, "repo")
      const secret = path.join(base, "secret.txt")
      yield* Effect.promise(async () => {
        await fs.mkdir(repoDir)
        await initRepo(repoDir)
        await fs.writeFile(secret, "TOP-SECRET-CONTENT")
        await fs.symlink(secret, path.join(repoDir, "leak.txt"))
        await fs.writeFile(path.join(repoDir, "README.md"), "hello\n")
      })
      const s = yield* server(repoDir, path.join(base, "data"), base)
      yield* s.llm.push(
        TestLLM.tool("call-read", "read", { path: path.join(repoDir, "leak.txt") }),
        TestLLM.tool("call-write", "write", { path: path.join(repoDir, "written.txt"), content: "ok\n" }),
        TestLLM.tool("call-read-ok", "read", { path: path.join(repoDir, "README.md") }),
        TestLLM.text("done", "step-1"),
      )
      const session = yield* Effect.promise(() =>
        s.client.session.create({
          location: { directory: repoDir },
          title: "confinement",
          metadata: {
            "kete.unattended": { ...unattended, allow: [{ action: "read", resource: "*" }, { action: "edit", resource: "*" }] },
          },
        }),
      )
      yield* Effect.promise(() =>
        s.client.session.prompt({ sessionID: session.id, id: SessionMessage.ID.create(), text: "read and write", delivery: "steer" }),
      )
      yield* Effect.promise(() => s.client.session.wait({ sessionID: session.id }).catch(() => undefined))
      const messages = JSON.stringify(yield* Effect.promise(() => s.client.message.list({ sessionID: session.id })))
      expect(messages).not.toContain("TOP-SECRET-CONTENT")
      expect(messages).toContain("Unable to read")
      expect(messages).toContain("hello")
      expect(yield* Effect.promise(() => fs.readFile(path.join(repoDir, "written.txt"), "utf8"))).toBe("ok\n")
    }),
  )
