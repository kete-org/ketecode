# Result: B2 context breakdown

## What changed
- `packages/schema/src/kete/context.ts` (new): `kete.context` RPC schema; a refusal or a breakdown of sizes and names, never contents or config.
- `packages/core/src/kete/context-breakdown.ts` (new): the sizing service, the RPC and a read-only `context` hook recorder that keeps the last 100 sessions.
- `packages/core/test/kete/context-breakdown.test.ts` (new): 11 tests.
- `packages/tui/src/kete/context.tsx` (new): the `/context` slash and palette command, and its dialog.
- `packages/tui/test/kete/context.test.tsx` (new): 2 tests.
- Upstream, every edit marked `kete_change` and listed in `docs/upstream-patches.md` under "Context breakdown":
  - `core/src/codemode/catalog.ts`: export `CHARACTERS_PER_TOKEN`;
  - `core/src/plugin/internal.ts`: 4 registration spots;
  - `tui/src/plugin/builtins.ts`: import and entry;
  - `tui/test/fixture/tui-client.ts`: RPC stub;
  - `tui/test/session-panel.test.tsx`: the diff-plugin test waits for its row after filtering, because the extra builtin pushed it below the fold.
- Docs:
  - `docs/upstream-patches.md`;
  - `docs/parity-plan.md` (B1 and B3 status, from earlier on this branch);
  - cards (see below).

## Checks
| Check | Result |
|---|---|
| `core`: `bun run test ./test/kete/context-breakdown.test.ts` | 11 pass, 0 fail |
| `tui`: `bun test ./test/kete/context.test.tsx` | 2 pass, 0 fail |
| `tui`: `bun test test/session-panel.test.tsx` (×3) | 16 pass, 0 fail each run |
| `core`: Kete tests plus `session-generate` and `plugin/plan` | 1683 pass, 0 fail |
| `schema`: `bun run typecheck`, `bun run test` | ok; 89 pass |
| `core`, `tui`: `bun run typecheck` | ok (after fixing 2 test-typing errors and 1 TUI key-handler return type) |
| `bun run lint` (root) | exit 0; nothing reported for changed files |
| `upstream:check` | passed |
| `verify --base main` (util, server, core, tui, cli) | 0 new failures. core 8395/31 vs base 8384/31; tui 1673/1 vs 1671/1; the others all pass |

The verifier agent and the implementer had no shell, so the main session ran every check above.

## Acceptance criteria
- [x] AC1: every category is sized from its own source. Evidence: test "sizes every category from its own source (AC1)", which checks system, tools, Code Mode, MCP, memory, skills and messages against their fixtures' exact sizes.
- [x] AC2: one estimate from the exported constant. Evidence: test "every token count is the one estimate of its characters (AC2)".
- [x] AC3: the provider count is absent, not zero, with no usage. Evidence: test "…absent, not zero… (AC3)", and test "sums the latest assistant step…".
- [x] AC4: a denied `execute` reports hidden MCP tools, and an allowed one reports none. Evidence: two tests (AC4).
- [~] AC5: compaction boundary. Evidence: test "ignores steps before the last completed compaction (AC5)" covers the counting rule. Message sizing relies on `SessionHistory.preview` starting at the last compaction, which is upstream behaviour and has no fixture test here.
- [x] AC6: another folder's session is refused. Evidence: test "a session of another folder is refused (AC6)", plus a refusal for a missing session.
- [~] AC7: `/context` appears in autocomplete, opens a dialog and Esc closes it. Evidence: TUI test. It runs on the home screen, so it shows "Open a session…"; the dialog has not been tested against a live session's breakdown.
- [x] AC8: no secrets. Evidence: test "the answer holds names and sizes only… (AC8)", which uses secret text in a tool description and an instruction file. The spec's example was an MCP header secret; MCP config is never read into the response.
- [x] AC9: typecheck, tests, lint and `upstream:check`, all as in Checks above.

Review: the reviewer and upstream-guard both approved with no blockers or majors. A comment now records that instruction `read`s open no connections and rebuild nothing (verified by reading every source).

## Cards updated
- Before planning: `instructions`, `ui-branding` and `cli` refreshed, with two scout gaps added (where per-request input is assembled; how to add a TUI slash command).
- At close (librarian):
  - new `context-breakdown` card and its INDEX row;
  - `permissions`, `mcp-presets` and `server-sdk` refreshed;
  - handoff gaps added: plugins can't reach `SessionContext`/`Database`; `SessionHistory.preview` is the read-only path; `context` hooks have side effects; counting hidden MCP tools; `kete.todo` has no location check; the TUI fixture's RPC stubs; `Instructions.List` keeps keys per source;
  - a pitfall: never run `SessionModelRequest` primary/generate to inspect a request.

## Metrics
- Agents used: scout, librarian ×2, planner, implementer (no shell), verifier (no shell; checks run in the main session), reviewer, upstream-guard
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: about 1 h 30 min
