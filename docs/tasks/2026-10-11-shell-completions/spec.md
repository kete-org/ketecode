# Spec: Shell completions (A12)

- Task: `docs/tasks/2026-10-11-shell-completions` · Size: medium · Created: 2026-10-11
- Status: agreed (Milestone A, approved 2026-10-10 with merge-when-green; plan item A12)

## Goal
Tab completion for `kete` commands and flags in every shell people use, discoverable and documented.

## Today (verified 2026-10-11)
`kete --completions <bash|zsh|fish|sh>` already prints a completion script generated from the real command
tree (Effect CLI's built-in `GlobalFlag.Completions`; listed in `kete --help`). Nothing documents it, there is
no `kete completion` command (Codex's spelling), and there is no PowerShell script, so Windows users get none.
Effect builds its command descriptor internally (`effect/unstable/cli/internal/completions/descriptor.js`,
not exported).

## Scope
Modules: `cli`.
1. `kete completion <shell>` prints the script for `bash`, `zsh`, `fish` (Effect's generator, same output as
   `--completions`) and `powershell` (new). With no shell, print short install instructions for each.
2. **PowerShell generator** (Kete-owned, `cli/src/kete/completion*.ts`): walks Kete's command spec
   (`cli/src/framework/spec.ts` `Node` tree from `commands.ts` `Root`) for subcommands, their aliases and
   flags, and emits a `Register-ArgumentCompleter -Native -CommandName kete` script completing subcommands at
   each level and flags (long and short) for the current command. Don't import Effect internals.
3. **Docs:** a "Shell completions" section in the CLI docs (where `kete` commands are documented for users;
   the README if no better place) with the one-line install for each shell (`~/.zshrc`, `~/.bashrc`,
   fish's `completions/` dir, PowerShell `$PROFILE`).
4. `--completions` keeps working unchanged.

## Out of scope
Completing dynamic values (session IDs, model names, MCP server names).

## Acceptance criteria
- [ ] AC1: `kete completion zsh|bash|fish` print the same scripts as `kete --completions <shell>` (test).
- [ ] AC2: `kete completion powershell` prints a script that registers a native completer for `kete`, lists the
  top-level commands (including `run`, `trust` if present, `mcp`, `session`) and the subcommands of a nested
  command (e.g. `mcp add`), and the flags of `run` (test on the generated text; plus a structural test that
  every command in the spec appears).
- [ ] AC3: `kete completion` with no shell prints install lines for all four shells and exits 0; an unknown
  shell exits non-zero with the list of supported shells.
- [ ] AC4: if `pwsh` is installed, load the script and check completions for `kete m<Tab>` and
  `kete run --<Tab>` (skip with a note when it isn't).
- [ ] AC5: `packages/cli` typecheck and `bun test test/kete` pass; root lint; `upstream:check` (the command is
  registered with one marked line in `commands.ts`, or through `kete/commands.ts`).

## Risks and constraints
- New CLI command = contract (§12): name and output stable once released.
- Cross-platform: the PowerShell script must work in Windows PowerShell 5.1 and PowerShell 7.
- Upstream: prefer registering through the existing Kete commands module so `commands.ts` gets at most one
  marked line.
