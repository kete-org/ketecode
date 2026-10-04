// Replaces the upstream `uninstall` handler. The upstream command detects
// OpenCode's installers (~/.opencode/bin, `# opencode` shell-rc markers,
// OpenCode npm/brew packages), none of which Kete Code uses. Kete Code's own
// installers (ADR 0009) only place one binary, so report what to remove (or
// which package manager removes it) instead of deleting anything.
import { Brand } from "@opencode/util/kete/brand"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { handlePromptErrors } from "../ui/prompt"

export default Runtime.handler(
  Commands.commands.uninstall,
  Effect.fn("cli.uninstall")(
    function* () {
      const global = yield* Global.Service
      return yield* Effect.fail(
        new Error(
          [
            `\`${Brand.cliName} uninstall\` is not yet available for ${Brand.displayName}.`,
            `To remove ${Brand.displayName}: if you installed it with Homebrew, run \`brew uninstall ${Brand.cliName}\`;`,
            `with npm, \`npm uninstall -g ${Brand.distribution.npmPackage}\`; otherwise delete the ${Brand.cliName} binary (${process.execPath}).`,
            "Then, if you no longer need them, delete these directories:",
            ...[global.config, global.data, global.cache, global.state].map((directory) => `  ${directory}`),
          ].join("\n"),
        ),
      )
    },
    // Same user-facing error format as the upstream handlers: message only, exit code 1.
    handlePromptErrors,
  ),
)
