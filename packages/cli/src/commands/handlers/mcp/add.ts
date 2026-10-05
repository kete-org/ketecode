import { EOL } from "node:os"
import path from "node:path"
import { readFile, stat, writeFile } from "node:fs/promises"
import { Effect, Option } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
// kete_change start
import { KeteMcpPreset } from "../../../kete/mcp-preset"
import { KeteMcpPresetIO } from "../../../kete/mcp-preset-io"
// kete_change end

export default Runtime.handler(
  Commands.commands.mcp.commands.add,
  Effect.fn("cli.mcp.add")(function* (input) {
    const url = Option.getOrUndefined(input.url)
    const headers = Option.getOrUndefined(input.header)
    const environment = Option.getOrUndefined(input.env)
    // The CLI framework strands `--` operands on the root command, so read the local server command
    // straight from argv after `--`. This also lets the command carry its own flags (e.g. `npx -y`).
    const dash = process.argv.indexOf("--")
    const command = dash === -1 ? [...input.command] : process.argv.slice(dash + 1)

    const hasCommand = command.length > 0
    // kete_change start: built-in presets (`kete mcp add harness|slack`), see kete/mcp-preset.ts
    const preset = KeteMcpPreset.route(input.name, Boolean(url) || hasCommand, KeteMcpPreset.presetFlags(presetInput(input)))
    if (preset.kind === "error") return yield* Effect.fail(new Error(preset.message))
    if (preset.kind === "preset") {
      if (environment || headers)
        return yield* Effect.fail(new Error(`--env and --header don't apply to the ${preset.name} preset`))
      const directory = input.global ? (yield* Global.Service).config : process.cwd()
      const configPath = yield* Effect.promise(() => resolveConfigPath(directory))
      const io = yield* KeteMcpPresetIO.make()
      process.exitCode = yield* Effect.tryPromise({
        try: () => KeteMcpPreset.add(io, { name: preset.name, configPath, ...presetInput(input) }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      return
    }
    // kete_change end
    if (url && hasCommand)
      return yield* Effect.fail(new Error("Provide either --url <url> or a command after --, not both"))
    if (!url && !hasCommand) return yield* Effect.fail(new Error("Provide either --url <url> or a command after --"))
    if (url && !URL.canParse(url)) return yield* Effect.fail(new Error(`Invalid URL: ${url}`))
    if (url && environment) return yield* Effect.fail(new Error("--env is only valid for local MCP servers"))
    if (hasCommand && headers) return yield* Effect.fail(new Error("--header is only valid for remote MCP servers"))

    const server = url
      ? { type: "remote" as const, url, ...(headers ? { headers } : {}) }
      : { type: "local" as const, command, ...(environment ? { environment } : {}) }

    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(input.global ? global.config : process.cwd()))
    yield* Effect.promise(() => write(configPath, input.name, server))
    process.stdout.write(`MCP server "${input.name}" added to ${configPath}` + EOL)
  }),
)

export async function resolveConfigPath(directory: string) {
  const candidates = [
    // kete_change start
    ...Brand.configFiles.map((name) => path.join(directory, name)),
    ...Brand.configFiles.map((name) => path.join(directory, Brand.projectDirectory, name)),
    // kete_change end
  ]
  for (const candidate of candidates) {
    if (
      await stat(candidate).then(
        (info) => info.isFile(),
        () => false,
      )
    )
      return candidate
  }
  return candidates[0]
}

async function write(configPath: string, name: string, server: unknown) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}"
    throw error
  })
  const edits = modify(text, ["mcp", "servers", name], server, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  await writeFile(configPath, applyEdits(text, edits))
}

// kete_change start
function presetInput(input: {
  readonly write: boolean
  readonly org: Option.Option<string>
  readonly project: Option.Option<string>
  readonly baseUrl: Option.Option<string>
  readonly clientId: Option.Option<string>
}) {
  return {
    write: input.write,
    org: Option.getOrUndefined(input.org),
    project: Option.getOrUndefined(input.project),
    baseUrl: Option.getOrUndefined(input.baseUrl),
    clientId: Option.getOrUndefined(input.clientId),
  }
}
// kete_change end
