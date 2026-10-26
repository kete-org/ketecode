// `kete completion`: the Effect side. Builds the CLI's real command tree from the `Spec` nodes (the
// same shape `framework/runtime.ts` runs, without handlers) and asks Effect's own parser for output:
// `--completions <shell>` for bash, zsh and fish (so `kete completion zsh` is exactly `kete
// --completions zsh`), and each command's `--help` doc for the PowerShell tree. A command's flags are
// only reachable through Effect internals otherwise; the help doc is the public route.
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/cli"
import { PrintLogs } from "../commands/commands"
import type { Spec } from "../framework/spec"
import { KeteCommands } from "./commands"
import type { KeteCompletion } from "./completion"

// No handlers, so nothing is required to run it (only `--help` and `--completions` are ever run).
type Built = Command.Command<string, unknown, unknown, unknown, never>

// Mirrors `provide` in framework/runtime.ts: subcommands, then the extra alias nodes as siblings.
function attach(node: Spec.Any): Built {
  const children = Object.values(node.commands)
  if (children.length === 0) return node.spec as Built
  return node.spec.pipe(
    Command.withSubcommands([
      ...children.map((child) => attach(child)),
      ...children.flatMap((child) => child.aliases.map((alias) => attach(alias))),
    ]),
  ) as Built
}

/** The root command as the CLI runs it (`Runtime.run`'s global flags), minus the handlers. */
export function build(root: Spec.Any): Built {
  return attach(root).pipe(Command.withGlobalFlags([PrintLogs, KeteCommands.Offline])) as Built
}

export interface Captured {
  readonly stdout: string
  readonly stderr: string
  readonly docs: ReadonlyArray<HelpDoc.HelpDoc>
}

function capturing(out: string[], err: string[]): Console.Console {
  const text = (args: ReadonlyArray<unknown>) => args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ")
  const write = (target: string[]) => (...args: ReadonlyArray<unknown>) => {
    target.push(text(args))
  }
  const ignore = () => {}
  return {
    assert: ignore,
    clear: ignore,
    count: ignore,
    countReset: ignore,
    debug: write(err),
    dir: write(out),
    dirxml: write(out),
    error: write(err),
    group: ignore,
    groupCollapsed: ignore,
    groupEnd: ignore,
    info: write(out),
    log: write(out),
    table: write(out),
    time: ignore,
    timeEnd: ignore,
    timeLog: ignore,
    trace: write(err),
    warn: write(err),
  }
}

/** Runs the parser on `argv` with its console output and help docs captured instead of printed. */
export function capture(command: Built, argv: ReadonlyArray<string>, version = "0") {
  const out: string[] = []
  const err: string[] = []
  const docs: HelpDoc.HelpDoc[] = []
  const base = CliOutput.defaultFormatter({ colors: false })
  const formatter: CliOutput.Formatter = {
    ...base,
    formatHelpDoc: (doc) => {
      docs.push(doc)
      return base.formatHelpDoc(doc)
    },
  }
  return Command.runWith(command, { version })(argv).pipe(
    Effect.provideService(CliOutput.Formatter, formatter),
    Effect.provideService(Console.Console, capturing(out, err)),
    Effect.provide(NodeServices.layer),
    Effect.map((): Captured => ({ stdout: out.join("\n"), stderr: err.join("\n"), docs })),
  )
}

/** Effect's script for bash, zsh or fish: the output of `--completions <shell>` on the real tree. */
export const script = Effect.fn("cli.kete.completion.script")(function* (
  root: Spec.Any,
  shell: Exclude<KeteCompletion.Shell, "powershell">,
) {
  const result = yield* capture(build(root), ["--completions", shell])
  if (result.stderr.length > 0 || result.stdout.length === 0)
    return yield* Effect.fail(new Error(`could not generate the ${shell} completion script: ${result.stderr || "no output"}`))
  return result.stdout
})

const spelling = (alias: string) => (alias.startsWith("-") ? alias : alias.length === 1 ? `-${alias}` : `--${alias}`)

function flags(doc: HelpDoc.HelpDoc): ReadonlyArray<KeteCompletion.Flag> {
  const seen = new Set<string>()
  const result: KeteCompletion.Flag[] = []
  for (const flag of [...doc.flags, ...(doc.globalFlags ?? [])]) {
    if (seen.has(flag.name)) continue
    seen.add(flag.name)
    result.push({
      // Help docs give the name bare (`model`) and aliases as typed (`-m`).
      names: [`--${flag.name}`, ...flag.aliases.map(spelling)],
      description: flag.description._tag === "Some" ? flag.description.value : "",
      value: flag.type !== "boolean",
    })
  }
  return result
}

type CaptureError = Effect.Error<ReturnType<typeof capture>>

/** The command tree for the PowerShell script: names and aliases from the spec, flags from `--help`. */
export function describe(root: Spec.Any) {
  const command = build(root)
  const visit = (node: Spec.Any, path: ReadonlyArray<string>): Effect.Effect<KeteCompletion.Tree, CaptureError | Error> =>
    Effect.gen(function* () {
      const result = yield* capture(command, [...path, "--help"])
      const doc = result.docs.at(-1)
      if (!doc) return yield* Effect.fail(new Error(`no help for \`${[root.name, ...path].join(" ")}\`: ${result.stderr}`))
      const commands: KeteCompletion.Tree[] = []
      for (const child of Object.values(node.commands)) {
        if (child.spec.unlisted) continue
        commands.push(yield* visit(child, [...path, child.name]))
      }
      return {
        name: node.name,
        aliases: [...(node.spec.alias ? [node.spec.alias] : []), ...node.aliases.map((alias) => alias.name)],
        description: node.spec.shortDescription ?? node.spec.description ?? "",
        flags: flags(doc),
        commands,
      }
    })
  return visit(root, []).pipe(Effect.withSpan("cli.kete.completion.describe"))
}

export * as KeteCompletionTree from "./completion-tree"
