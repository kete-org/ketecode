// `kete terminal-setup`: the real dependencies for ./terminal-setup-flow.ts.
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { KeteTerminalSetupFlow } from "./terminal-setup-flow"

export async function write(file: string, text: string) {
  // Follow a symlink (dotfiles) so the rename replaces its target, not the link; keep the file's mode.
  const target = await fs.realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return file
    throw error
  })
  const mode = await fs.stat(target).then(
    (stat) => stat.mode & 0o777,
    () => 0o600,
  )
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.kete-${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode })
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
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
