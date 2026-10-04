// `kete whoami`: see ./account-flow.ts.
import { Effect } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { handlePromptErrors } from "../ui/prompt"
import { AccountFlow } from "./account-flow"
import { AccountIO } from "./account-io"

export default Runtime.handler(
  Commands.commands.whoami,
  Effect.fn("cli.kete.whoami")(function* (input: Runtime.Input<typeof Commands.commands.whoami>) {
    const io = yield* AccountIO.make()
    yield* Effect.tryPromise({
      try: () => (input.format === "json" ? AccountFlow.whoamiJSON(io) : AccountFlow.whoami(io)),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(handlePromptErrors)
  }),
)
