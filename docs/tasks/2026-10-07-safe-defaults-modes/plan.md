# Plan: Safe permission defaults and permission modes

Built in one session by the implementing agent (no separate planner run); recorded after the fact.

1. `packages/core/src/kete/shell-risk.ts` (new): tokenizer (quotes, escapes, separators,
   redirections, env prefixes; fails on `$(`, backticks, subshells, heredocs, process
   substitution) and classifier tables. Test: `packages/core/test/kete/shell-risk.test.ts`.
2. `packages/util/src/kete/permission-mode.ts` (new): shared mode names, labels, descriptions,
   cycle order.
3. `packages/core/src/kete/permission-mode.ts`: modes; `decide()` (pure), `apply()` with a
   `Lookup` (session chain for the root's mode, agent + session rules + saved approvals to tell
   the catch-all allow from explicit rules, unattended check). Tests:
   `permission-mode.test.ts` (fake lookup), `permission-mode-service.test.ts` (real service +
   `ShellParse.scan`), `unattended-service.test.ts` (real mode hook always registered).
4. CLI: `packages/cli/src/kete/permission-mode.ts` (new: `fromFlags`, `skipsPermissions`, `apply`);
   marked edits in `commands/commands.ts`, `commands/handlers/{default,run}.ts`, `run/run.ts`.
   Test: `packages/cli/test/kete/permission-mode.test.ts`.
5. TUI: `packages/tui/src/kete/permission-mode.tsx` (new); marked edits in `context/args.tsx`,
   `app.tsx`, `config/keybind.ts`, `component/prompt/{index,metadata}.tsx`. Test:
   `packages/tui/test/kete/permission-mode.test.tsx`.
6. Web UI: `packages/app/src/kete/{mode.ts,composer-controls.tsx,mode.test.ts}`.
7. VS Code: `src/status.ts`, `src/extension.ts`, `test/status.test.ts`, README, CHANGELOG,
   `package.json` setting text.
8. Docs and cards; checks per CLAUDE.md §12; PR.
