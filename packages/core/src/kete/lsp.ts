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
//   used, found by lsp/executable.ts (absolute PATH entries only, never inside the workspace); a
//   missing one is skipped quietly; one that fails to start isn't retried until the runtime
//   restarts. All stop when the location closes. No memory or CPU limits are set on them.
// - A language server reads the project and runs parts of it (servers.ts lists what), so it runs in
//   the OS sandbox (sandbox.ts) without network and with nothing writable but a private temp
//   directory and the toolchain caches — not even the workspace. Without an active sandbox (turned
//   off, unavailable, Windows) no server starts unless the global config sets
//   `kete.lsp.unsandboxed: true`, and never when a policy denies `sandbox_off`. Its environment is
//   an allowlist (`serverEnvironment`), without credential-looking names.
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
import { ManagedPolicy } from "../managed-policy.js"
import { Wildcard } from "../util/wildcard.js"
import { KeteLspClient } from "./lsp/client.js"
import { KeteLspDiagnostics } from "./lsp/diagnostics.js"
import { KeteLspExecutable } from "./lsp/executable.js"
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

/** Variables a language server keeps from the runtime's environment (names; `LC_*` too). */
export const allowedVariables: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM",
  "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  // Windows
  "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS",
  // Toolchains: where they are installed and cache
  "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME", "NODE_PATH", "NVM_DIR",
])

/**
 * A language server's environment: only `allowedVariables` (and `LC_*`) from the runtime's, never a
 * name that looks like a credential, then the server's own settings. On Windows the current
 * directory is taken out of program lookup (`NoDefaultCurrentDirectoryInExePath`).
 */
export function serverEnvironment(
  env: Record<string, string | undefined>,
  server: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (!allowedVariables.has(upper) && !upper.startsWith("LC_")) continue
    if (KeteToolEnv.isCredential(name)) continue
    result[name] = value
  }
  for (const [name, value] of Object.entries(server ?? {})) result[name] = value
  if (platform === "win32") result.NoDefaultCurrentDirectoryInExePath = "1"
  return result
}

/** Whether a policy statement denies leaving the OS sandbox (`sandbox_off`). */
export function sandboxOffDenied(policies: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>) {
  const statement = policies.findLast(
    (policy) => policy.action === "permission" && Wildcard.match("sandbox_off:language-server", policy.resource),
  )
  return statement?.effect === "deny"
}

/**
 * Whether a language server may start without the OS sandbox: only when the sandbox isn't required,
 * the global config opted in (`kete.lsp.unsandboxed`), and no policy denies `sandbox_off`.
 */
export function unsandboxedAllowed(input: {
  readonly mode: string
  readonly optedIn: boolean
  readonly policies: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>
}) {
  return input.mode !== "required" && input.optedIn && !sandboxOffDenied(input.policies)
}

/**
 * The global config's typescript-language-server: a TypeScript installed next to it (a global
 * `npm i -g typescript-language-server typescript`), so the project's own `node_modules/typescript`
 * isn't loaded. Undefined when there is none.
 */
export async function siblingTsserver(program: string, workspace: string): Promise<string | undefined> {
  const real = await fs.realpath(program).catch(() => undefined)
  if (!real) return undefined
  const realWorkspace = await fs.realpath(workspace).catch(() => workspace)
  const dir = path.dirname(real)
  const candidates = [
    path.join(dir, "..", "node_modules", "typescript", "lib", "tsserver.js"),
    path.join(dir, "..", "..", "typescript", "lib", "tsserver.js"),
    path.join(dir, "..", "lib", "node_modules", "typescript", "lib", "tsserver.js"),
  ]
  for (const candidate of candidates) {
    const resolved = await fs.realpath(candidate).catch(() => undefined)
    if (!resolved) continue
    const relative = path.relative(realWorkspace, resolved)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) continue
    return resolved
  }
  return undefined
}

export interface Deps {
  /** Finds a program (default: lsp/executable.ts over absolute PATH entries, outside the workspace). */
  readonly find?: (command: string) => Promise<string | undefined>
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
      const managed = yield* ManagedPolicy.Service
      const pluginScope = yield* Effect.scope
      const workspace = location.project.directory ?? location.directory
      const lookup = deps.find ?? ((command: string) => KeteLspExecutable.find(command, { env, workspace }))
      const userDocument = (file: string | undefined) => {
        if (file === undefined) return false
        const relative = path.relative(global.config, file)
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
      }

      const running = new Map<string, Promise<Running | undefined>>()
      const broken = new Set<string>()
      const reported = new KeteLspDiagnostics.Reported()
      const warned = new Set<string>()
      const warnOnce = (key: string, message: string, fields: Record<string, unknown>) =>
        warned.has(key) ? Effect.void : Effect.sync(() => warned.add(key)).pipe(Effect.andThen(Effect.logWarning(message, fields)))

      const sandboxLaunch =
        deps.sandbox ??
        (async (command: ReadonlyArray<string>, launchEnv: Record<string, string>): Promise<Launch | undefined> => {
          const entries = await Effect.runPromise(config.entries())
          const settings = KeteSandbox.settingsFrom(entries, global.config, env)
          // Without an active sandbox: only when the user's global config opts in, and never when a
          // policy denies leaving the sandbox (organization statements, or the global config's own).
          const unsandboxed = async (why: string): Promise<Launch | undefined> => {
            const user = entries.filter((entry) => entry.type === "document" && userDocument(entry.path))
            const optedIn = user.some((entry) => entry.type === "document" && entry.info.kete?.lsp?.unsandboxed === true)
            const policies = [
              ...user.flatMap((entry) => (entry.type === "document" ? (entry.info.experimental?.policies ?? []) : [])),
              ...managed.current().statements,
            ]
            if (!unsandboxedAllowed({ mode: settings.mode, optedIn, policies })) {
              await Effect.runPromise(
                warnOnce(`unsandboxed ${why}`, "language servers not started: the OS sandbox isn't active", {
                  reason: why,
                  hint: "set kete.lsp.unsandboxed: true in the global config to run them without it",
                }),
              )
              return undefined
            }
            return { file: command[0]!, args: command.slice(1), env: launchEnv, release: async () => {} }
          }
          if (settings.mode === "off") return unsandboxed("the sandbox is turned off")
          const available = await Effect.runPromise(KeteSandbox.availability)
          if (!available.available) return unsandboxed(available.reason)
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
          const found = candidate[0] ? await lookup(candidate[0]) : undefined
          if (found) {
            command = [found, ...candidate.slice(1)]
            break
          }
        }
        if (!command) return undefined
        let initialization = server.initialization
        if (server.id === "typescript") {
          // Load the TypeScript installed with the server, not the project's node_modules, unless
          // the user's config names one; tsserver plugins from probe locations stay off.
          const configured = initialization?.tsserver as { path?: unknown } | undefined
          const tsserver = typeof configured?.path === "string" ? undefined : await siblingTsserver(command[0]!, workspace)
          initialization = {
            ...initialization,
            plugins: [],
            ...(tsserver ? { tsserver: { ...(initialization?.tsserver as object | undefined), path: tsserver } } : {}),
          }
        }
        const launchEnv = serverEnvironment(env, server.env)
        const launch = await sandboxLaunch(command, launchEnv)
        // Not marked broken: turning the sandbox on, or opting in, takes effect on the next edit.
        if (!launch) return undefined
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
            initialization,
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
