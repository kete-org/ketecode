---
module: context-breakdown
paths: [packages/schema/src/kete/context.ts, packages/core/src/kete/context-breakdown.ts, packages/tui/src/kete/context.tsx, packages/core/test/kete/context-breakdown.test.ts, packages/tui/test/kete/context.test.tsx]
verified-at: 7c430bd9c5
---
## Quick answers
- What does `/context` show and where does the answer come from? The `kete.context` plugin RPC `get({sessionID})` (`schema/src/kete/context.ts:61`, served by `KeteContextBreakdown.Plugin`, `core/src/kete/context-breakdown.ts:273`) returns categories (system, tools, codemode, mcp, memory, skills, messages, other) with named items, sizes and estimated tokens, or `{type:"refused", reason}`. The TUI dialog (`tui/src/kete/context.tsx`) draws a bar per category.
- Are the numbers exact? No: characters / 4 (`CHARACTERS_PER_TOKEN`, exported from `core/src/codemode/catalog.ts:48` with a `kete_change`). Only `provider` (tokens, limit, free) is the provider's own count from the last assistant step after the last completed compaction (`usage()`, `context-breakdown.ts:254`).
- How is the request sized without sending it? It mirrors `SessionGenerate`: `SessionContext.select`, then `SessionHistory.preview` (read-only), then `SessionModelRequest.baseTranscript`. It never calls `SessionModelRequest.primary/generate`, because the `context` hooks have side effects (`plugin/warming.ts:58,103` starts a loop). See the `instructions` card and `pitfalls.md`.
- How are instruction files sized separately? `Instructions.List` keeps each source's key after `Instructions.combine`; the card walks `selection.instructions`, calls `source.read` then `source.initial` (`context-breakdown.ts:156-185`), and names `core/instructions` files through `InstructionDiscovery.list()`. Sources with `api/` keys are summed as "session instruction entries".
- How does it count MCP tools hidden when `execute` is denied? `Tool.snapshot` (`core/src/tool.ts:239,252`) drops the Code Mode catalog when `execute` is wholly denied, and `whollyDisabled` (`tool.ts:293`) is not exported. When `codeModeCatalog` is absent the card takes a second `registry.snapshot` with the agent and session rules plus an appended `execute` allow rule (last match wins, so other denies still apply and a `*` deny doesn't inflate the count), then `CodeModeCatalog.summarize(...).total` (`context-breakdown.ts:209-217`). Result is `hiddenMcp {count, reason}`.
- What do plugin-added system prompt parts (auto memory, guidance) count as? A `context` hook registered last in `post` (`internal.ts:376`) records each session's system size (`observe`, at most `MAX_SESSIONS` = 100, no `session.deleted` cleanup); the breakdown shows them as "auto memory (last request)" and "added by plugins at the last request" (other). Absent until the session has made a request.
- Does the RPC check the session's folder? Yes, itself: it refuses a session of another directory or workspace (`context-breakdown.ts:119`), like `SessionContext.select`'s check (`core/src/session/context.ts:129`). The `kete.todo` RPC does not check (todo card gotcha), so copy this one, not todo's.
- Why is `core/src/plugin/internal.ts` edited? A core plugin reaches only services in the plugin requirements; `SessionContext`/`Database` weren't, so `KeteContextBreakdown.Service` is added to `services` (`:175`) and `.node` to `requirements` (`:234`), and the plugin goes last in `post` (`:376`). Details: `docs/upstream-patches.md` "Context breakdown".
- How do I test it? Core: `bun run test ./test/kete/context-breakdown.test.ts` in `packages/core/` (sizes, hidden MCP, scope and secrets, usage). TUI: `bun test ./test/kete/context.test.tsx` in `packages/tui/`. The TUI fixture answers the RPC in `tui/test/fixture/tui-client.ts:175` (upstream file, `kete_change`).

## Purpose
`/context` (also "Context usage" in the palette) shows what fills a session's context window and why, so users can trim an MCP server, a big `AGENTS.md` or a long history. Read-only; sends nothing to a model.

## Entry points
- RPC `kete.context` `get`: `schema/src/kete/context.ts` (`Definition`, `Output = Breakdown | Refused`), implemented in `core/src/kete/context-breakdown.ts` (`layer`, `Plugin` `:273`).
- TUI plugin `kete.context` (`tui/src/kete/context.tsx`): command `kete.context`, slash `context`, palette; registered in `tui/src/plugin/builtins.ts:39`. On the home screen (no session) it shows "Open a session to see its context."

## Key files
| File | Role |
| --- | --- |
| `packages/schema/src/kete/context.ts` | `Item`, `Category`, `CategoryID`, `Breakdown`, `Refused`, bounds (12 categories, 100 items, 300-char names) |
| `packages/core/src/kete/context-breakdown.ts` | `get` (refuse, select, preview, size each part), `observe`, `usage()`, `Plugin` |
| `packages/tui/src/kete/context.tsx` | `fetchContext` (15 s timeout, decodes against the schema), `bar`, dialog (`e` expands tools, codemode, mcp, memory) |

## Data flow
TUI command, then `POST /api/rpc/kete.context/get` with the session's location, then `get`: store lookup, location check, `select` (agent, tools, instruction sources), `resolveModel` (optional), `SessionHistory.preview`, size system / tools / sources / messages, hidden-MCP snapshot, `usage()`, sort items by size.

## Data and APIs used
- `SessionStore`, `SessionContext.select/resolveModel`, `SessionHistory.preview`, `SessionModelRequest.baseTranscript`, `Tool.Service.snapshot`, `InstructionDiscovery.list`, `Location`; plugin RPC route `POST /api/rpc/:rpcID/:method` (no protocol change).

## Rules that must not break
- Names and sizes only: no file contents, config values, headers or environment in the answer (test "scope and secrets").
- Read-only: never run `SessionModelRequest.primary/generate` or `SessionHistory.entriesForRunner` here.
- The client decodes the reply against `KeteContextRpc.Output`; a mismatch is an error row.
- Upstream sync checks: `Instructions.combine` still keeps each source's key, `SessionHistory.preview` is still read-only, `Tool.snapshot` still drops Code Mode when `execute` is wholly denied.

## Testing
See Quick answers. Core test fixture inserts sessions and fakes `Tool.Service`; AC5 (compaction boundary) is covered only by the pure `usage()` test.

## Changes
- 2026-10-29 created (`docs/tasks/2026-10-29-context-breakdown`; upstream edits in `docs/upstream-patches.md` "Context breakdown").

## Gotchas
- A blocked instruction initialization (`Instructions.InitializationBlocked`) leaves messages unsized and logs a warning instead of failing.
- Without a resolvable model, messages are sized raw (no `baseTranscript`) and `provider.contextLimit` is absent.
- `tui/test/session-panel.test.tsx` was adjusted: with Kete's builtin plugins the unfiltered plugin list pushes `opencode.diffs` below the fold.
