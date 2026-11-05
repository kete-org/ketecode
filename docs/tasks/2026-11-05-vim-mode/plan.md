# Plan: Vim mode for the prompt (parity C2)

Built in the main session. The engine is pure; the prompt only forwards keys and applies results.

| File | Change |
|---|---|
| `packages/tui/src/kete/vim.ts` | create: the engine (`press`, `label`, `diff`, `initial`) |
| `packages/tui/src/kete/text-columns.ts` | create: display columns as the textarea counts them (per code point, tab 2) |
| `packages/tui/src/kete/vim-prompt.tsx` | create: `useKeteVim` (key intercept at priority 100, offset mapping, `write`), the `/vim` plugin |
| `packages/tui/src/component/prompt/index.tsx` | marked: import; `useKeteVim(inputTarget)`; `keteVim.reset()` in `clearPrompt`; block cursor; `vim` label to both status line rows |
| `packages/tui/src/kete/statusline.tsx` | the `vim` entry, first and never dropped |
| `packages/tui/src/config/index.tsx` | marked: `vim` key |
| `packages/tui/src/plugin/builtins.ts` | marked: `KeteVim` plugin |
| `packages/tui/test/kete/{vim.test.ts,vim-prompt.test.tsx}` | create |
| `docs/vim-mode.md`, allowlist, `docs/upstream-patches.md`, `CHANGELOG.md` | docs |

## Verification
- `bun test test/kete/vim.test.ts test/kete/vim-prompt.test.tsx` (packages/tui): AC1, AC2, AC4, AC5.
- `bun run --cwd packages/kete-tools verify --base main` (whole TUI suite unchanged), lint, `upstream:check`: AC3, AC6.
