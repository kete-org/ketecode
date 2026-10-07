# Spec: Safe permission defaults and permission modes (Wave 0a)

- Task: `docs/tasks/2026-10-07-safe-defaults-modes` · Size: large · Created: 2026-10-07
- Status: approved (maintainer approved the competitive program 2026-10-07: "proceed and implement all")

## Goal
Make Kete Code's interactive behaviour match what the README and CLAUDE.md §9 promise: it asks
before shell commands that can change things and always before high-risk operations, instead of
inheriting upstream's allow-everything default agent. Give users explicit, honest permission modes
across the CLI, TUI, web UI and editor extensions.

## Problem (verified)
Upstream's default agent (`packages/schema/src/agent.ts`) starts with `{ action: "*", resource:
"*", effect: "allow" }`; only `external_directory` and `.env` reads ask. Outside unattended job
mode, shell commands, edits, `git push`, deletes and package installs ran without asking.
`--auto` (and the hidden `--dangerously-skip-permissions`/`--yolo`) made the client approve every
request.

## Scope
1. **Safe defaults** for interactive sessions, layered on the existing `evaluate` seam in
   `core/src/kete/permission-mode.ts` (no edit to upstream's agent defaults): read-only tools allow;
   edits in the workspace allow; shell commands classified by a new `core/src/kete/shell-risk.ts`
   (read / build / other / high; unparseable = high): read and test/build allow, other asks, high
   asks; web fetch/search ask. Only where upstream's catch-all allow is the matching rule: explicit
   rules (agent, user/project config, session, saved "always") keep their effect. Org/config
   policies (later hooks) can still deny; a configured deny is decided before the hook.
   Unattended families keep their own policy unchanged.
2. **Modes** (`kete.permissionMode`, `KETE_PERMISSION_MODE`, backward compatible with
   `default`/`ask`): `default`, `accept-edits` (= default, since default already allows edits),
   `auto` (edits, other commands and web allowed; high-risk still asks — not a bypass), `ask`
   (every edit/command/web request asks, even explicit allows), `plan` (read-only: edits and
   non-read-only commands denied). Subagents follow the root session's mode. Only tightens.
3. **Surfaces**: CLI `--permission-mode <mode>` for `kete` and `kete run`; `--auto` = `auto` mode;
   `--dangerously-skip-permissions` stays the explicit client-side bypass (now documented, not
   hidden). TUI: `<leader>p` / `/mode` cycles the open session's mode, status row shows it, new
   sessions get the CLI mode atomically. Web UI (shared by VS Code and JetBrains chat): toggle
   Default/Auto/Ask/Plan; Plan writes the `plan` mode and selects the Plan agent. VS Code status bar
   shows the mode; README/CHANGELOG/setting text updated. JetBrains: no Kotlin change (its chat is
   the web UI; its default-mode setting stays default/ask).
4. **Docs**: `.github/README.md`, new `docs/permissions.md`, `docs/architecture.md`,
   `docs/upstream-patches.md`, context cards.
5. **Tests**: classifier table, per-mode decisions, explicit/org rules, saved approvals, subagent
   inheritance, unattended unaffected, real-service tests with the shell tool's own parser, CLI,
   TUI, web and extension tests.

## Out of scope
- MCP tool calls and other non-shell mutation paths keep upstream's defaults (allowed) — noted as
  follow-up.
- Per-host "always" for web fetch (the tool saves `*`; an "Always allow" covers every URL).
- Server/protocol changes (none needed: metadata is free-form).

## Acceptance criteria
- AC1 default mode: `git push`, `rm`, `npm install`, `curl`, `docker`, `psql`, `sudo`, writes outside
  the workspace, unparseable commands ask; `ls`, `git status`, `npm test`, `bun run typecheck` run;
  edits run; web fetch asks.
- AC2 each mode's table holds (docs/permissions.md).
- AC3 explicit allow rules and saved approvals loosen; a configured or org deny always wins.
- AC4 subagents follow the root's mode; unattended runs' decisions are unchanged.
- AC5 `--permission-mode`, `--auto`, `<leader>p`, the web toggle and the VS Code status bar work as
  documented.
