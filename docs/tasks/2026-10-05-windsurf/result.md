# Result: Windsurf (and VS Code forks) support for the extension

## What changed
- `packages/kete-vscode/src/editor-tools.ts` — `Tools.editor` + `editorName()`: the diagnostics tool's description names the host (`env.appName`) instead of "VS Code".
- `packages/kete-vscode/src/extension.ts` — passes `env.appName` to the editor tools.
- `packages/kete-vscode/src/sessions.ts` — `sessionLink` rejects a malformed scheme; comments say `<scheme>://`.
- `packages/kete-vscode/package.json` — `kete.editorTools.enabled` text says "the editor's diagnostics". `engines.vscode` unchanged (`^1.94.0`, see plan).
- `packages/kete-vscode/test/fork.test.ts` (new) — URI building for vscode/vscode-insiders/windsurf/cursor/vscodium, app-name text, grep guard (no `vscode://`, "VS Code", Marketplace link in `src/` code), manifest (no proposed API, no "VS Code" in `contributes`), engine floor, keybindings vs. the forks' AI keys.
- `packages/kete-vscode/script/e2e.ts` — `--code` for any fork (executable derived from the CLI), `--electron`, `--assert`, `-- <editor args>`; `script/e2e-check.ts` + `test/e2e-check.test.ts` (new) — the `--assert` requirements.
- `packages/kete-vscode/test/e2e/suite.ts` — records what was applied when editor context times out.
- `packages/kete-vscode/tsconfig.json` — typechecks `script/`.
- `packages/app/src/kete/vscode-host.tsx` — `KeteVSCodeBridge` reports the editor chip it adds on mount (bug found by the VSCodium run).
- `.github/workflows/kete-release.yml` — `extension-e2e` job (VS Code 1.140.0 / VSCodium 1.135.06055, pinned SHA-256, xvfb); `image` and `publish` wait for it.
- `packages/kete-vscode/README.md` ("Using Kete Code in Windsurf, Cursor or VSCodium" + manual checklist), `DEVELOPMENT.md`, `CHANGELOG.md`; `docs/release.md` (Open VSX is the forks' channel, CI step, checklist).

## Fork base versions (October 2026)
Windsurf/Devin Desktop 1.126 (<https://docs.devin.ai/desktop/changelog>, v3.6.21, 2026-07-29);
Cursor 1.128 (<https://github.com/cluesmith/codev/issues/1608>, Cursor 3.19.7, 2026-09-02);
VSCodium 1.135 (<https://github.com/VSCodium/vscodium/releases/tag/1.135.06055>). Floor kept at
`^1.94.0` (below all three; raising it would add nothing we use and exclude older fork installs).

## Checks
| Check | Result |
|---|---|
| `bun run typecheck` (kete-vscode) | pass |
| `bun run test` (kete-vscode) | pass, 111 tests / 18 files |
| `bun run build` (kete-vscode) | pass |
| `bun run typecheck` + `bun test … ./src/kete` (app) | pass, 61 tests |
| root `bun run lint` | pass, 0 warnings / 0 errors |
| `bun run --cwd packages/kete-tools upstream:check` | pass |
| actionlint `kete-release.yml` | pass |
| `vsce package` (darwin-arm64, local CLI build) | pass |
| `bun run e2e <vsix> --assert`, VS Code (macOS, local) | pass (every check) |
| `bun run e2e <vsix> --code …/VSCodium.app/…/codium --assert`, VSCodium 1.135 (macOS, local) | failed 3/3 on `editorContextFollows` before the `vscode-host.tsx` fix; pass 2/2 after |
| `ovsx` validation | not run: ovsx has no offline/dry-run mode (publish only); the manifest is the one `vsce package` validates |
| CI `extension-e2e` (Linux, xvfb, VS Code + VSCodium) | not run yet — provable only in CI (manual dispatch of `kete-release`) |

## Acceptance criteria
- [x] AC1 — `test/fork.test.ts` (grep guard + URI/app-name unit tests).
- [x] AC2 — no proposed API (manifest test), floor `^1.94.0` documented (plan, card, README); `vsce package` passes; ovsx: see Checks.
- [ ] AC3 — passes locally on VS Code and VSCodium (macOS); CI job added, not yet run.
- [x] AC4 — README section and manual checklist.
- [x] AC5 — all pass.

## Cards updated
- `vscode-extension` (fork support, engine floor, e2e flags/CI, bridge gotcha), `kete-tools-ci` (`extension-e2e` in the job graph), `job-image` (verified-at only).

## Open
- Windows reserves `Ctrl+Esc`/`Ctrl+Shift+Esc` (Start menu, Task Manager), so the default chat shortcuts never fire there. Pre-existing, not fork-specific; documented in the README, defaults unchanged.

## Metrics
- Agents used: one build agent
- Scout lookups: 0
- Tokens / cost (from /usage): n/a
- Time: ~1 h 30 min
