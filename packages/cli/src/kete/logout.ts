// `kete logout`: see ./account-flow.ts.
import { Effect } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { handlePromptErrors } from "../ui/prompt"
import { AccountFlow } from "./account-flow"
import { AccountIO } from "./account-io"

export default Runtime.handler(
  Commands.commands.logout,
  Effect.fn("cli.kete.logout")(function* () {
    const io = yield* AccountIO.make()
    yield* Effect.tryPromise({
      try: () => AccountFlow.logout(io),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(handlePromptErrors)
  }),
)
