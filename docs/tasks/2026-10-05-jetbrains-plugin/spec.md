# Spec: JetBrains plugin (IntelliJ Platform), parity with the VS Code extension

- Task: `docs/tasks/2026-10-05-jetbrains-plugin` · Size: large · Created: 2026-10-05
- Status: approved (user pre-approved all recommendations, 2026-10-04)

## Goal
Kete Code in every IntelliJ-platform IDE (IntelliJ IDEA Community/Ultimate, PyCharm, WebStorm,
GoLand, PhpStorm, RubyMine, CLion, Rider, RustRover, Android Studio) with the same experience as the
VS Code extension, as a thin client of a local `kete serve` (CLAUDE.md §3, §6): no agent logic in the
plugin.

## Scope (new package `packages/kete-jetbrains`, Kotlin, IntelliJ Platform Gradle Plugin 2.x; web UI side in `packages/app/src/kete/`)
1. **Runtime:** spawn the plugin's own bundled `kete serve --stdio` (per-OS binary from the release,
   like the VS Code extension; a `cliPath` setting for development), parse its `{"url": …}` start
   line, restart with backoff, stop on IDE exit/project close. One runtime per IDE process; project
   directory passed per window.
2. **Chat tool window** ("Kete Code", right side): the runtime's web UI (`packages/app`) in a JCEF
   browser (`JBCefBrowser`), with the pairing password only in the URL fragment (as `chat.ts`). A
   JS↔Kotlin bridge (`JBCefJSQuery` in, `executeJavaScript` out) carries the same typed messages as
   the VS Code relay, validated on both sides with allowlists.
3. **Web UI host adapter:** generalise `vscode-host.tsx`/`vscode-messages.ts` into an IDE-host layer
   so the web UI detects JetBrains (`kete.host = "jetbrains"`), applies the IDE theme (light/dark +
   accent from the IDE's LAF colours), and uses the same message set: open the workspace, add
   context, open a diff, dismiss notices, panel state. VS Code behaviour must not change.
4. **Editor context:** current file and selection shared as context (same secret-file and exclude
   rules as `editor-context.ts`: `.env`, keys, IDE-excluded files never shared); "Add selection/file
   to Kete" actions (editor and project-view context menus, `Alt+K` default keymap like VS Code's).
5. **Diff review:** "Review changes" opens the last turn's changes in the IDE's diff viewer
   (`DiffManager`, multi-file `ChainDiffVirtualFile`), rebuilt from the runtime's unified diff like
   `review.ts`; "Revert file" restores the pre-turn content after a confirmation.
6. **Permissions and attention:** pending approvals and "finished while hidden" raise an IDE
   notification and a tool-window badge (SSE `/api/event`, like `events.ts`); the permission-mode
   toggle (Auto/Ask/Plan) works as in the web UI.
7. **Account and sessions:** status-bar widget (signed in/out, org, runtime state), "Sign in"
   (`kete login`), "Sign out", session list (open/continue), "Open in terminal" (`kete` in the IDE
   terminal).
8. **Settings:** `Settings → Tools → Kete Code` (cliPath, default mode, context sharing on/off),
   written through the runtime's config API/`kete.jsonc` like `settings.ts` — no separate config.
9. **Editor diagnostics tool:** the IDE's problems (errors/warnings for a file) exposed to the agent
   through the same local MCP tool contract as `editor-tools.ts` (bearer token, exact loopback Host,
   no Origin).
10. **Build, test, CI, release:** Gradle build with `org.jetbrains.intellij.platform`, target
    `sinceBuild` 2024.2 (243) → latest; unit tests (pure Kotlin pieces); the JetBrains **Plugin
    Verifier** against representative IDEs in CI (`kete-jetbrains.yml`, path-filtered); the release
    workflow builds one plugin zip per platform bundle (or one zip with all binaries if size allows)
    and attaches it to the GitHub Release; publishing to the JetBrains Marketplace is a separate,
    manually dispatched step (like the VS Code extension), needing a Marketplace token.
11. Branding from `assets/brand` (plugin icon from `kete-logo-512.png`/the mark SVG); "Kete Code"
    names via the brand constants where the web UI shows them.

## Out of scope
- JetBrains AI Assistant integration, JetBrains Gateway/remote dev mode, Fleet.
- Publishing to the Marketplace (go-live step, needs the vendor account).

## Decisions (recommended, taken)
- **D1** JCEF + the existing web UI, not a native Swing chat: one UI to maintain, parity by
  construction (same as the VS Code webview).
- **D2** Kotlin + IntelliJ Platform Gradle Plugin 2.x; Gradle wrapper committed; builds run in CI
  (no JDK on the maintainer's Mac); JDK 21 toolchain.
- **D3** `sinceBuild` 243 (2024.3) and no `untilBuild` cap, verified by the Plugin Verifier; older
  IDEs are out.
- **D4** Bundle the CLI per platform like the VS Code `.vsix` targets; the plugin picks the right
  binary at runtime. If the Marketplace size limit forces it, ship per-OS plugin zips.
- **D5** Bridge messages reuse the VS Code message names and validators; host differences live in
  one adapter.

## Acceptance criteria
- [ ] AC1: `./gradlew buildPlugin test verifyPlugin` passes in CI (`kete-jetbrains.yml`) against the
  verifier's IDE set (IC, IU, PY, WS, GO at least) with no compatibility problems.
- [ ] AC2: Unit tests cover: start-line parsing, binary resolution per OS/arch, secret/exclude
  context filtering, diff reconstruction, bridge message validation (allowlists), settings mapping.
- [ ] AC3: Web UI host adapter: VS Code tests unchanged; new tests for JetBrains detection, theme
  mapping and message validation (`packages/app` unit tests).
- [ ] AC4: Release workflow attaches the plugin zip(s) to the GitHub Release; manual publish
  workflow exists and refuses non-stable tags (like `kete-extension-publish.yml`).
- [ ] AC5: Docs: `packages/kete-jetbrains/README.md`, `docs/release.md` section, a `jetbrains-plugin`
  card; `upstream:check` passes.
- [ ] AC6: Manual smoke checklist in the README (what CI can't cover: open tool window, chat, add
  selection, review diff, approve a permission) — run by the maintainer before Marketplace publish.

## Risks and constraints
- No local JDK: every compile/verify round-trip is in CI; keep the plugin small and pure-Kotlin
  pieces unit-testable.
- JCEF availability: some IDE runtimes (e.g. older Android Studio, JBR without JCEF) lack it; detect
  and show "open Kete in the terminal" instead of failing.
- Security: the pairing password stays in the fragment; the bridge validates every message; the
  diagnostics MCP tool keeps the loopback/bearer checks; no secrets in IDE logs.
- Contracts: plugin ID `ai.ketecode.kete-code` (`ketecode` vendor), settings keys, message protocol.
