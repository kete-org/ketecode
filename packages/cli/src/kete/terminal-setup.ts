// `kete terminal-setup`: the real dependencies for ./terminal-setup-flow.ts.
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { KeteTerminalSetupFlow } from "./terminal-setup-flow"

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.kete-${process.pid}.tmp`
  await fs.writeFile(temporary, text, { mode: 0o600 })
  await fs.rename(temporary, file).catch(async (error: unknown) => {
    await fs.rm(temporary, { force: true })
    throw error
  })
}

export default Runtime.handler(
  Commands.commands["terminal-setup"],
  Effect.fn("cli.kete.terminal-setup")(function* (input: Runtime.Input<(typeof Commands.commands)["terminal-setup"]>) {
    const code = yield* Effect.promise(() =>
      KeteTerminalSetupFlow.run(
        {
          env: process.env,
          platform: process.platform,
          home: Global.Path.home,
          join: path.join,
          read: (file) =>
            fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined
              throw error
            }),
          write,
          copy: (from, to) => fs.copyFile(from, to),
          now: () => new Date(),
          interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
          confirm: async (message) => {
            const { confirm, isCancel } = await import("@clack/prompts")
            const answer = await confirm({ message, initialValue: true })
            return !isCancel(answer) && answer === true
          },
          out: (text) => process.stdout.write(text + "\n"),
          err: (text) => process.stderr.write(text + "\n"),
        },
        { editor: Option.getOrUndefined(input.editor), yes: input.yes, print: input.print },
      ),
    )
    process.exitCode = code
  }),
)
