// `kete login`: see ./account-flow.ts.
import { Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { handlePromptErrors, openUrl } from "../ui/prompt"
import { AccountFlow } from "./account-flow"
import { AccountIO } from "./account-io"

export default Runtime.handler(
  Commands.commands.login,
  Effect.fn("cli.kete.login")(function* (input: Runtime.Input<typeof Commands.commands.login>) {
    const io = yield* AccountIO.make()
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    yield* Effect.tryPromise({
      try: () =>
        AccountFlow.login(io, {
          platformURL: Option.getOrUndefined(input.platformUrl),
          port: Option.getOrUndefined(input.port),
          open: input.noBrowser ? undefined : (url) => run(openUrl(url)),
          ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(handlePromptErrors)
  }),
)
