# Handoff: Shell completions (A12)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-11 planner + implementer

**Done.** plan.md written, then built as planned.
- `kete completion [bash|zsh|fish|powershell]`: spec in `KeteCommands.specs` (`cli/src/kete/commands.ts`), handler
  `cli/src/kete/completion-command.ts`, one marked line in `cli/src/index.ts` (recorded in `docs/upstream-patches.md`).
- `cli/src/kete/completion-tree.ts`: rebuilds the command tree from the `Spec` nodes like `framework/runtime.ts`'s
  private `provide` (no handlers, same global flags) and runs Effect's parser with a capturing `Console`:
  `--completions <shell>` for bash/zsh/fish (byte-identical to `kete --completions <shell>`), and `--help` per command
  with a recording `CliOutput.Formatter` to get each command's flags (`HelpDoc.flags` + `globalFlags`).
- `cli/src/kete/completion.ts` (pure): `shells`, `instructions`, `powershell` generator (data inside the script block,
  case-sensitive ordinal tables, `,@(...)` pairs so one entry isn't flattened, skips values of non-boolean flags, `--`
  stops, PS 5.1-safe syntax).
- Tests `cli/test/kete/completion.test.ts` (9): AC1 subprocess comparison for each shell, AC3 no-shell/unknown shell,
  AC2 generated text (top-level, `mcp` subcommands, `run` flags incl. short aliases and value flags, hidden `--yolo`
  absent) and a structural test over every listed spec path; quoting.
- Docs: "Shell completions" section in `.github/README.md` (Kete-owned; no new doc, so no `isKeteOwned` change).

**Decisions.**
- Flags come from help docs, not the `Node` tree: the tree holds only `Command` values, whose flag config is reachable
  only through Effect internals (`config`, `Param.extractSingleParams`, `@internal`). Help docs are public and match
  what `--help` shows (hidden flags omitted).
- Install lines use `eval "$(kete completion bash|zsh)"` (works in macOS's bash 3.2, unlike `source <(...)`).
- PowerShell offers flags only for a word starting with `-`; otherwise subcommands, or nothing (PowerShell then falls
  back to path completion). `--no-<flag>` negations are not offered.

**Checks.** cli typecheck PASS; `bun test test/kete` 317 pass / 1 skip / 0 fail; kete-tools test 59 pass, typecheck
PASS; root lint 0/0; upstream:check passed (leaks step skipped: base is HEAD, changes uncommitted). Binary built
(`dist/cli-darwin-arm64/bin/kete`): `completion` prints the install lines (exit 0), `completion tcsh` exit 1 listing
the shells, `completion zsh` identical to `--completions zsh`; `zsh -n`/`bash -n` OK; zsh with `compinit` registers
`_kete`; bash 3.2: `kete m<Tab>` → mcp models mini, `kete mcp a<Tab>` → add auth, `kete run --mo<Tab>` → --model.

**Open.**
- AC4 not run: `pwsh` is not installed here. The PowerShell script is checked only as text; it should be loaded once
  in Windows PowerShell 5.1 and PowerShell 7 (`kete completion powershell | Out-String | Invoke-Expression`, then
  `kete m<Tab>`, `kete run --<Tab>`) before release. fish isn't installed either (its script is Effect's, compared
  byte for byte with `--completions fish`).
- Librarian: update the `cli` card (`kete completion`, the three `completion*.ts` files, why flags come from help docs).

## 2026-10-11 main session (after review: approve)
- `kete completion sh` is deliberately not accepted: `sh` is Effect's alias for the bash script, and `kete completion bash`
  covers it; `kete --completions sh` keeps working.
- Known limit: PowerShell completion checks only the current command's flags for taking a value (a parent's flag
  before the subcommand is handled only where the root lists it). Accuracy only.
- AC4 not run: `pwsh` isn't installed on the build machine. Before release, load the script once in Windows
  PowerShell 5.1 and PowerShell 7 and try `kete m<Tab>` and `kete run --<Tab>`.
