# Plan: Windsurf (and VS Code forks) support for the extension

## Cards read
- docs/context/modules/vscode-extension.md (verified-at 6c3649e3a6, stale: no)

## Research: fork base versions (October 2026)

| Editor | Latest VS Code base | Source |
|---|---|---|
| Windsurf (Devin Desktop since 2026-06) | 1.126 (v3.6.21, 2026-07-29: "Updated the base IDE to VS Code 1.126") | <https://docs.devin.ai/desktop/changelog> (windsurf.com/changelog redirects there) |
| Cursor | 1.128 (Cursor 3.19.7, build 2026-09-02; was 1.105.1 for months before) | <https://github.com/cluesmith/codev/issues/1608> (About panel, verified 2026-09-04) |
| VSCodium | 1.135 (release 1.135.06055, 2026-09-09) | <https://github.com/VSCodium/vscodium/releases/tag/1.135.06055> |
| VS Code (CI) | 1.140.0 | `update.code.visualstudio.com/api/update/linux-x64/stable/latest` |

**Decision: keep `engines.vscode` at `^1.94.0`.** The newest floor all three forks support is 1.126;
our floor is already below it, so every current fork installs the extension. Raising it to 1.126
would gain no API we use and would lock out older installs (Cursor sat at 1.105 until September
2026). `@types/vscode` stays pinned to 1.94.0, so `bun run typecheck` proves every API we call exists
at the floor; `test/fork.test.ts` keeps the floor equal to the types version and ≤ 1.126.

## Audit (packages/kete-vscode)

| Area | Finding | Action |
|---|---|---|
| URI scheme | Session links already use `env.uriScheme` (`extension.ts:209`); sign-in uses a loopback callback (`kete login --port`), no editor scheme; URI handler is scheme-agnostic | Validate the scheme in `sessionLink`; tests for vscode/vscode-insiders/windsurf/cursor/vscodium; comments say `<scheme>://` |
| Product name | Model-facing diagnostics tool description hard-codes "(VS Code)" (`editor-tools.ts:31`); setting text "VS Code's diagnostics" | Tool description uses `env.appName` via `editorName()` (cleaned, ≤64 chars, fallback "the editor"); setting says "the editor's" |
| Proposed / Microsoft-only API | None: no `enabledApiProposals`, no `vscode.lm`/chat participant, no `extensionDependencies`; `vscode.git` used optionally (already guarded) | Guard test on the manifest |
| Marketplace-only links in UI | None in `src/` or `contributes` | Guard test |
| Keybindings | `cmd/ctrl+escape`, `cmd/ctrl+shift+escape`, `alt+k`, `cmd/ctrl+alt+k`: no clash with Cursor (`Cmd+K/L/I/E`, `Cmd+Shift+K/J`, `Cmd+.`, `Cmd+/`) or Windsurf (`Cmd+L`, `Cmd+I`) | Keep; guard test; README documents rebinding. (Windows reserves `Ctrl+Esc`/`Ctrl+Shift+Esc` at OS level — pre-existing, not fork-specific; documented) |

## Found during the build
The VSCodium run failed `editorContextFollows` three times in a row (VS Code passed): VSCodium's
composer mounted after the extension sent the file, so the shell kept it and the composer added the
chip on mount without posting `kete.editorContextApplied`; the extension's status stayed `null`.
`KeteVSCodeBridge` now reports the chip it adds on mount (`vscode-host.tsx`). A race in the bridge,
not a fork difference, that VS Code's timing hid.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/kete-vscode/src/editor-tools.ts | change | `Tools.editor`, `editorName()`, description from the host |
| packages/kete-vscode/src/extension.ts | change | pass `env.appName` to the editor tools |
| packages/kete-vscode/src/sessions.ts | change | scheme validation, host-neutral comments |
| packages/kete-vscode/package.json | change | neutral setting text (engines unchanged) |
| packages/kete-vscode/test/fork.test.ts | new | URI building, app name, grep guard, manifest, keybindings |
| packages/kete-vscode/script/e2e.ts | change | `--code` for any fork (executable derived from CLI), `--electron`, `--assert`, `-- <editor args>` |
| packages/kete-vscode/script/e2e-check.ts, test/e2e-check.test.ts | new | assertions for `--assert`, unit-tested |
| packages/kete-vscode/test/e2e/suite.ts | change | record what was applied when editor context times out |
| packages/kete-vscode/tsconfig.json | change | typecheck `script/` too |
| packages/app/src/kete/vscode-host.tsx | change | bug found by the VSCodium run (below) |
| .github/workflows/kete-release.yml | change | `extension-e2e` job: VS Code + VSCodium under xvfb |
| packages/kete-vscode/README.md, DEVELOPMENT.md, CHANGELOG.md, docs/release.md | change | fork section + checklist; Open VSX is the forks' channel |

## Steps
1. Audit (above), then the source changes and `test/fork.test.ts`.
2. e2e runner: fork support and `--assert`; run locally against VS Code and VSCodium (macOS).
3. CI job in `kete-release.yml` (the workflow whose `extension` job checks the `.vsix`): matrix
   `vscode` (1.140.0) / `vscodium` (1.135.06055), pinned archives with pinned SHA-256, xvfb,
   AppArmor userns sysctl for Electron's sandbox on Ubuntu 24.04; `image` and `publish` wait for it.
   `@vscode/test-electron` isn't used: the existing harness launches the editor executable directly
   with `--extensionTestsPath`, which works for any fork given its path.
4. Docs, card, result.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun test ./test/fork.test.ts` (packages/kete-vscode) |
| AC2 | `bun run typecheck` (API floor), `bun test ./test/fork.test.ts` (manifest), `bunx --bun @vscode/vsce@4.0.0 package … --target darwin-arm64` (ovsx has no offline/dry-run validation) |
| AC3 | locally: `bun run e2e <vsix> --assert` and `bun run e2e <vsix> --code <VSCodium>/bin/codium --assert`; CI: `kete-release` `extension-e2e` (manual dispatch) |
| AC4 | README "Using Kete Code in Windsurf, Cursor or VSCodium" |
| AC5 | `bun run typecheck`, `bun run test`, `bun run build` (kete-vscode); root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; actionlint on `kete-release.yml` |

## Cards to update after the build
- docs/context/modules/vscode-extension.md (fork support, e2e runner flags/CI, `editorName`)
