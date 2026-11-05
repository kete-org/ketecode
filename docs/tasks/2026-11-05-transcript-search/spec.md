# Spec: Transcript search and the copy picker (parity C1)

- Task: `docs/tasks/2026-11-05-transcript-search` · Size: M · Created: 2026-11-05
- Status: built (P4 of `docs/tasks/2026-10-10-tui-codex-parity/spec.md`, approved 2026-10-10; the maintainer
  asked for Milestone C to be completed on 2026-11-05, and `docs/parity-plan.md` pre-approves specs that follow
  the recommended options)

## Goal
Find text in a long session without scrolling, and copy one code block from a reply instead of the whole
message (Codex has both).

## Scope
- **Search** (`session.search`, default `<leader>/`, slash `/find`, palette "Search this session"): a bar
  above the prompt. It searches the open session's rendered text: every text node of every loaded message
  (the transcript mounts all rows first), case-insensitive. What isn't shown (collapsed tool output, hidden
  thinking, unloaded older pages) isn't searched.
  - Typing selects the newest match and scrolls it into view; the bar shows `i/n` or `no matches`.
  - ↑/↓ walk older/newer matches (wrapping). Enter switches to walking with `n`/`N` (older/newer); `/`
    goes back to editing the query.
  - The current match is highlighted with the renderer's text selection. Esc closes the bar, clears the
    highlight and returns focus to the prompt (one press, ahead of the app's selection handler).
- **Copy picker**: `/copy` and `<leader>y` (`messages.copy`) open a picker for the latest reply: the
  response, each fenced code block (language and first line shown), or the transcript (runs the existing
  `session.copy`). The message dialog's Copy opens the picker (without the transcript) for a reply that has
  code blocks; other messages copy as before.
- Module cards: `ui-branding` (TUI). Docs: `docs/transcript-search.md`.

## Out of scope
- Highlighting every match at once (only the current one is highlighted).
- Searching collapsed or unloaded content; regex search.
- Restyling the transcript.

## Acceptance criteria
- [ ] AC1 (spec AC8): `<leader>/` finds matches across messages, ↑/↓ and n/N cycle them (n/N aren't typed into
  the query), Esc closes the bar and clears the highlight (session route test).
- [ ] AC2: `/find` opens the search; a query with no match shows `no matches` and no highlight.
- [ ] AC3: the highlight selects exactly the matched text, also across a wrapped line (renderer test).
- [ ] AC4 (spec AC9): the copy picker copies exactly one chosen code block (test with a two-block reply).
- [ ] AC5: `codeBlocks` follows CommonMark fences (backtick and tilde, longer closing fence, unclosed fence,
  indentation, backtick in the info string).
- [ ] AC6: `bun run typecheck` and `bun run test` in `packages/tui`; root lint; `upstream:check`; every upstream
  edit in `docs/upstream-patches.md`.

## Risks
- `routes/session/index.tsx` is large and active upstream: the edits are marked blocks (imports, the controller,
  the bar, the copy run's last lines).
- Selection-based highlight: the app clears the selection on most keys; the search re-highlights after each step.
