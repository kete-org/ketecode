# Plan: Transcript search and the copy picker (parity C1)

Built in the main session (no planner/implementer), like B4. Design in `spec.md`.

| File | Change |
|---|---|
| `packages/tui/src/kete/transcript-search.tsx` | create: `findOffsets`, `selectionCells`, `collect`, the controller, the bar, the `session.search` command |
| `packages/tui/src/kete/copy-picker.tsx` | create: `codeBlocks`, `options`, `DialogKeteCopy` |
| `packages/tui/src/kete/text-columns.ts` | create: display columns as the renderer counts them (per code point, tab 2) |
| `packages/tui/src/routes/session/index.tsx` | marked: imports; controller after `ensureAllRows`; the bar after the `session.composer.top` slot; the prompt disabled while the bar is open; `messages.copy` opens the picker |
| `packages/tui/src/routes/session/dialog-message.tsx` | marked: Copy on a reply with code blocks opens the picker |
| `packages/tui/src/config/keybind.ts` | marked: `session.search` default `<leader>/` |
| `packages/tui/test/kete/{transcript-search,copy-picker}.test.tsx` | create |
| `docs/transcript-search.md`, `packages/kete-tools/src/lib.ts` (allowlist), `docs/upstream-patches.md`, `CHANGELOG.md` | docs |

## Verification
- `bun test test/kete/transcript-search.test.tsx test/kete/copy-picker.test.tsx` (packages/tui): AC1–AC5.
- `bun run --cwd packages/kete-tools verify --base main`, `bun run lint`, `upstream:check`: AC6.
