---
module: todo
paths: [packages/core/src/kete/todo.ts, packages/schema/src/kete/todo.ts, packages/tui/src/kete/todo.tsx, packages/app/src/kete/todo.ts, packages/app/src/kete/todo-dock.tsx]
verified-at: e81d6b17f0
---
## Quick answers
- Did upstream have a todo tool? Yes: v2 removed `todowrite` in `7feefb697f` (#35989, DB table, app dock, prompts). Kete re-adds it as a plugin with the same name and item shape; session-ui still titles `todowrite` parts and the timeline still hides them (`session-ui/src/timeline/projection.ts:587`), so the list shows in the dock, not inline.
- Where is the list stored? Plugin storage (`ctx.storage`, the global SQLite KV table, namespaced by plugin id) under `session/<sessionID>` (`core/src/kete/todo.ts:62`); removed on `session.deleted` (`:144`).
- How do clients read it? `kete.todo` plugin RPC `get({sessionID})` and the `rpc.kete.todo.updated` event (`schema/src/kete/todo.ts`); no HTTP endpoint or protocol change. Call with the session's `location`.
- Permission? Action `todowrite` (catch-all allow; policies can deny, which hides the tool); in `KetePermissionMode.planAllowed`. Explore denies it (its `*: deny`).
- Is the list in the system prompt? Only a one-line instruction when the tool is offered (`:136`); not the list (prompt caching).

## Purpose
A per-session task list the agent maintains with `todowrite` so the user sees plan and progress (TUI sidebar + footer, web/VS Code/JetBrains dock, SDK via RPC).

## Entry points
- `KeteTodo.Plugin` (`core/src/kete/todo.ts:73`), registered last in `pre` (`core/src/plugin/internal.ts:302`).
- TUI plugin `kete.todo` (`tui/src/kete/todo.tsx`), registered in `tui/src/plugin/builtins.ts:27`.
- Web dock `KeteTodoDock` (`app/src/kete/todo-dock.tsx`), rendered by `app/src/composer/composer.tsx:29`.

## Key files
| File | Role |
| --- | --- |
| `packages/schema/src/kete/todo.ts` | `KeteTodoRpc`: item/list schema and bounds (50 items, 500 chars), RPC definition, `progress`, `finished` |
| `packages/core/src/kete/todo.ts` | tool, validation (`problem`, one in_progress), storage, RPC, guidance hook, cleanup |
| `packages/tui/src/kete/todo.tsx` | `useTodos` (RPC + events), sidebar list, footer label |
| `packages/app/src/kete/todo.ts` | fetch/decode helpers for the web UI |
| `packages/app/src/kete/todo-dock.tsx`, `panel.css` | the dock above the composer |

## Data flow
Model calls `todowrite({todos})` → schema decode → `problem` → `permission.assert(todowrite)` → `ctx.storage.set` → RPC event `updated` → TUI/app listeners replace their list; on session open they call `get`.

## Data and APIs used
- Plugin storage (KV table), plugin RPC route `POST /api/rpc/:rpcID/:method`, event stream.

## Rules that must not break
- Whole-list replace; at most one `in_progress`; bounds from the shared schema; stored value decoded on read (bad → empty + warning).
- Clients decode RPC replies and events against `KeteTodoRpc.State`.
- No dynamic list in the system prompt.

## Testing
- `bun run test ./test/kete/todo.test.ts` in `packages/core/`; `bun test test/kete/todo.test.tsx` in `packages/tui/`; `bun test --conditions=solid --preload ./happydom.ts ./src/kete/todo.test.ts` in `packages/app/`.

## Changes
- 2026-10-10 created (wave 1a, `docs/tasks/2026-10-10-wave1a`).

## Gotchas
- RPC and storage are per location instance but the KV table is global, so any location's instance answers `get` for any session ID.
- The model's view after compaction relies on the summary; there is no `todoread` tool.
