import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import * as KetePermissionMode from "../../kete/permission-mode" // kete_change
import { KeteAddDirCli } from "../../kete/add-dir" // kete_change
import { KeteFolderTrustCli } from "../../kete/folder-trust" // kete_change
import { KeteJobProjectConfig } from "../../kete/job-project-config" // kete_change

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const { runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    // kete_change: --auto is the "auto" permission mode; --dangerously-skip-permissions is the bypass
    const permissionMode = yield* Effect.try({ try: () => KetePermissionMode.fromFlags(input), catch: (error) => (error instanceof Error ? error : new Error(String(error))) })
    const addDirs = yield* Effect.try({ try: () => KeteAddDirCli.prepare(input.addDir), catch: (error) => (error instanceof Error ? error : new Error(String(error))) }) // kete_change: --add-dir folders as absolute paths; refused in a job
    const separator = process.argv.indexOf("--", 2)
    // kete_change start: --trust-project-config trusts the folder for this run, on a private server (kete/folder-trust.ts)
    const trustProjectConfig = KeteJobProjectConfig.trusted(input.trustProjectConfig, process.env)
    const trust = KeteFolderTrustCli.connection(
      { server: Option.getOrUndefined(input.server), standalone: input.standalone },
      trustProjectConfig,
      "run",
    )
    if (!trust.ok) return yield* Effect.fail(new Error(trust.message))
    // kete_change end
    const server = yield* ServerConnection.resolve({
      server: trust.args.server, // kete_change
      standalone: trust.args.standalone, // kete_change
    })
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        message: [...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))],
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format: input.format,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        auto: KetePermissionMode.skipsPermissions(input), // kete_change
        permissionMode, // kete_change
        addDirs, // kete_change
        trustProjectConfig, // kete_change
      }),
    )
  }),
)
