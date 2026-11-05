# Handoff: Transcript search and the copy picker (parity C1)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 main session
- Done: built per plan.md. Highlight uses `renderer.startSelection`/`updateSelection` with cells from
  `lineInfo.lineStartCols` (offsets from the text start, newline = 1); the focus cell is the match's last
  character (inclusive), proven by the renderer test.
- Decisions: Esc is taken by a priority-102 key intercept, because `util/selection.ts` (priority 101) consumes
  Esc to clear a selection. The search command's layer is `mode: "global"` like the route's own commands
  (a base-mode layer isn't in the slash list). Highlights wait for layout and carry a generation, so a slower
  earlier step can't highlight after a newer one.
- Docs enough: no — missing: the session route's tail-first mounting (`ensureAllRows`) and the selection key
  handler's priority aren't on a card.

## 2026-11-05 main session (review fixes)
- typescript-reviewer findings fixed: the highlight is a finished selection (`finishDragging`), so a click no longer
  copies it; Enter and `/` show the match again after the selection handler clears it; the prompt is `disabled`
  while the bar is open, so the palette's refocus and the prompt's focus effect can't take the focus back; columns
  come from `kete/text-columns.ts` (per code point, tab 2: measured against the renderer, which the reviewer's
  per-grapheme suggestion would have broken); offsets use a case-insensitive regex; rows clipped by a node's height
  aren't matches; Ctrl+C closes in one press. The fence-in-list-item miss (4+ spaces) is left as is.
