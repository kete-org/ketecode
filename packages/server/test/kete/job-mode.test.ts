// AC3/AC4 end to end: job mode wired into a real embedded server (KeteJobServer.replacements
// passed explicitly, not through process.env — see job-server.ts). (a) a shell tool call is
// refused and its marker file is never created; (b) a stdio MCP server the repo's config declares
// is never started (its marker file is never created); (c) the repo's kete.json and .kete/
// directory don't even reach config.entries(); (d) creating a PTY is refused; (f) the same project
// with job mode off is a control that proves the switch (config.entries() includes both).
//
// Not covered here (gap, see handoff.md): the formatter no-op and the plugin-directory-marker case
// from the plan's server e2e list — agent.list()/mcp.list()'s location-form endpoints returned
// empty regardless of job mode in this harness (no seeded models catalog), so those two checks use
// config.entries() instead, which is reliable and still proves D3 (config ignored, not narrowed).
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { expect } from "bun:test"
import { App } from "@opencode/core/app"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ModelsDev } from "@opencode/core/models-dev"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { KeteToolHelperProtocol as Protocol } from "@opencode/util/kete/tool-helper-protocol"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../../ai/src"
import { OpenAIChat } from "../../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../../ai/src/testing"
import { initRepo } from "../../../core/test/fixture/git"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { KeteJobServer } from "../../src/kete/job-server"
import type { KeteReview } from "@opencode/util/kete/review"
import { fakeConfine } from "./fake-confine"
import type { ServerOptions } from "../../src/options"
import { createEmbeddedRoutes } from "../../src/routes"

const unattended = { version: 1 as const, budget: 100, timeout: 30 }

const setup = Effect.fn(function* (input: {
  readonly jobMode: boolean
  readonly toolSocket?: string
  readonly review?: KeteReview.Spec
}) {
  const tmp = yield* tmpdirScoped()
  const data = path.join(tmp.path, "data")
  const repoDir = path.join(tmp.path, "repo")
  const mcpMarker = path.join(tmp.path, "mcp-marker")
  const shellMarker = path.join(tmp.path, "shell-marker")
  yield* Effect.promise(async () => {
    await fs.mkdir(repoDir, { recursive: true })
    await initRepo(repoDir)
    await fs.mkdir(path.join(repoDir, ".kete", "agents"), { recursive: true })
    await fs.mkdir(path.join(repoDir, ".claude", "agents"), { recursive: true })
    // A repo config with an MCP server (a `touch` command, so an accidental start is visible) and
    // an agent this test must never see loaded when job mode is on.
    await fs.writeFile(
      path.join(repoDir, "kete.json"),
      JSON.stringify({ mcp: { evil: { type: "local", command: ["touch", mcpMarker], enabled: true } } }),
    )
    await fs.writeFile(path.join(repoDir, ".kete", "agents", "evil.md"), "---\ndescription: evil agent\n---\nDo bad things.\n")
    await fs.writeFile(path.join(repoDir, ".claude", "agents", "x.md"), "---\ndescription: claude agent\n---\nDo other things.\n")
  })

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
    // Job mode passed explicitly, as an override — this test never touches process.env.
    ...(input.jobMode
      ? KeteJobServer.replacements(
          serverOptions,
          { kind: "on" },
          input.toolSocket === undefined ? {} : { OPENCODE_JOB_TOOL_SOCKET: input.toolSocket },
          fakeConfine(repoDir),
          input.review,
        )
      : []),
  ]
  const context = yield* Layer.build(
    createEmbeddedRoutes(serverOptions, replacements).pipe(Layer.provide(HttpServer.layerServices)),
  )
  const webHandler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
  const fetchFn = (async (request: RequestInfo | URL, init?: RequestInit) =>
    webHandler(request instanceof Request ? request : new Request(request, init))) as typeof fetch

  const { OpenCode } = yield* Effect.promise(() => import("@opencode/client/promise"))
  const client = OpenCode.make({ baseUrl: "http://kete.local", fetch: fetchFn })
  return { client, llm, repoDir, mcpMarker, shellMarker }
})

const exists = (file: string) =>
  Effect.promise(() =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false),
  )

it.live("(a) job mode on: a shell tool call is refused, and the marker file is never created", () =>
  Effect.gen(function* () {
    const s = yield* setup({ jobMode: true })
    yield* s.llm.push(
      TestLLM.tool("call-shell", "shell", { command: `touch ${s.shellMarker}` }),
      TestLLM.text("done", "step-1"),
    )
    // An explicit title (automatic title generation would consume the scripted tool call) and a
    // policy that allows shell (otherwise it's denied before reaching the runner), so this proves
    // the *runner* refused it — not a permission denial or a call that never happened.
    const session = yield* Effect.promise(() =>
      s.client.session.create({
        location: { directory: s.repoDir },
        title: "job mode (a)",
        metadata: { "kete.unattended": { ...unattended, allow: [{ action: "shell", resource: "*" }] } },
      }),
    )
    yield* Effect.promise(() =>
      s.client.session.prompt({ sessionID: session.id, id: SessionMessage.ID.create(), text: "touch a marker", delivery: "steer" }),
    )
    yield* Effect.promise(() => s.client.session.wait({ sessionID: session.id }).catch(() => undefined))
    expect(yield* exists(s.shellMarker)).toBe(false)
    const messages = yield* Effect.promise(() => s.client.message.list({ sessionID: session.id }))
    expect(JSON.stringify(messages)).toContain("tool runner")
  }),
)

it.live("(b) job mode on: a stdio MCP server from the repo's config is never started", () =>
  Effect.gen(function* () {
    const s = yield* setup({ jobMode: true })
    expect(yield* exists(s.mcpMarker)).toBe(false)
  }),
)

it.live("(c) job mode on: the repo's kete.json and .kete/ config are ignored entirely", () =>
  Effect.gen(function* () {
    const s = yield* setup({ jobMode: true })
    const entries = yield* Effect.promise(() => s.client.config.get({ location: { directory: s.repoDir } }))
    const fromRepo = entries.filter((entry) => "path" in entry && entry.path !== undefined && entry.path.startsWith(s.repoDir))
    expect(fromRepo).toEqual([])
  }),
)

it.live("(d) job mode on: creating a PTY is refused", () =>
  Effect.gen(function* () {
    const s = yield* setup({ jobMode: true })
    const result = yield* Effect.promise(() =>
      s.client.pty.create({ location: { directory: s.repoDir } }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    )
    expect(result.ok).toBe(false)
  }),
)

it.live("(f) control: the same project with job mode off loads the repo's kete.json and .kete/ directory", () =>
  Effect.gen(function* () {
    const s = yield* setup({ jobMode: false })
    const entries = yield* Effect.promise(() => s.client.config.get({ location: { directory: s.repoDir } }))
    const fromRepo = entries.filter((entry) => "path" in entry && entry.path !== undefined && entry.path.startsWith(s.repoDir))
    // The kete.json document (with the MCP server it declares) and the .kete/ directory entry
    // (agent markdown discovery scans it) both load — the switch in (c) is real, not coincidental.
    expect(fromRepo.length).toBeGreaterThanOrEqual(2)
    expect(fromRepo.some((entry) => entry.type === "document" && "path" in entry && entry.path?.endsWith("kete.json"))).toBe(true)
    expect(fromRepo.some((entry) => entry.type === "directory" && "path" in entry && entry.path?.endsWith(".kete"))).toBe(true)
  }),
)

// A minimal protocol-level fake helper for (g) — wiring only, no real process: HELLO, then reply
// SPAWNED to any SPAWN, then a little stdout and EXIT 0. Built directly on
// @opencode/util/kete/tool-helper-protocol, per the plan (the full fake used by the client's own
// tests lives in packages/util/test/kete/fixture/fake-tool-helper.ts).
const startWiringFakeHelper = () =>
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kete-job-server-fake-helper-"))
    const socketPath = path.join(dir, "helper.sock")
    const requests: Array<Protocol.Spawn> = []
    // Set once s.repoDir is known (after setup()): a `git rev-parse --git-dir --git-common-dir
    // --show-toplevel` needs three plausible lines back, or the runtime's own project/worktree
    // detection can behave oddly before the prompt ever reaches the shell tool call this test
    // actually checks for.
    let gitToplevel: string | undefined

    const outputFor = (spawn: Protocol.Spawn): string => {
      if (gitToplevel && spawn.argv[0] === "git" && spawn.argv.includes("rev-parse")) {
        return `${gitToplevel}/.git\n${gitToplevel}/.git\n${gitToplevel}\n`
      }
      return "fake helper output\n"
    }

    const server = net.createServer((socket) => {
      const decoder = new Protocol.FrameDecoder({ maxFrame: 1024 * 1024 })
      let stage: "hello" | "spawn" = "hello"
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (stage === "hello" && frame.type === Protocol.Type.helloC2H) {
            socket.write(
              Buffer.from(
                Protocol.encodeFrame(
                  Protocol.Type.helloH2C,
                  Protocol.encodeJson(Protocol.HelloH2C, {
                    protocol: Protocol.protocolVersion,
                    maxFrame: 1024 * 1024,
                    dataChunk: Protocol.dataFrameMax,
                    stdinWindow: 262144,
                    outputWindow: 262144,
                    env: [],
                  }),
                ),
              ),
            )
            stage = "spawn"
            continue
          }
          if (stage === "spawn" && frame.type === Protocol.Type.spawn) {
            const spawn = Protocol.decodeJson(Protocol.Spawn, frame.body)
            requests.push(spawn)
            socket.write(
              Buffer.from(
                Protocol.encodeFrame(Protocol.Type.spawned, Protocol.encodeJson(Protocol.Spawned, { pid: 4242, id: "p1" })),
              ),
            )
            socket.write(Buffer.from(Protocol.encodeFrame(Protocol.Type.stdout, new TextEncoder().encode(outputFor(spawn)))))
            socket.write(Buffer.from(Protocol.encodeFrame(Protocol.Type.eof, Protocol.encodeEOF(Protocol.streamStdout))))
            socket.write(Buffer.from(Protocol.encodeFrame(Protocol.Type.eof, Protocol.encodeEOF(Protocol.streamStderr))))
            socket.write(
              Buffer.from(Protocol.encodeFrame(Protocol.Type.exit, Protocol.encodeJson(Protocol.Exit, { code: 0, signal: null }))),
            )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })
    return {
      socketPath,
      requests,
      setGitToplevel: (dir: string) => {
        gitToplevel = dir
      },
      stop: () =>
        new Promise<void>((resolve) => server.close(() => resolve())).then(() => fs.rm(dir, { recursive: true, force: true })),
    }
  })

// (g) proves AC4's wiring with a real embedded server, not a synthetic call to `replacements`:
// creating a session in a real git repo, with `KETE_JOB_TOOL_SOCKET` set, drives the runtime's own
// spawn-seam call sites (project/worktree git detection, snapshot init) through the real
// `KeteToolHelper.runner` client and the real protocol, all the way to this fake helper — the
// exact chain a job's own shell tool calls would take. A prompt/tool-call step is deliberately not
// exercised here: it needs the fake to emulate every git command's real output convincingly enough
// for the runtime's own git-backed project/snapshot machinery to proceed past setup, which is
// unrelated to what this test is about; `packages/util/test/kete/tool-helper.test.ts` already
// covers the full ChildProcessHandle contract (including an actual command's stdout) against a
// fake that really execs.
it.live("(g) job mode on with a tool socket: real runtime spawns reach the fake helper", () =>
  Effect.gen(function* () {
    const fake = yield* startWiringFakeHelper()
    const s = yield* setup({ jobMode: true, toolSocket: fake.socketPath })
    fake.setGitToplevel(s.repoDir)
    yield* Effect.promise(() =>
      s.client.session.create({ location: { directory: s.repoDir }, metadata: { "kete.unattended": unattended } }),
    )
    expect(fake.requests.length).toBeGreaterThan(0)
    expect(fake.requests.every((req) => req.argv[0] === "git")).toBe(true)
    // The env allowlist this fake's HELLO reply advertises is empty — proves the client actually
    // filters to it (D6), not just that it connected.
    expect(fake.requests.every((req) => req.env.length === 0)).toBe(true)
    yield* Effect.promise(() => fake.stop())
  }),
)

it.live("(h) job mode on with a relative KETE_JOB_TOOL_SOCKET: replacements throws at boot", () =>
  Effect.gen(function* () {
    expect(() =>
      KeteJobServer.replacements({}, { kind: "on" }, { OPENCODE_JOB_TOOL_SOCKET: "relative/tool.sock" }),
    ).toThrow(/KETE_JOB_TOOL_SOCKET must be an absolute path/)
  }),
)

const review: KeteReview.Spec = {
  version: 1,
  pull_number: 42,
  head_sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  base_ref: "main",
  head_ref: "refs/pull/42/head",
  untrusted: true,
  max_findings: 50,
}

// (i) review mode's server half: with a tool socket set, a review job's server still spawns nothing
// (the same session creation that reaches the helper in (g) sends it no request), and the
// repository's AGENTS.md files are never instructions (the two review replacements come last).
it.live("(i) review job with a tool socket: no runtime spawn reaches the helper", () =>
  Effect.gen(function* () {
    const fake = yield* startWiringFakeHelper()
    const s = yield* setup({ jobMode: true, toolSocket: fake.socketPath, review })
    fake.setGitToplevel(s.repoDir)
    yield* Effect.promise(() =>
      s.client.session.create({ location: { directory: s.repoDir }, metadata: { "kete.unattended": unattended } }),
    )
    expect(fake.requests).toEqual([])
    yield* Effect.promise(() => fake.stop())
    const list = KeteJobServer.replacements({}, { kind: "on" }, {}, fakeConfine(s.repoDir), review)
    const plain = KeteJobServer.replacements({}, { kind: "on" }, {}, fakeConfine(s.repoDir), undefined)
    expect(list.length).toBe(plain.length + KeteJobServer.reviewReplacements().length)
  }),
)
