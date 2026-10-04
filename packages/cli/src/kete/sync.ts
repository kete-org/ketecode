// `kete sync`: see ./account-flow.ts (sync) and @opencode/util/kete/sync.
import { Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { handlePromptErrors } from "../ui/prompt"
import { AccountFlow } from "./account-flow"
import { AccountIO } from "./account-io"

export default Runtime.handler(
  Commands.commands.sync,
  Effect.fn("cli.kete.sync")(function* (input: Runtime.Input<typeof Commands.commands.sync>) {
    const io = yield* AccountIO.make()
    yield* Effect.tryPromise({
      try: async () => {
        if (input.status) await AccountFlow.syncStatus(io, { json: input.format === "json" })
        else await AccountFlow.sync(io, { approve: Option.getOrUndefined(input.approve), command: Option.getOrUndefined(input.command) })
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(handlePromptErrors)
  }),
)
