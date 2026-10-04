// AC5 end to end: `kete` in job mode running a shell-tool command through the *real* root helper
// binary (packages/kete-root-helper), not a fake — the command's process actually runs as the
// fixed tool uid/gid. Gated on HELPER_E2E_SOCKET rather than a KETE_*-prefixed name because
// script/kete/isolated-test.ts (which every `bun run test` invocation in this package goes
// through) strips every KETE_* variable before the test process even starts. scripts/e2e.sh sets
// HELPER_E2E_SOCKET, HELPER_E2E_ROOT, HELPER_E2E_TOOL_UID and HELPER_E2E_TOOL_GID after starting the real helper (via
// sudo) with a worktree root and tool user of its own; this test never starts the helper itself.
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { App } from "@opencode/core/app"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ModelsDev } from "@opencode/core/models-dev"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Effect, Context, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../../ai/src"
import { OpenAIChat } from "../../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../../ai/src/testing"
import { initRepo } from "../../../core/test/fixture/git"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { KeteJobServer } from "../../src/kete/job-server"
import type { ServerOptions } from "../../src/options"
import { createEmbeddedRoutes } from "../../src/routes"

const socket = process.env.HELPER_E2E_SOCKET
const root = process.env.HELPER_E2E_ROOT
const toolUID = process.env.HELPER_E2E_TOOL_UID
const toolGID = process.env.HELPER_E2E_TOOL_GID

// A real job's policy allows the tools it needs: with no rule, "shell" is "ask", which an
// unattended run turns into "deny" — the command would never reach the helper.
const unattended = { version: 1 as const, budget: 100, timeout: 30, allow: [{ action: "shell", resource: "*" }] }

const gated = socket && root && toolUID && toolGID ? it.live : it.live.skip

gated(
  "AC5: a shell tool call runs as the tool uid through the real root helper",
  () =>
    Effect.gen(function* () {
      // The repo directory must be beneath the helper's --worktree-root (HELPER_E2E_ROOT) and
      // writable by the tool user, since the tool user — not this test process — creates uid.txt.
      const repoDir = yield* Effect.promise(async () => {
        const dir = path.join(root!, `job-helper-e2e-${Date.now()}`)
        await fs.mkdir(dir, { recursive: true })
        await initRepo(dir)
        await fs.chmod(dir, 0o777)
        return dir
      })

      const tmp = yield* tmpdirScoped()
      const data = path.join(tmp.path, "data")

      const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
      yield* llm.always(TestLLM.text("(untitled)", "fallback"))
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "job-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 8_192 },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(0),
              output: Money.USDPerMillionTokens.make(0),
              cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
            },
          ],
        },
      )

      const serverOptions: ServerOptions = {}
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
        ...KeteJobServer.replacements(serverOptions, { kind: "on" }, { OPENCODE_JOB_TOOL_SOCKET: socket! }, () =>
          KeteConfinedFs.open(repoDir, KeteLinuxFfi.linux()),
        ),
      ]
      const context = yield* Layer.build(
        createEmbeddedRoutes(serverOptions, replacements).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const webHandler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
      const fetchFn = (async (request: RequestInfo | URL, init?: RequestInit) =>
        webHandler(request instanceof Request ? request : new Request(request, init))) as typeof fetch

      const { OpenCode } = yield* Effect.promise(() => import("@opencode/client/promise"))
      const client = OpenCode.make({ baseUrl: "http://kete.local", fetch: fetchFn })

      yield* llm.push(
        TestLLM.tool("call-shell", "shell", { command: "id -u > uid.txt; id -G >> uid.txt" }),
        TestLLM.text("done", "step-1"),
      )
      const session = yield* Effect.promise(() =>
        // An explicit title, like `kete job run` sets: without one, automatic title generation
        // consumes the first scripted model response (the shell tool call).
        client.session.create({ location: { directory: repoDir }, title: "AC5", metadata: { "kete.unattended": unattended } }),
      )
      yield* Effect.promise(() =>
        client.session.prompt({
          sessionID: session.id,
          id: SessionMessage.ID.create(),
          text: "id -u > uid.txt; id -G >> uid.txt",
          delivery: "steer",
        }),
      )
      yield* Effect.promise(() => client.session.wait({ sessionID: session.id }))

      const uidFile = path.join(repoDir, "uid.txt")
      const content = yield* Effect.promise(async () => {
        try {
          return await fs.readFile(uidFile, "utf8")
        } catch (error) {
          // Say why: the session's messages show whether the shell call was denied, refused by the
          // runner, or failed inside the tool user's process.
          const messages = await client.message.list({ sessionID: session.id }).catch((e: unknown) => e)
          throw new Error(`uid.txt was not created; session messages:\n${JSON.stringify(messages, null, 2).slice(0, 8000)}`, {
            cause: error,
          })
        }
      })
      const [reportedUID, reportedGroups] = content.trim().split("\n")
      expect(reportedUID).toBe(toolUID!)
      // `id -G` lists every group the process belongs to; the tool user has no supplementary
      // groups, so this must be exactly its own gid (module README AC1: "no supplementary
      // groups"). Its gid needn't equal its uid.
      expect(reportedGroups?.trim().split(/\s+/)).toEqual([toolGID!])

      const stat = yield* Effect.promise(() => fs.stat(uidFile))
      expect(String(stat.uid)).toBe(toolUID!)
    }),
)
