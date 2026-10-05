# Spec: Windsurf (and VS Code forks) support for the Kete Code extension

- Task: `docs/tasks/2026-10-05-windsurf` · Size: medium · Created: 2026-10-05
- Status: agreed (user pre-approved all recommendations, 2026-10-04)

## Goal
The Kete Code VS Code extension installs and works in Windsurf (and Cursor, VSCodium) from Open VSX,
with no fork-specific breakage, and CI proves it on an open-source fork build.

## Scope (module: vscode-extension)
1. **Audit and fix fork assumptions** in `packages/kete-vscode`:
   - URI handling: any `vscode://` / `vscode-insiders://` literal or callback built by hand must use
     `vscode.env.uriScheme` (Windsurf: `windsurf://`, Cursor: `cursor://`, VSCodium: `vscodium://`);
     `kete login` / OAuth callbacks and "open in editor" links included.
   - Product names in user-facing text: "VS Code" where it means "this editor" becomes
     `vscode.env.appName`.
   - Proposed or Microsoft-only APIs (chat participants, language-model API, Copilot hooks,
     `enabledApiProposals`): none may be required; feature-detect and degrade.
   - `engines.vscode`: lower to the oldest VS Code base current forks ship (check Windsurf's,
     Cursor's and VSCodium's latest base versions and document them), keeping only APIs available
     there.
   - Default keybindings that clash with Windsurf/Cursor built-ins (e.g. their AI chat shortcuts):
     keep ours, but make sure none overrides a fork's core shortcut; document how to rebind.
   - Marketplace-only assumptions (e.g. links to marketplace.visualstudio.com in UI): use Open VSX
     links when `vscode.env.appName` isn't VS Code, or neutral wording.
2. **CI on a fork:** extend `kete-vscode` tests to run the existing extension e2e/smoke suite
   against **VSCodium** (downloadable, open-source, same Open VSX path as Windsurf) in addition to
   VS Code, on Linux under xvfb. Windsurf/Cursor themselves can't be downloaded headlessly in CI
   (licensing/auth); a manual checklist covers them.
3. **Docs:** README "Using Kete Code in Windsurf, Cursor or VSCodium" (install from Open VSX or a
   `.vsix`, keybinding notes, known differences); `docs/release.md` notes that Open VSX is the
   channel for forks.

## Out of scope
- Publishing to Open VSX (the go-live step, separate workflow already exists).
- Windsurf-specific features (Cascade integration).

## Acceptance criteria
- [ ] AC1: No hard-coded `vscode://` scheme or "VS Code" product name in runtime behaviour/UI where
  it should follow the host (grep test + unit tests for URI building).
- [ ] AC2: No required proposed API; `engines.vscode` documented and set to the chosen floor;
  `vsce package` and `ovsx` validation pass.
- [ ] AC3: The extension's smoke/e2e suite passes on VSCodium in CI (and still on VS Code).
- [ ] AC4: README section and manual checklist for Windsurf and Cursor exist.
- [ ] AC5: typecheck, unit tests, lint and `upstream:check` pass.

## Risks
- VSCodium ≠ Windsurf exactly; the manual checklist covers the rest.
- Lowering `engines.vscode` may rule out APIs in use: keep the floor at the newest base all three
  forks ship.
