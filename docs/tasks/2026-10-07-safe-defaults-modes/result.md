# Result: Safe permission defaults and permission modes (Wave 0a)

## What changed
- `packages/core/src/kete/shell-risk.ts` (new): command-line tokenizer + classifier (read / build /
  other / high; unparseable = high).
- `packages/core/src/kete/permission-mode.ts`: five modes (`default`, `accept-edits`, `auto`, `ask`,
  `plan`), safe defaults applied only where upstream's catch-all allow is the winning rule, root
  session's mode for subagents, unattended families untouched (except explicit ask/plan). Still only
  tightens. No edit to upstream's agent defaults.
- `packages/util/src/kete/permission-mode.ts` (new): shared mode names, labels, descriptions, cycle.
- CLI: `--permission-mode <mode>` (`kete`, `kete run`); `--auto` = `auto` mode; the explicit bypass is
  `--dangerously-skip-permissions` (now documented) / hidden `--yolo`.
- TUI: `<leader>p` / `/mode` cycles the open session's mode; status row shows it; new sessions are
  created with the CLI's mode; a resumed session gets it once. The client-side "auto accept" label
  now reads `auto-accept`.
- Web UI (VS Code and JetBrains chat): Default / Auto / Ask / Plan toggle; Plan writes the `plan` mode
  and selects the Plan agent.
- VS Code: status bar shows any non-default mode with an honest tooltip; README, CHANGELOG
  (Unreleased), setting text.
- `kete-tools` role-check: `auto` scenarios now pass `--dangerously-skip-permissions` (same
  behaviour as before in throwaway repos).
- Docs: `docs/permissions.md` (new), `.github/README.md`, `docs/architecture.md`,
  `docs/upstream-patches.md`, `core/src/kete/skill/kete.md`, cards (permissions, cli, web-app,
  vscode-extension).
- Upstream edits (all `kete_change`-marked, recorded in `docs/upstream-patches.md`): `cli/src/commands/commands.ts`,
  `cli/src/commands/handlers/{default,run}.ts`, `cli/src/run/run.ts`, `tui/src/context/args.tsx`,
  `tui/src/app.tsx`, `tui/src/config/keybind.ts`, `tui/src/component/prompt/{index,metadata}.tsx`.

## Checks
| Check | Result |
|---|---|
| core `shell-risk`, `permission-mode`, `permission-mode-service`, `unattended-service` tests | PASS (225 + 86 + 6 + 12) |
| cli `test/kete/permission-mode.test.ts` | PASS (7) |
| tui `test/kete/permission-mode.test.tsx` | PASS (4) |
| app `bun run test:unit`, typecheck | PASS (1006 pass, 1 skip) |
| kete-vscode typecheck, test | PASS (112) |
| kete-tools typecheck, test | PASS (59) |
| root `bun run lint` | PASS |
| `upstream:check` | PASS |
| `kete-tools verify --base main` | PASS: 0 new failures (core 6178 pass / 30 fail, main 5868 / 30 — the same environment-dependent failures: Ripgrep, search tools, LocationWatcher, bash compound-syntax tests) |

## Not done / follow-ups
- MCP tool calls keep upstream's default (allowed) in every mode except `ask` does not cover them
  either; a default for MCP tools is a follow-up.
- Web fetch "Always allow" covers every URL (the tool saves `*`).
- JetBrains' default-mode setting still offers default/ask only; no Kotlin change.
- No live end-to-end run against a model (unit and real-service tests only).

## Review fixes (2026-10-08)
Independent review of PR #20: all blockers (B1–B3), should-fixes (S1–S7) and nits addressed — see
`handoff.md`'s 2026-10-08 entry and the spec amendment. New upstream edits (marked, recorded):
`core/src/tool/plugin/shell.ts` (whole line as metadata; no "Always allow" for high-risk/run-anything
commands), `core/src/tool/plugin/webfetch.ts` (per-origin save), `core/test/tool-webfetch.test.ts`,
the comment in `core/src/plugin/internal.ts`. New Kete file `core/src/kete/web-host.ts`.

| Check | Result |
|---|---|
| core `test/kete` | PASS (816) — shell-risk 309 (all review repros included), permission-mode 96, permission-mode-service 8, web-host 3 |
| core `tool-webfetch.test.ts`, `tool-shell.test.ts` | PASS except the 6 shell-tool compound-syntax tests that fail on main too |
| app `test:unit` | PASS (1006) · kete-vscode test PASS (112) |
| lint, `upstream:check --base origin/main`, `card-check` | PASS |
| `verify --base main` | 0 new failures (core 6274 pass / 30 fail vs main 5868 / 30, same environment-dependent failures) |

Still open: MCP tools outside Plan keep upstream's default (allowed); no live model run.
