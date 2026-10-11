# Plan: Shell completions (A12)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

## Cards read
- docs/context/modules/cli.md (verified-at f85913ed4a), docs/context/pitfalls.md

## Findings that shape the plan
- `--completions` is Effect's `GlobalFlag.Completions`: it builds a descriptor from the **root** command
  (`internal/completions/descriptor.js`, not exported) and calls the public `Completions.generate`.
- The `Spec.Node` tree keeps only `Command` values; a command's flags are reachable only through Effect
  internals (`config`, `Param.extractSingleParams`, both `@internal`). The public route to a command's
  flags is its help doc: `CliOutput.Formatter.formatHelpDoc(doc: HelpDoc)` receives `HelpDoc.flags` /
  `globalFlags` (`FlagDoc`: name, aliases, type, description) when `--help` runs.
- Subcommands are attached to the specs only in `framework/runtime.ts`'s private `provide`.

## Design
- `kete completion [shell]` (`shell`: choice `bash|zsh|fish|powershell`, optional) in `KeteCommands.specs`
  (so `commands.ts` is untouched); handler line in `index.ts` (one marked line).
- `kete/completion-tree.ts` (Effect side, public APIs only): `build(node)` mirrors `provide` without
  handlers (subcommands + alias siblings, global flags `PrintLogs` and `Offline`); `capture(command, argv)`
  runs `Command.runWith` with a capturing `Console` and a `Formatter` that records help docs;
  `script(root, shell)` = captured output of `["--completions", shell]` (same generator, same tree, so the
  same text); `describe(root)` walks the `Node` tree (names, `spec.alias`, extra alias nodes, skipping
  `unlisted`) and takes each command's flags from its captured `--help` doc.
- `kete/completion.ts` (pure): `shells`, `Tree` types, `powershell(name, tree)` and `instructions(name)`.
  The PowerShell script is one `Register-ArgumentCompleter -Native` with its data inside the script block
  (no globals), walks `$commandAst.CommandElements` before the cursor (skipping values of non-boolean
  flags, stopping at `--`), offers subcommands, or flags when the word starts with `-`; PS 5.1-safe syntax
  (`[ordered]@{}`, `::new`, no `?.`/ternaries); single-quote escaping incl. typographic quotes.
- `kete/completion-command.ts`: handler. No shell → instructions (exit 0). Unknown shell → parser error
  (non-zero, lists the choices).

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/cli/src/kete/commands.ts` | change | `completion` spec |
| `packages/cli/src/kete/completion.ts` | new | PowerShell generator, instructions |
| `packages/cli/src/kete/completion-tree.ts` | new | tree build, capture, describe |
| `packages/cli/src/kete/completion-command.ts` | new | handler |
| `packages/cli/src/index.ts` | change (1 marked line) | handler registration |
| `packages/cli/test/kete/completion.test.ts` | new | AC1–AC3 |
| `.github/README.md` | change | "Shell completions" section (Kete-owned) |
| `docs/upstream-patches.md` | append | `index.ts` handler line |

## Steps
1. Spec + pure generator + tree/capture + handler + index line.
2. Tests: subprocess `completion <sh>` vs `--completions <sh>` (AC1); generated PowerShell text (AC2,
   including every listed command path from the `Node` tree); no-shell and unknown shell (AC3).
3. README section, upstream-patches entry.
4. Checks; build the binary; smoke-run; `zsh -n`/`bash -n` and a non-interactive source of the scripts.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun test test/kete/completion.test.ts` (packages/cli) |
| AC2 | same file (PowerShell text + structural test) |
| AC3 | same file (subprocess exit codes and output) |
| AC4 | `which pwsh` — not installed on this machine: skipped with a note |
| AC5 | `bun run typecheck`, `bun test test/kete` (packages/cli); root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check` |

## Cards to update after the build
- `docs/context/modules/cli.md`: `kete completion`, `completion*.ts` files, Quick answer on why flags come from help docs.
