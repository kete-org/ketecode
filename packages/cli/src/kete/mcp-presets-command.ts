// `kete mcp presets`: see ./mcp-preset.ts.
import { EOL } from "node:os"
import { Effect } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { KeteMcpPreset } from "./mcp-preset"

export default Runtime.handler(
  Commands.commands.mcp.commands.presets,
  Effect.fn("cli.kete.mcp.presets")(function* () {
    KeteMcpPreset.list({ print: (line) => process.stdout.write(line + EOL), environment: process.env })
  }),
)
