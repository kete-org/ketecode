// Language server diagnostics (core/src/kete/lsp.ts and kete/lsp/*): the JSON-RPC framing, the
// server settings (built-ins, `lsp: false`, per-server `disabled`, project config can't add
// commands), root detection, the report (errors only, deduplicated per session, bounded), and the
// plugin end to end with a fake language server (test/fixture/kete/fake-lsp-server.js): an edit's
// result gains the new errors once, a server isn't started without a program, never in job mode,
// and the server's environment has no Kete credentials.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteLsp } from "@opencode/core/kete/lsp"
import { KeteLspRpc } from "@opencode/core/kete/lsp/rpc"
import { KeteLspServers } from "@opencode/core/kete/lsp/servers"
import { KeteLspDiagnostics } from "@opencode/core/kete/lsp/diagnostics"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { KeteSandboxProbe } from "@opencode/core/kete/sandbox/probe"
import { host } from "../plugin/host"

const sandbox = await KeteSandboxProbe.probe()
if (!sandbox.available && process.env.KETE_SANDBOX_TESTS === "required")
  throw new Error(`lsp.test.ts: the sandbox is required here but unavailable: ${sandbox.reason}`)
const fake = path.join(import.meta.dir, "..", "fixture", "kete", "fake-lsp-server.js")

describe("JSON-RPC framing", () => {
  test("splits frames across chunks, answers server requests, times out requests", async () => {
    const written: unknown[] = []
    const connection = new KeteLspRpc.Connection({
      write: (frame) => {
        const text = new TextDecoder().decode(frame)
        written.push(JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)))
      },
    })
    const seen: unknown[] = []
    connection.onNotification("note", (params) => seen.push(params))
    connection.onRequest("ask", () => ({ ok: true }))
    const frame = KeteLspRpc.encode({ jsonrpc: "2.0", method: "note", params: { a: "é" } })
    connection.feed(frame.subarray(0, 10))
    connection.feed(frame.subarray(10))
    expect(seen).toEqual([{ a: "é" }])
    connection.feed(KeteLspRpc.encode({ jsonrpc: "2.0", id: 7, method: "ask" }))
    connection.feed(KeteLspRpc.encode({ jsonrpc: "2.0", id: 8, method: "unknown" }))
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 7, result: { ok: true } },
      { jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found: unknown" } },
    ])
    const pending = connection.request("slow", {}, 20)
    await expect(pending).rejects.toThrow("timed out")
    const answered = connection.request("fast", {}, 1000)
    connection.feed(KeteLspRpc.encode({ jsonrpc: "2.0", id: 2, result: 42 }))
    expect(await answered).toBe(42)
  })

  test("a frame over the limit or without a length closes the connection", () => {
    const reasons: string[] = []
    const big = new KeteLspRpc.Connection({ write: () => {}, onClose: (reason) => reasons.push(reason) })
    big.feed(new TextEncoder().encode(`Content-Length: ${KeteLspRpc.MAX_FRAME_BYTES + 1}\r\n\r\n`))
    const bad = new KeteLspRpc.Connection({ write: () => {}, onClose: (reason) => reasons.push(reason) })
    bad.feed(new TextEncoder().encode("X-Nope: 1\r\n\r\n{}"))
    expect(reasons).toEqual(["frame too large", "frame without Content-Length"])
    expect(big.isClosed && bad.isClosed).toBe(true)
  })
})

describe("server settings", () => {
  const globalDirectory = "/home/u/.config/kete"
  const user = (lsp: unknown) => ({ path: path.join(globalDirectory, "kete.json"), lsp }) as KeteLspServers.Document
  const project = (lsp: unknown) => ({ path: "/repo/kete.json", lsp }) as KeteLspServers.Document

  test("the built-ins by default", () => {
    const settings = KeteLspServers.resolve({ documents: [], globalDirectory })
    expect(settings.servers.map((server) => server.id)).toEqual(["typescript", "python", "go", "rust"])
    expect(KeteLspServers.forFile(settings, "/repo/a.tsx").map((server) => server.id)).toEqual(["typescript"])
    expect(KeteLspServers.forFile(settings, "/repo/README")).toEqual([])
    const rust = settings.servers.find((server) => server.id === "rust")!
    expect(rust.initialization).toMatchObject({ cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } })
  })

  test("lsp: false anywhere turns everything off; disabled turns one off", () => {
    expect(KeteLspServers.resolve({ documents: [project(false)], globalDirectory }).servers).toEqual([])
    const one = KeteLspServers.resolve({ documents: [project({ go: { disabled: true } })], globalDirectory })
    expect(one.servers.map((server) => server.id)).toEqual(["typescript", "python", "rust"])
    // A project's `true` can't turn back on what the user turned off.
    expect(KeteLspServers.resolve({ documents: [user(false), project(true)], globalDirectory }).enabled).toBe(false)
  })

  test("commands count only from the global config", () => {
    const custom = { fake: { command: ["fake-ls"], extensions: ["fk"] }, typescript: { command: ["evil"] } }
    const fromProject = KeteLspServers.resolve({ documents: [project(custom)], globalDirectory })
    expect(fromProject.servers.find((server) => server.id === "fake")).toBeUndefined()
    expect(fromProject.servers.find((server) => server.id === "typescript")!.command).toEqual([
      "typescript-language-server",
      "--stdio",
    ])
    expect(fromProject.ignored).toEqual(["lsp.fake", "lsp.typescript"])
    const fromUser = KeteLspServers.resolve({ documents: [user(custom)], globalDirectory })
    expect(fromUser.servers.find((server) => server.id === "fake")).toMatchObject({ command: ["fake-ls"], extensions: [".fk"] })
    expect(fromUser.servers.find((server) => server.id === "typescript")!.command).toEqual(["evil"])
  })

  test("the root is the nearest directory with a marker, inside the workspace", async () => {
    const present = new Set(["/w/pkg/package.json", "/w/package.json"])
    const exists = async (candidate: string) => present.has(candidate)
    expect(await KeteLspServers.root({ roots: ["package.json"] }, "/w/pkg/src/a.ts", "/w", exists)).toBe("/w/pkg")
    expect(await KeteLspServers.root({ roots: ["go.mod"] }, "/w/pkg/a.go", "/w", exists)).toBe("/w")
    expect(await KeteLspServers.root({ roots: ["package.json"] }, "/elsewhere/a.ts", "/w", exists)).toBe("/w")
  })
})

describe("the report", () => {
  const error = (line: number, message: string): KeteLspDiagnostics.Diagnostic => ({ line, character: 0, severity: 1, message })

  test("new errors in full, earlier ones counted, fixes noted, warnings left out", () => {
    const reported = new KeteLspDiagnostics.Reported()
    const run = (items: KeteLspDiagnostics.Diagnostic[], sessionID = "s1") =>
      KeteLspDiagnostics.report({ sessionID, workspace: "/w", files: new Map([["/w/a.ts", items]]), reported })
    const first = run([error(0, "one"), { ...error(1, "warn"), severity: 2 }])
    expect(first).toContain('<diagnostics file="a.ts">\nERROR [1:1] one\n</diagnostics>')
    expect(first).not.toContain("warn")
    expect(run([error(0, "one")])).toBeUndefined()
    expect(run([error(0, "one"), error(2, "two")])).toContain("ERROR [3:1] two\n(1 error reported earlier still present)")
    expect(run([])).toContain("a.ts: the errors reported earlier are fixed.")
    expect(run([error(0, "one")], "s2")).toContain("ERROR [1:1] one")
  })

  test("bounded per file and per report; messages cleaned", () => {
    const reported = new KeteLspDiagnostics.Reported()
    const many = Array.from({ length: 25 }, (_, index) => error(index, `e${index}`))
    const files = new Map(Array.from({ length: 7 }, (_, index) => [`/w/f${index}.ts`, many] as const))
    const text = KeteLspDiagnostics.report({ sessionID: "s", workspace: "/w", files, reported })!
    expect(text.match(/<diagnostics /g)?.length).toBe(KeteLspDiagnostics.MAX_FILES)
    expect(text).toContain("... and 5 more")
    expect(text).toContain("new errors in 2 more files")
    expect(KeteLspDiagnostics.clean("a\u001b[31m\nb" + "x".repeat(400)).length).toBe(KeteLspDiagnostics.MAX_MESSAGE)
    expect(KeteLspDiagnostics.parse({ message: "m" })).toBeUndefined()
  })
})

describe("the plugin with a fake language server", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function setup(
    options: {
      env?: Record<string, string | undefined>
      which?: (name: string) => string | null
      lsp?: unknown
      realSandbox?: boolean
    } = {},
  ) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-lsp-test-")))
    const globalDir = path.join(dir, "config")
    const workspace = path.join(dir, "repo")
    await fs.mkdir(workspace, { recursive: true })
    await fs.mkdir(globalDir, { recursive: true })
    const logFile = path.join(dir, "server.log")
    const lsp = options.lsp ?? { fake: { command: ["fake-ls", fake], extensions: [".fk"] }, typescript: { disabled: true } }
    const hooks: Array<(event: any) => Effect.Effect<unknown, unknown>> = []
    const ctx: Plugin.Context = host({
      tool: { hook: ((_name: string, handler: any) => Effect.sync(() => void hooks.push(handler))) as any } as any,
    })
    const location = new Location.Info({
      directory: AbsolutePath.make(workspace),
      project: { id: Project.ID.global, directory: AbsolutePath.make(workspace), canonical: AbsolutePath.make(workspace) },
    })
    const scope = Effect.runSync(Scope.make())
    const env = { PATH: process.env.PATH, FAKE_LSP_LOG: logFile, KETE_API_KEY: "secret", ...options.env }
    const plugin = KeteLsp.make({
      env,
      which: options.which ?? ((name) => (name === "fake-ls" ? process.execPath : null)),
      ...(options.realSandbox
        ? {}
        : {
            sandbox: async (command: ReadonlyArray<string>, launchEnv: Record<string, string>) => ({
              file: command[0]!,
              args: command.slice(1),
              env: launchEnv,
              release: async () => {},
            }),
          }),
      timeouts: { diagnostics: 3000, quiet: 150 },
    })
    const services = Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      return Layer.mergeAll(
        Layer.succeed(Location.Service, location),
        Layer.succeed(Environment.Service, Environment.Service.of({ files: {} as any, spawner })),
        Config.testLayer([
          { type: "document", path: path.join(globalDir, "kete.json"), info: { lsp } } as any,
        ]),
        Layer.succeed(
          FileAccess.Service,
          FileAccess.Service.of({
            resolve: (input: { path: string }) => Effect.succeed({ absolute: path.resolve(workspace, input.path) }),
          } as any),
        ),
        Layer.succeed(
          Global.Service,
          Global.Service.of({
            config: globalDir,
            home: dir,
            ...Object.fromEntries(["data", "cache", "state", "log", "bin", "tmp", "repos"].map((name) => [name, path.join(dir, name)])),
          } as any),
        ),
      )
    }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))
    const layer = await Effect.runPromise(services)
    await Effect.runPromise(plugin.effect(ctx).pipe(Effect.provide(layer), Scope.provide(scope)) as Effect.Effect<void>)
    cleanups.push(async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await fs.rm(dir, { recursive: true, force: true })
    })
    const edit = async (file: string, text: string, tool = "write", sessionID = "ses_1") => {
      const absolute = path.join(workspace, file)
      await fs.writeFile(absolute, text)
      const event: any = {
        tool,
        sessionID,
        status: "completed",
        input: { path: file },
        result: { output: tool === "write" ? { target: absolute } : {}, content: [{ type: "text", text: "Edit applied." }] },
      }
      for (const hook of hooks) await Effect.runPromise(hook(event))
      return event.result.content as Array<{ type: string; text: string }>
    }
    const log = async () => (await fs.readFile(logFile, "utf8").catch(() => "")).split("\n").filter(Boolean)
    return { edit, log, hooks, workspace }
  }

  test("an edit's result gains the new errors once, and the fix", async () => {
    const h = await setup()
    const first = await h.edit("a.fk", "fine\nBAD here\nMEH\n")
    expect(first.at(-1)!.text).toContain('<diagnostics file="a.fk">\nERROR [2:1] bad thing: BAD here (fake)\n</diagnostics>')
    expect(first.at(-1)!.text).not.toContain("warning")
    const again = await h.edit("a.fk", "fine\nBAD here\n", "edit")
    expect(again).toEqual([{ type: "text", text: "Edit applied." }])
    const fixed = await h.edit("a.fk", "fine\n")
    expect(fixed.at(-1)!.text).toContain("a.fk: the errors reported earlier are fixed.")
    const log = await h.log()
    expect(log.filter((line) => line === "initialize")).toHaveLength(1)
    expect(log).toContain("textDocument/didOpen")
    expect(log).toContain("textDocument/didChange")
    expect(log).toContain("response") // answered workspace/configuration
    // Kete's credentials don't reach the server.
    expect(log.find((line) => line.startsWith("env:"))).toBe("env:")
  }, 20_000)

  test("files no server handles, and other tools, start nothing", async () => {
    const h = await setup()
    expect(await h.edit("notes.txt", "BAD\n")).toEqual([{ type: "text", text: "Edit applied." }])
    expect(await h.edit("a.fk", "BAD\n", "read")).toEqual([{ type: "text", text: "Edit applied." }])
    expect(await h.log()).toEqual([])
  })

  test("a missing program starts nothing", async () => {
    const h = await setup({ which: () => null })
    expect(await h.edit("a.fk", "BAD\n")).toEqual([{ type: "text", text: "Edit applied." }])
    expect(await h.log()).toEqual([])
  })

  test("a server that crashes on start is skipped, and the edit still succeeds", async () => {
    const h = await setup({ env: { FAKE_LSP_MODE: "crash" } })
    expect(await h.edit("a.fk", "BAD\n")).toEqual([{ type: "text", text: "Edit applied." }])
    expect(await h.edit("a.fk", "BAD BAD\n")).toEqual([{ type: "text", text: "Edit applied." }])
    expect((await h.log()).filter((line) => line === "initialize")).toHaveLength(1)
  }, 20_000)

  test("lsp: false turns it off", async () => {
    const h = await setup({ lsp: false })
    expect(await h.edit("a.fk", "BAD\n")).toEqual([{ type: "text", text: "Edit applied." }])
    expect(await h.log()).toEqual([])
  })

  test.skipIf(!sandbox.available)("runs the server in the OS sandbox", async () => {
    const h = await setup({ realSandbox: true })
    const first = await h.edit("a.fk", "BAD here\n")
    expect(first.at(-1)!.text).toContain("ERROR [1:1] bad thing: BAD here")
  }, 30_000)

  // A real server, when one is named: KETE_LSP_SMOKE_TS=/path/to/typescript-language-server.
  const tsls = process.env.KETE_LSP_SMOKE_TS
  test.skipIf(!tsls)("typescript-language-server reports a type error (smoke)", async () => {
    const h = await setup({
      which: (name) => (name === tsls ? tsls : null),
      lsp: {
        typescript: {
          command: [tsls!, "--stdio"],
          initialization: {
            tsserver: { path: path.join(path.dirname(tsls!), "..", "typescript", "lib", "tsserver.js") },
          },
        },
      },
      realSandbox: true,
    })
    await fs.writeFile(path.join(h.workspace, "tsconfig.json"), '{"compilerOptions":{"strict":true}}')
    const result = await h.edit("a.ts", 'const n: number = "text"\nexport {}\n')
    expect(result.at(-1)!.text).toContain("ERROR [1:7]")
  }, 60_000)

  test("job mode registers nothing", async () => {
    const h = await setup({ env: { KETE_JOB_MODE: "1", OPENCODE_JOB_MODE: "1" } })
    expect(h.hooks).toHaveLength(0)
  })
})
