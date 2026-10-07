import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import * as KetePermissionMode from "../../kete/permission-mode" // kete_change

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const { runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    // kete_change: --auto is the "auto" permission mode; --dangerously-skip-permissions is the bypass
    const permissionMode = yield* Effect.try({ try: () => KetePermissionMode.fromFlags(input), catch: (error) => (error instanceof Error ? error : new Error(String(error))) })
    const separator = process.argv.indexOf("--", 2)
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
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
      }),
    )
  }),
)
