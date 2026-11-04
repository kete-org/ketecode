# Spec: B2 context breakdown

- Task: `docs/tasks/2026-10-29-context-breakdown` · Size: medium · Created: 2026-10-29
- Status: closed <!-- draft → agreed (medium) / approved (large) → built → closed -->
  (follows the recommended options; parity-plan items marked *new* were pre-approved 2026-10-10)

## Goal
A `/context` command in the TUI that shows what fills the session's context window, split into
system prompt, tools, MCP, memory and instruction files, skills and messages. Users can then see
why a session is heavy and what to trim (an MCP server, a big `AGENTS.md`, a long history).

## Scope
- **Runtime RPC `kete.context`** (`get` for a session): a Kete plugin in `packages/core/src/kete/`
  with a shared schema in `packages/schema/src/kete/`, the same pattern as `kete.todo`
  (`docs/context/modules/todo.md`). No HTTP route, protocol or generated-client change.
- It sizes the parts the next request would send, from the same sources `SessionContext.select`
  uses (`packages/core/src/session/context.ts:126`):
  - system prompt (agent prompt or `SessionSystemPrompt`);
  - tools sent directly, each with its definition size;
  - Code Mode: the `execute` tool plus its catalog, with the MCP tool count shown and how many are
    listed inline vs behind `search`;
  - MCP server instructions;
  - memory and instruction files (`AGENTS.md`, memory files, auto memory), each file named;
  - skills listing;
  - messages since the last compaction.
- Sizes are **estimates** at 4 characters per token, reusing the constant in
  `packages/core/src/codemode/catalog.ts:48` (exported, not copied). The provider-reported total
  from the last step (`packages/client/src/solid/usage.ts`) is shown beside the estimates, along
  with the model's context limit and free space.
- **TUI `/context`**: a builtin TUI plugin in `packages/tui/src/kete/context.tsx`, registered in
  `packages/tui/src/plugin/builtins.ts`. That is one import and one array entry, with
  `kete_change` markers. It shows a dialog with a bar and one row per category, largest first.
  The tools, MCP and memory rows expand to show their items.
- **A warning when MCP tools are hidden**: if a permission rule denies `execute`, Code Mode tools are
  dropped without notice (`packages/core/src/tool.ts:236`). The breakdown says how many MCP tools
  are unavailable and why.
- Module cards: new card `context-breakdown`; update `instructions.md` (where the per-request
  input is assembled) and `ui-branding.md` or `cli.md` (how a TUI slash command is added), the two
  gaps the scout reported.

## Out of scope
- Web UI and VS Code/JetBrains views: they can use the same RPC later (follow-up).
- A real tokenizer, or per-provider token counts.
- Trimming actions from the dialog (disable an MCP server, compact); the dialog only reports.
- Any change to what is sent to the model.

## Acceptance criteria
- [ ] AC1: `kete.context get` for a session returns every category above, with characters and
  estimated tokens per category and per item. Unit test with a session that has two direct tools,
  one MCP server in Code Mode, an `AGENTS.md`, a skill and two messages: each category is non-zero
  and matches the sizes of its fixtures.
- [ ] AC2: estimates use the exported `CHARACTERS_PER_TOKEN`; a test fails if a category is
  computed some other way (e.g. changing the constant changes the result).
- [ ] AC3: the provider-reported total and the model's context limit are returned when the session
  has an assistant step with usage, and are absent (not zero) when it has none. Tests for both.
- [ ] AC4: with a permission rule that denies `execute`, the response reports N hidden MCP tools
  and the reason; with `execute` allowed it reports none. Test.
- [ ] AC5: messages before the last completed compaction are not counted. Test.
- [ ] AC6: the RPC refuses a session outside the caller's location, using the same check as `SessionContext.select` (`kete.todo` has none). Test.
- [ ] AC7: the TUI `/context` command appears in slash autocomplete and opens the dialog. TUI test
  in `packages/tui/test/kete/`.
- [ ] AC8: no secret values in the response. MCP server config (env, headers) is never included,
  only names and sizes. Test with an MCP server whose config has a secret header.
- [ ] AC9: `bun run typecheck` and `bun run test` in `core`, `schema` and `tui`; `bun run lint`;
  `upstream:check` passes with the `builtins.ts` edit marked and listed in
  `docs/upstream-patches.md`.

## Risks and constraints
- **Upstream edits.** `builtins.ts` gets one import and one entry. Per-source instruction sizes
  need the items before `Instructions.combine` (`context.ts:155`). If no public seam exposes them,
  the plan may add one small marked edit in `context.ts` that exports the uncombined list. No
  other upstream file may change. The plan must confirm this before building.
- **Accuracy.** Character estimates can be off by about 20–30% for code and for non-English text.
  The UI labels them as estimates and shows the provider total beside them.
- **Cost.** Sizing must not trigger MCP connections, model calls or a catalog rebuild. It reads the
  cached tool snapshot and catalog (`tool.ts:241`).
- **Security.** The response holds sizes and names, never MCP secrets or file contents. File paths
  shown are those already shown elsewhere in the session.
- Schema, money and tenancy: not affected. No platform change.
