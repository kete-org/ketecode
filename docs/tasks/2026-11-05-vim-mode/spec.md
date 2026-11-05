# Spec: Vim mode for the prompt (parity C2)

- Task: `docs/tasks/2026-11-05-vim-mode` · Size: L · Created: 2026-11-05
- Status: built (P5 of `docs/tasks/2026-10-10-tui-codex-parity/spec.md`, approved 2026-10-10; the maintainer
  asked for Milestone C to be completed on 2026-11-05, and `docs/parity-plan.md` pre-approves specs that follow
  the recommended options)

## Upstream check (CLAUDE.md §4)
No upstream vim mode to extend (2026-11-05): no branch or commit in `upstream/*` mentions vim, and the TUI and
`@opentui/keymap` 0.8.0 have none (its `neovim-disambiguation` add-on only times out ambiguous key sequences).

## Goal
Opt-in vim keys in the prompt for people who edit that way, as in Codex and Claude Code.

## Scope
- TUI config `vim: boolean` (`cli.json`, default off); `/vim` (palette "Toggle vim keys in the prompt")
  toggles and saves it.
- Insert mode types as today; Esc goes to normal mode. Normal mode:
  - motions `h j k l w b e 0 ^ $ gg G` (and the arrow keys, Home, End);
  - operators `d c y` with a motion or a text object (`iw aw i" a" i' a' i( a( ib ab i[ a[ i{ a{ iB aB`),
    and `dd cc yy`; `x`, `p`, `P`; `i a I A o O`;
  - `u` undo and Ctrl+R redo (a whole change at a time: an insert, and a `c` with its insert, is one change);
  - `/` and `?` search with `n` `N`.
- Enter, Ctrl and Alt keys keep their app meaning in both modes; Esc with nothing pending in normal mode
  still reaches the app (it interrupts a running turn). While autocomplete is open, Esc closes it.
- The mode is shown first in the status line (`NORMAL`, `INSERT`, `/pattern`), never dropped for width; the
  cursor is a block in normal mode.
- Not covered: counts, named registers, visual mode, `.` repeat, `:` commands, `r`/`f`/`t`.

## Acceptance criteria
- [ ] AC1 (spec AC10): each listed motion, operator and text object has a test on the prompt buffer
  (`test/kete/vim.test.ts`).
- [ ] AC2: with vim on, the prompt types in insert mode, Esc shows `NORMAL`, and `0wdw`, `u`, Ctrl+R, `a`, `ciw`
  edit the real textarea (`test/kete/vim-prompt.test.tsx`).
- [ ] AC3: with vim off (default), the same keys type as usual, and the existing TUI tests pass unchanged.
- [ ] AC4: `/vim` turns vim keys on and saves `vim: true`.
- [ ] AC5: edits are applied through the textarea's editing calls with display-column offsets; wide characters
  and emoji before the edit don't shift it (test).
- [ ] AC6: typecheck, TUI tests, lint, `upstream:check`; upstream edits in `docs/upstream-patches.md`.

## Risks
- `component/prompt/index.tsx` is large and active upstream: one controller line, one `reset()` line, the
  cursor style attribute and the status line's `vim` prop, all marked.
- Terminals differ on Esc timing and Alt keys; Esc is the only key vim needs from them.
