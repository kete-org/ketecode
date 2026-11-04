# Handoff: B2 context breakdown

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-29 planner
Done: wrote plan.md (26 files, 6 new). The plan edits four upstream files, two more than the spec allowed. It needs approval as a Large task.
Decisions:
- No edit to `session/context.ts`: `Instructions.combine` keeps each source's key, so the plan sizes each source with `read` + `initial`.
- Sizing uses the read-only `SessionHistory.preview` plus `baseTranscript`. The plan never calls `request.primary/generate`, because the `context` hooks have side effects (warming starts a loop).
- Text that plugins add to the system prompt (auto memory etc.) is recorded by a read-only `context` hook registered last, and reported as "at the last request".
- Hidden MCP count: a second `snapshot` with the `execute` rules removed, which hits the catalog cache.
Docs enough: no. Missing:
- instructions card: it doesn't say Kete plugins can't reach `SessionContext`/`Database` (they aren't in the plugin requirements, `core/src/plugin/internal.ts:150-253`), so this needs an `internal.ts` edit.
- instructions card: it doesn't say `SessionHistory.preview` (`session/history.ts:211`) is the read-only path while `entriesForRunner` writes, nor that `context` hooks have side effects (`plugin/warming.ts:96-103`).
- Nothing covers how hidden Code Mode tools can be counted (`tool.ts:239,293`: `whollyDisabled` is not exported).
- The spec says AC6 works "like kete.todo", but `kete.todo` doesn't check the location (todo card gotcha). The plan mirrors `context.ts:129` instead.
- No card names the TUI test fixture's RPC stubs (`tui/test/fixture/tui-client.ts:170-174`, an upstream file).
Stale, not used: the permissions, mcp-presets and server-sdk cards.
Open: the user must approve the `internal.ts` and `tui-client.ts` edits, which the spec didn't list.

## 2026-10-29 implementer
Done: steps 1-10 written. NO CHECK WAS RUN: this agent had no shell tool (Bash unavailable), so typecheck, tests, lint and upstream:check are all unrun. Everything below is unverified.
Files: created `schema/src/kete/context.ts`, `core/src/kete/context-breakdown.ts`, `core/test/kete/context-breakdown.test.ts`, `tui/src/kete/context.tsx`, `tui/test/kete/context.test.tsx`. Changed (marked) `core/src/codemode/catalog.ts`, `core/src/plugin/internal.ts` (4 spots), `tui/src/plugin/builtins.ts`, `tui/test/fixture/tui-client.ts`, `docs/upstream-patches.md`.
Decisions (deviations from the plan):
- Hidden MCP: instead of removing the deny rules, the second `snapshot` appends `{action:"execute", resource:"*", effect:"allow"}` (last match wins), so denies of other tools still apply and a `*` deny doesn't inflate the count.
- System prompt size is computed directly (agent.system or `SessionSystemPrompt.make`), not from `baseTranscript`; `core/date` and `core/environment` go under system; unknown keys (e.g. reference guidance) go under other. Messages use `baseTranscript(...).messages` when a model resolves, else the raw preview messages.
- The `context` hook recorder keeps at most 100 sessions but has no `session.deleted` cleanup (marked `shortcut:` in code).
- The refusal for a missing agent / missing session / other folder is `{type:"refused"}`.
- Core tests: AC5 is covered only by the pure `usage()` rule (compaction boundary); the preview-from-last-compaction behaviour is `SessionHistory`'s and was not fixture-tested. AC8 is tested as "secret text in a tool description and an instruction file never appears in the answer".
- Cards (`docs/context/*`, new `context-breakdown.md`, INDEX row, pitfalls) NOT touched: left to the librarian.
Risks to check first when someone can run it: the core test fixture (SessionTable insert with `directory: "/elsewhere"`, `agent.permissions` assignment, `Layer.mock(Tool.Service)` types, `Bus.configured({persist:true})` for the user message), `Plugin.define` requirement typing for `KeteContextBreakdown.Service`, `catchTag` tag names, and `message.tokens` typing in `usage()`.
