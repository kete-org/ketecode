# Handoff: Vim mode for the prompt (parity C2)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 main session
- Done: built per plan.md.
- Decisions: the textarea's offsets are display columns (newline = 1), found by probing; `vim-prompt.tsx` maps
  them per grapheme. Each change is applied as one replacement (`diff`) through `setSelection`/`deleteSelection`/
  `insertText`, never `setText`, so extmarks (attachments) follow. Esc in normal mode with nothing pending goes on
  to the app, so it still interrupts a turn. `clearPrompt` resets the change history, so `u` never reaches a sent
  prompt.
- Docs enough: no — missing: the textarea's offset units (display columns) and the prompt's traits (`capture`
  includes `escape` while autocomplete is open) aren't on a card.

## 2026-11-05 main session (review fixes)
- typescript-reviewer findings fixed: tabs count 2 columns and widths are per code point (`kete/text-columns.ts`,
  measured against the renderer); steps move by grapheme and `diff` widens to whole graphemes, so emoji and flags
  are never split; `cw` inside a word stops at its end; `d$` on an empty line and `dj`/`dk` past the ends change
  nothing; Ctrl/Alt keys pass on while typing a search; a status note no longer keeps Esc from the app; the first
  insert after the prompt mounts can be undone. `j`/`k` keep the string column, not the display column (left as is).
