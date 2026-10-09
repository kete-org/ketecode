# Spec: Wave 1a — todo list, LSP diagnostics, config shell hooks

- Task: `docs/tasks/2026-10-10-wave1a` · Size: large · Created: 2026-10-10
- Status: approved (maintainer approved the competitive program: "proceed and implement all"; recommended options followed)

## Goal
Three agent capabilities that OpenCode v2 does not ship and that users expect from a coding agent:
a session task list the agent keeps current, compiler/linter feedback from language servers after
edits, and user-configured shell hooks around the agent loop. Independent design; not copied from
any proprietary product.

## Upstream check (CLAUDE.md §4)
- Todo: upstream v2 had a `todowrite` tool and removed it (`7feefb697f`, "refactor: remove todo
  tool", #35989, 150+ files incl. a DB table and the app's todo dock). Re-adding it by revert would
  touch dozens of upstream files on an architecture that has since moved (built-in tools became
  internal plugins). Kete re-adds it as a Kete plugin with the same tool name and item shape
  (`content`, `status`, `priority`) so the leftover upstream bits that still know `todowrite`
  (session-ui's title/icon) keep working.
- LSP: v2 has no runtime LSP (`file-mutation.ts`, `edit.ts`, `write.ts` TODOs) but keeps the
  `lsp` config key (`schema/src/config/lsp.ts`, normalized in `config/normalize.ts`) unused. Kete
  implements the runtime behind that existing key. v1's client (`packages/opencode/src/lsp`, tag
  v1.4.9) is the reference for the protocol flow (open/change, publishDiagnostics debounce, error
  report format); its server catalogue downloads binaries, which we don't do.
- Hooks: v2 has TypeScript plugin hooks (`tool.execute.before/after`, `session.prompt`, events).
  Config hooks are a built-in plugin on that system.

## Scope (three PRs, in this order)
1. **Todo** — `todowrite` tool (whole-list replace; statuses pending/in_progress/completed; at
   most one in_progress; bounded), persisted per session (plugin storage, SQLite KV), `kete.todo`
   plugin RPC (`get`, event `updated`) — no new HTTP endpoint, so no protocol change; small system
   guidance; Plan mode allows it; TUI sidebar list + prompt-footer progress; web UI / VS Code /
   JetBrains dock above the composer; cleanup when a session is deleted.
2. **LSP** — lazily started language servers (TypeScript, Python, Go, Rust defaults, only when the
   binary is on PATH; never downloaded), configured by the existing `lsp` key (`false` disables;
   per-server `disabled`/override/custom); after `edit`/`write`/`patch`, diagnostics for touched
   files; new errors (deduplicated per session, bounded) appended to the tool result. Servers run in
   the OS sandbox without network when it is available; off in job mode (and so review mode).
3. **Hooks** — `kete.hooks` with events PreToolUse, PostToolUse, UserPromptSubmit, Stop,
   SessionStart, Notification; each entry a shell command (JSON payload on stdin), optional tool
   matcher and timeout; exit 2 / `{"decision":"deny"}` blocks a PreToolUse call with a reason;
   `context` output is added for PostToolUse, UserPromptSubmit and SessionStart. Global hooks run
   directly; project hooks only after the user trusts the exact commands (form listing them;
   remembered per repository + content hash; asked again on change). Policy action `hooks` can be
   denied by an organization. Never in job mode; `kete job run` refuses project hooks without
   `--trust-project-config`.

## Out of scope
- Todo across subagents in one view; LSP hover/definition tools; hook types other than commands;
  UserPromptSubmit blocking (session hooks can't fail — pitfalls.md); running hooks in the OS sandbox.

## Acceptance criteria
- AC1 todo tool validates input (one in_progress, bounds), persists per session, survives a
  restart of the plugin, emits `rpc.kete.todo.updated`, `get` returns it; Plan mode allows it.
- AC2 todo visible in TUI (sidebar + footer) and the web UI dock (unit-tested pure helpers).
- AC3 LSP: fake language server → error in an edited file appears in the edit result once
  (dedupe), bounded; `lsp: false` and per-server `disabled` turn it off; missing binary → no
  server; job mode → no server; spawn site classified.
- AC4 hooks: PreToolUse deny (exit 2 and JSON), context injection, timeout, global vs project,
  trust prompt (accepted, declined, changed hash), job-mode exclusion, policy disable.
- AC5 docs (`docs/todo.md`, `docs/lsp.md`, `docs/hooks.md`), cards, README; checks of CLAUDE.md §12.

## Risks and constraints
- Security: project hooks and language servers are code execution from a repository. Hooks need
  explicit trust; language servers run sandboxed without network when possible and with
  code-running features (rust build scripts/proc macros, TypeScript type acquisition) off by default.
- Upstream edits kept to registration lines (`plugin/internal.ts`, TUI `builtins.ts`, app
  composer); recorded in `docs/upstream-patches.md`.
