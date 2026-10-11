// `kete completion [shell]`: see ./completion.ts and ./completion-tree.ts.
import { Console, Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { KeteCompletion } from "./completion"
import { KeteCompletionTree } from "./completion-tree"

export default Runtime.handler(
  Commands.commands.completion,
  Effect.fn("cli.kete.completion")(function* (input: Runtime.Input<typeof Commands.commands.completion>) {
    if (Option.isNone(input.shell)) {
      yield* Console.log(KeteCompletion.instructions(Commands.name).join("\n"))
      return
    }
    const shell = input.shell.value
    if (shell === "powershell") {
      const tree = yield* KeteCompletionTree.describe(Commands)
      yield* Console.log(KeteCompletion.powershell(Commands.name, tree))
      return
    }
    yield* Console.log(yield* KeteCompletionTree.script(Commands, shell))
  }),
)
