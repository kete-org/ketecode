# Plan: Wave 1a — todo list, LSP diagnostics, config shell hooks

Built in one session by one agent (no separate planner), as three PRs, each branch created from the
previous one and targeting `main` (so a merged base never closes the next PR).

## PR 1 — todo (`feature/wave1a-todo`)
1. `schema/src/kete/todo.ts`: `KeteTodoRpc` (item/list/bounds, RPC `get`, event `updated`, helpers).
2. `core/src/kete/todo.ts`: `todowrite` tool (validation, `permission.assert`, storage, event), RPC,
   context guidance, `session.deleted` cleanup; register in `plugin/internal.ts` (marked);
   `todowrite` in `KetePermissionMode.planAllowed`.
3. TUI `tui/src/kete/todo.tsx` (sidebar + footer), registered in `tui/src/plugin/builtins.ts` (marked).
4. Web `app/src/kete/todo.ts` + `todo-dock.tsx` + `panel.css`; `composer/composer.tsx` (marked).
5. Tests: `core/test/kete/todo.test.ts`, `tui/test/kete/todo.test.tsx`, `app/src/kete/todo.test.ts`.
6. Docs: `docs/todo.md`, card `todo`, INDEX, `upstream-patches.md`, VS Code/JetBrains READMEs.

## PR 2 — LSP (`feature/wave1a-lsp`)
1. `core/src/kete/lsp/`: JSON-RPC stdio client, server catalogue (typescript, pyright, gopls,
   rust-analyzer; PATH lookup only), root detection, diagnostics formatting/dedupe, manager with lazy
   start, idle/exit handling and shutdown; spawn guarded by `KeteJobMode.refuseSpawn`, classified in
   `job-spawn-sites.test.ts`; sandbox wrapping without network when available.
2. `KeteLsp.Plugin`: `tool.execute.after` for `edit`/`write`/`patch` → touched files → diagnostics →
   appended to the result; reads the upstream `lsp` key; off in job mode.
3. Tests with a fake language server (Node script); docs `docs/lsp.md`, card, patches.

## PR 3 — hooks (`feature/wave1a-hooks`)
1. Schema `ConfigKete.Hooks` (`kete.hooks`), protocol + client regeneration.
2. `core/src/kete/hooks/`: settings per document (global vs project), runner (shell, stdin JSON,
   timeout, output bounds), trust store (state dir, repo + sha256) and trust form, plugin wiring for
   the six events, policy action `hooks`, job-mode exclusion; `kete job run` refuses project hooks
   without `--trust-project-config`.
3. Tests; docs `docs/hooks.md`, card, patches.

Verify per PR: package typechecks and tests (core/server via their scripts), app unit tests, root
lint, `upstream:check`, protocol/client `check:generated` (PR 3), `verify --base main`, CI.
