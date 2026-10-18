// The shell interpolations in a slash command's template (``!`git diff` ``, config/plugin/command.ts
// `evaluateTemplate`) run the way the agent's shell tool runs a command (tool/plugin/shell.ts): the
// permission check for `shell` (so the permission modes, the shell-risk rules and policy apply, through
// the same hooks), a working directory and `cd` targets inside the workspace, the unattended credential
// filter, and the local OS sandbox. Before this, they ran directly. A project's command in a folder that
// isn't trusted runs none of them (`skipped`): commands load in any folder (docs/folder-trust.md), and
// their text must not be able to run code before a person trusts the folder.

export * as KeteCommandShell from "./command-shell.js"

import { createHash } from "crypto"
import path from "path"
import { AppProcess } from "@opencode/util/process"
import { Global } from "@opencode/util/global"
import { Effect, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config.js"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { Shell } from "../shell.js"
import { ShellParse } from "../shell/parse.js"
import { ShellSelect } from "../shell/select.js"
import { KeteFolderTrust } from "./folder-trust.js"
import { KeteSandbox } from "./sandbox.js"
import { KeteShellRisk } from "./shell-risk.js"
import { KeteToolEnv } from "./tool-env.js"

/** Bounded like any subprocess: an interpolation that hangs fails the command instead of holding it. */
export const TIMEOUT = "2 minutes"

/** What replaces an interpolation that a project's command may not run in an untrusted folder. */
export function skipped(source: string) {
  return `[not run: \`${source}\` (this folder's commands can't run shell commands until you trust it: \`kete trust add\`)]`
}

/** The file a markdown command came from, with the sha256 of the text it was decoded from. */
export interface Source {
  readonly file: string
  readonly sha256: string
}

/** A decoded markdown command with its `Source` (`undefined` stays `undefined`). */
export function withFile<A extends object>(command: A | undefined, file: string, text: string): (A & { readonly file: Source }) | undefined {
  return command === undefined ? undefined : { ...command, file: { file, sha256: createHash("sha256").update(text, "utf8").digest("hex") } }
}

/** At most this much of an interpolation's output goes into the prompt. */
export const MAX_OUTPUT = 30_000

export function bounded(output: string) {
  return output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]` : output
}

/** Where a command came from: the machine's own config, or a project's (repository) config. */
export type Origin = "machine" | "project"

/** The origin of the commands in one config entry. A document whose file the folder-trust gate didn't
 * read as a machine file, and any directory but the global config directory, is a project's. */
export function origin(entry: { readonly type: string; readonly path?: string }, globalConfig: string, machineFiles: ReadonlySet<string>): Origin {
  if (entry.path === undefined) return "machine" // OPENCODE_CONFIG_CONTENT and well-known (organization) config
  if (entry.type === "directory") return path.resolve(entry.path) === path.resolve(globalConfig) ? "machine" : "project"
  return machineFiles.has(entry.path) ? "machine" : "project"
}

export const make = Effect.fn("KeteCommandShell.make")(function* () {
  const config = yield* Config.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const processes = yield* AppProcess.Service
  // Present in every runtime location (plugin/internal.ts). Without them nothing runs: fail closed.
  const checks = Option.all({
    permission: yield* Effect.serviceOption(Permission.Service),
    access: yield* Effect.serviceOption(FileAccess.Service),
    sessions: yield* Effect.serviceOption(Session.Service),
  })
  const folderTrust = yield* Effect.serviceOption(KeteFolderTrust.Service)
  const sandbox = KeteSandbox.make({
    config,
    global,
    location: { workspace: location.project.directory, directory: location.directory, projectID: location.project.id },
    shellDirectory: path.join(global.data, Shell.DIRECTORY),
  })

  /** Whether a project's command (from `file`, or a project document) may run its interpolations here.
   * No folder-trust service fails closed. */
  const projectAllowed = (file: Source | undefined) =>
    Option.match(folderTrust, {
      onNone: () => Effect.succeed(false),
      onSome: (trust) => trust.commandAllowed(file),
    })

  /** The machine files the last load read; everything else with a path is a project's. */
  const machineFiles = Option.match(folderTrust, {
    onNone: () => Effect.succeed(new Set<string>()),
    onSome: (trust) =>
      Effect.map(trust.configFiles(), (files) => new Set(files.read.filter((file) => !file.project).map((file) => file.path))),
  })

  const run = Effect.fn("KeteCommandShell.run")(function* (input: {
    readonly source: string
    readonly shell: string
    readonly sessionID: SessionSchema.ID
  }) {
    if (Option.isNone(checks))
      return yield* Effect.fail(new Error("Kete Code can't check permission for a command's shell interpolation here, so it didn't run."))
    const { permission, access, sessions } = checks.value
    const toolEnv: KeteToolEnv.Lookup = {
      session: (id) => sessions.get(id).pipe(Effect.option),
      config: Effect.map(config.entries(), (entries) => Config.latest(entries, "kete")),
    }
    const cwd = location.directory
    const portable = Config.latest(yield* config.entries(), "experimental")?.portable_shell_scanner === true
    const parsed = yield* ShellParse.scan(input.source, input.shell, cwd, { portable })
    // A `cd` out of the workspace would need the external-directory question, which belongs to a tool
    // call; a command template doesn't get to leave the workspace.
    const directories = yield* Effect.forEach(parsed.directories, (directory) =>
      access.resolve({ path: FileAccess.resolvePath(cwd, directory), kind: "directory" }),
    )
    const outside = directories.find((target) => target.externalDirectory !== undefined)
    if (outside) return yield* Effect.fail(new Error(`A command's shell interpolation can't change to a folder outside the workspace: ${input.source}`))
    const metadata: Record<string, unknown> = { command: input.source }
    if (parsed.commands.length > 0)
      yield* permission.assert({
        action: "shell",
        resources: parsed.commands.map((command) => command.resource),
        save: parsed.commands.every((command) => KeteShellRisk.saveable(command.resource)) ? parsed.commands.map((command) => command.save) : [],
        metadata,
        sessionID: input.sessionID,
      })
    const invocation: { cwd: string; env: Record<string, string | undefined> } = { cwd, env: { ...process.env } }
    KeteSandbox.remember(invocation, metadata)
    invocation.env = yield* KeteToolEnv.forSession(toolEnv, input.sessionID, invocation.env)
    const prepared = yield* sandbox.prepare(invocation, input.sessionID, undefined, ({ action, reason }) =>
      permission.assert({
        action,
        resources: [input.source],
        save: [],
        metadata: { command: input.source, ...(reason ? { reason } : {}) },
        sessionID: input.sessionID,
      }),
    )
    const command = KeteSandbox.wrap(invocation, input.shell, ShellSelect.args(input.shell, input.source))
    return yield* processes
      .run(ChildProcess.make(command.file, command.args, { cwd, env: invocation.env, stdin: "ignore" }), { combineOutput: true })
      .pipe(
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(new Error(`A command's shell interpolation took longer than ${TIMEOUT}: ${input.source}`)),
        }),
        Effect.map((result) => bounded((result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8"))),
        Effect.ensuring(prepared.release),
      )
  })

  /** Where one config entry's commands came from (`origin`). */
  const originOf = (entry: { readonly type: string; readonly path?: string }) =>
    Effect.map(machineFiles, (files) => origin(entry, global.config, files))

  /** Runs one interpolation of a command from `from`, or returns `skipped` for a project's command in a
   * folder that isn't trusted. */
  const interpolate = Effect.fn("KeteCommandShell.interpolate")(function* (input: {
    readonly source: string
    readonly shell: string
    readonly sessionID: SessionSchema.ID
    readonly from: Origin
    /** The command's markdown file and text hash; `undefined` for a command a config document defines. */
    readonly file?: Source
  }) {
    if (input.from === "project" && !(yield* projectAllowed(input.file))) return skipped(input.source)
    return yield* run(input)
  })

  return { interpolate, originOf }
})
