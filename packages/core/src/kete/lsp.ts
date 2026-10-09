// Language server diagnostics after the agent's edits: compiler and linter errors from the
// project's language servers, fed back to the agent in the edit's result so it fixes them before
// moving on.
//
// OpenCode v2 dropped v1's LSP runtime (its file-mutation and edit tools carry TODOs for it) but kept
// the `lsp` configuration key; this module implements the runtime behind that key.
//
// - After `edit`, `write` and `patch` complete, the files they touched that a configured server
//   handles are opened (or changed) in that server and their diagnostics collected; new errors are
//   appended to the tool's result (diagnostics.ts: errors only, deduplicated per session, bounded).
//   Nothing here can fail the edit: a server that doesn't start or answer is logged and skipped.
// - Servers start lazily, on the first edit of a file they handle, one per server and project root,
//   at most `MAX_SERVERS` at a time (the least recently used is stopped). Only programs on PATH are
//   used (servers.ts); a missing one is skipped quietly; one that fails to start isn't retried until
//   the runtime restarts. All stop when the location closes.
// - A language server reads the project and may run parts of it, so it runs in the OS sandbox
//   (sandbox.ts) without network and with nothing writable but a private temp directory and the
//   toolchain caches — not even the workspace. With the sandbox off (the user's choice) or
//   unavailable it runs unsandboxed, like formatters and MCP servers; when the sandbox is required
//   and unavailable, no server starts. Kete's own credentials are removed from its environment.
// - Off in job mode (cloud and self-hosted jobs, review jobs): no processes beyond the job's tool
//   runner. Off for locations in a remote workspace. `lsp: false` turns it off.

export * as KeteLsp from "./lsp.js"

import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Effect, Exit, Fiber, Predicate, Queue, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import { Shell } from "../shell.js"
import { which } from "../util/which.js"
import { KeteLspClient } from "./lsp/client.js"
import { KeteLspDiagnostics } from "./lsp/diagnostics.js"
import { KeteLspServers } from "./lsp/servers.js"
import { KeteSandbox } from "./sandbox.js"
import { KeteSandboxResolve } from "./sandbox/resolve.js"
import { KeteBubblewrap } from "./sandbox/bubblewrap.js"
import { KeteSeatbelt } from "./sandbox/seatbelt.js"
import { KeteToolEnv } from "./tool-env.js"

export const MAX_SERVERS = 4
/** Files whose diagnostics one edit waits for (the rest of a large patch is skipped). */
export const MAX_FILES_PER_EDIT = 10
/** Characters of a file sent to a server; larger files are skipped. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export const editTools: ReadonlySet<string> = new Set(["edit", "write", "patch"])

const stringField = (input: unknown, field: string) =>
  Predicate.isObject(input) && Predicate.hasProperty(input, field) && typeof input[field] === "string"
    ? input[field]
    : undefined

/** The files an edit tool's call touched, as the tool reported or was asked them (paths as given). */
export function touched(tool: string, input: unknown, output: unknown): { readonly absolute: string[]; readonly relative: string[] } {
  if (tool === "write") {
    const target = stringField(output, "target")
    return { absolute: target ? [target] : [], relative: [] }
  }
  if (tool === "patch") {
    const applied = Predicate.isObject(output) && Array.isArray(output.applied) ? output.applied : []
    return {
      absolute: applied.map((item) => stringField(item, "target")).filter((value): value is string => value !== undefined),
      relative: [],
    }
  }
  if (tool === "edit") {
    const file = stringField(input, "path")
    return { absolute: [], relative: file ? [file] : [] }
  }
  return { absolute: [], relative: [] }
}

/** How a server process is started: the program and arguments, possibly wrapped by the sandbox. */
export interface Launch {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly release: () => Promise<void>
}

export interface Deps {
  /** Finds a program on PATH. */
  readonly which?: (command: string) => string | null
  /** Overrides the sandbox decision (tests); default: the OS sandbox per `kete.sandbox`. */
  readonly sandbox?: (command: ReadonlyArray<string>, env: Record<string, string>) => Promise<Launch | undefined>
  readonly timeouts?: Partial<KeteLspClient.Timeouts>
  readonly env?: Record<string, string | undefined>
}

interface Running {
  readonly key: string
  readonly client: KeteLspClient.Client
  readonly scope: Scope.Closeable
  readonly release: () => Promise<void>
  lastUsed: number
}

function plain(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value
  return result
}

export function make(deps: Deps = {}) {
  return {
    id: "kete.lsp",
    effect: Effect.fn("KeteLsp.Plugin")(function* (ctx: PluginContext) {
      const env = deps.env ?? process.env
      if (KeteJobMode.enabled(env)) return
      const location = yield* Location.Service
      if (location.workspaceID) return
      const environment = yield* Environment.Service
      const config = yield* Config.Service
      const access = yield* FileAccess.Service
      const global = yield* Global.Service
      const pluginScope = yield* Effect.scope
      const lookup = deps.which ?? ((command: string) => which(command, env as NodeJS.ProcessEnv))
      const workspace = location.project.directory ?? location.directory

      const running = new Map<string, Promise<Running | undefined>>()
      const broken = new Set<string>()
      const reported = new KeteLspDiagnostics.Reported()
      const warned = new Set<string>()

      const sandboxLaunch =
        deps.sandbox ??
        (async (command: ReadonlyArray<string>, launchEnv: Record<string, string>): Promise<Launch | undefined> => {
          const entries = await Effect.runPromise(config.entries())
          const settings = KeteSandbox.settingsFrom(entries, global.config, env)
          const unsandboxed = { file: command[0]!, args: command.slice(1), env: launchEnv, release: async () => {} }
          if (settings.mode === "off") return unsandboxed
          const available = await Effect.runPromise(KeteSandbox.availability)
          if (!available.available) return settings.mode === "required" ? undefined : unsandboxed
          // Writable: only a private temp directory (passed as the "workspace") and the caches.
          const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kete-lsp-"))
          const resolved = await KeteSandboxResolve.resolve(
            {
              platform: available.mechanism === "seatbelt" ? "darwin" : "linux",
              home: global.home,
              workspace: tmp,
              directory: tmp,
              kete: global,
              shellOutput: path.join(global.data, Shell.DIRECTORY),
              settings,
              network: false,
              privateTmp: tmp,
              env,
            },
            KeteSandboxResolve.shared,
          ).catch(async (error: unknown) => {
            await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
            throw error
          })
          const release = async () => {
            await resolved.release()
            await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
          }
          const wrapped =
            available.mechanism === "seatbelt"
              ? KeteSeatbelt.command(resolved.policy, command[0]!, command.slice(1))
              : KeteBubblewrap.command(available.executable, resolved.policy, tmp, command[0]!, command.slice(1))
          return {
            ...wrapped,
            env: plain(KeteSandbox.environment(launchEnv, tmp, false)),
            release,
          }
        })

      const stop = (entry: Running) =>
        Effect.runPromise(
          Effect.promise(() => entry.client.shutdown()).pipe(
            Effect.ensuring(Scope.close(entry.scope, Exit.void)),
            Effect.ensuring(Effect.promise(() => entry.release().catch(() => undefined))),
          ),
        ).catch(() => undefined)

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const all = await Promise.all([...running.values()].map((item) => item.catch(() => undefined)))
          running.clear()
          await Promise.all(all.filter((item): item is Running => item !== undefined).map(stop))
        }),
      )

      const start = async (server: KeteLspServers.Server, root: string, key: string): Promise<Running | undefined> => {
        const candidates = [server.command, ...(server.alternatives ?? [])]
        let command: ReadonlyArray<string> | undefined
        for (const candidate of candidates) {
          const found = candidate[0] ? lookup(candidate[0]) : null
          if (found) {
            command = [found, ...candidate.slice(1)]
            break
          }
        }
        if (!command) return undefined
        const launchEnv = { ...plain(KeteToolEnv.withoutKeteCredentials(env)), ...server.env }
        const launch = await sandboxLaunch(command, launchEnv)
        if (!launch) {
          broken.add(key)
          await Effect.runPromise(
            Effect.logWarning("language server not started: the OS sandbox is required but unavailable", { server: server.id }),
          )
          return undefined
        }
        const scope = await Effect.runPromise(Scope.fork(pluginScope))
        const outgoing = await Effect.runPromise(Queue.unbounded<Uint8Array, never>())
        let client: KeteLspClient.Client | undefined
        try {
          const handle = await Effect.runPromise(
            environment.spawner
              .spawn(
                ChildProcess.make(launch.file, [...launch.args], {
                  cwd: root,
                  env: launch.env,
                  extendEnv: false,
                  stdin: { stream: Stream.fromQueue(outgoing), endOnDone: true },
                  stdout: "pipe",
                  stderr: "pipe",
                  forceKillAfter: "2 seconds",
                }),
              )
              .pipe(Scope.provide(scope)),
          )
          const created = new KeteLspClient.Client({
            serverID: server.id,
            root,
            initialization: server.initialization,
            timeouts: deps.timeouts,
            write: (frame) => Queue.offerUnsafe(outgoing, frame),
            onClose: () => {
              running.delete(key)
            },
          })
          client = created
          Effect.runFork(
            Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => created.connection.feed(chunk))).pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => created.connection.close("exited"))),
              Scope.provide(scope),
            ),
          )
          Effect.runFork(
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((text) =>
                text.trim() === "" ? Effect.void : Effect.logDebug("language server stderr", { server: server.id, text: text.slice(0, 2000) }),
              ),
              Effect.ignore,
              Scope.provide(scope),
            ),
          )
          await created.initialize()
          return { key, client: created, scope, release: launch.release, lastUsed: Date.now() }
        } catch (error) {
          broken.add(key)
          client?.connection.close("failed to start")
          await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined)
          await launch.release().catch(() => undefined)
          await Effect.runPromise(
            Effect.logWarning("language server failed to start", {
              server: server.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          return undefined
        }
      }

      const get = async (server: KeteLspServers.Server, root: string) => {
        const key = `${server.id}\u0000${root}`
        if (broken.has(key)) return undefined
        let entry = running.get(key)
        if (!entry) {
          // Stop the least recently used server when at the limit.
          if (running.size >= MAX_SERVERS) {
            const settled = await Promise.all([...running.values()].map((item) => item.catch(() => undefined)))
            const oldest = settled
              .filter((item): item is Running => item !== undefined)
              .sort((a, b) => a.lastUsed - b.lastUsed)[0]
            if (oldest) {
              running.delete(oldest.key)
              void stop(oldest)
            }
          }
          entry = start(server, root, key)
          running.set(key, entry)
          entry.then((value) => {
            if (!value && running.get(key) === entry) running.delete(key)
          })
        }
        const value = await entry
        if (value?.client.closed) {
          running.delete(key)
          return undefined
        }
        if (value) value.lastUsed = Date.now()
        return value
      }

      const exists = async (candidate: string) => fs.access(candidate).then(() => true, () => false)

      /** Diagnostics for each file (absolute path), from every server that handles it. */
      const diagnose = async (files: ReadonlyArray<string>) => {
        const entries = await Effect.runPromise(config.entries())
        const settings = KeteLspServers.resolve({
          documents: entries.flatMap((entry) => (entry.type === "document" ? [{ path: entry.path, lsp: entry.info.lsp }] : [])),
          globalDirectory: global.config,
        })
        for (const item of settings.ignored) {
          if (warned.has(item)) continue
          warned.add(item)
          await Effect.runPromise(
            Effect.logWarning("ignored a language server setting from project configuration (only the global config may set commands)", {
              setting: item,
            }),
          )
        }
        const result = new Map<string, KeteLspDiagnostics.Diagnostic[]>()
        await Promise.all(
          files.map(async (file) => {
            const servers = KeteLspServers.forFile(settings, file)
            if (servers.length === 0) return
            const stat = await fs.stat(file).catch(() => undefined)
            if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return
            const text = await fs.readFile(file, "utf8").catch(() => undefined)
            if (text === undefined) return
            const all: KeteLspDiagnostics.Diagnostic[] = []
            await Promise.all(
              servers.map(async (server) => {
                const root = await KeteLspServers.root(server, file, workspace, exists)
                const entry = await get(server, root)
                if (!entry) return
                entry.client.touch(file, text)
                all.push(...(await entry.client.diagnostics(file)))
              }),
            )
            result.set(file, all)
          }),
        )
        return result
      }

      const resolveRelative = (file: string) =>
        access.resolve({ path: file, kind: "file" }).pipe(
          Effect.map((target): string | undefined => target.absolute),
          Effect.catch(() => Effect.succeed(undefined)),
        )

      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          if (event.status !== "completed" || !editTools.has(event.tool)) return
          const files = touched(event.tool, event.input, event.result.output)
          const absolute = [...files.absolute]
          for (const file of files.relative) {
            const resolved = yield* resolveRelative(file)
            if (resolved) absolute.push(resolved)
          }
          const unique = [...new Set(absolute)].slice(0, MAX_FILES_PER_EDIT)
          if (unique.length === 0) return
          const diagnostics = yield* Effect.promise(() => diagnose(unique))
          if (diagnostics.size === 0) return
          const text = KeteLspDiagnostics.report({ sessionID: event.sessionID, workspace, files: diagnostics, reported })
          if (text === undefined) return
          const content = event.result.content
          event.result = {
            ...event.result,
            content:
              content === undefined
              ? text
                : typeof content === "string"
                  ? `${content}\n\n${text}`
                  : [...content, { type: "text", text }],
          }
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("language server diagnostics failed", { tool: event.tool, cause })),
        ),
      )
    }),
  }
}

export const Plugin = make()
