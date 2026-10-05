---
module: jetbrains-plugin
paths: [packages/kete-jetbrains/**, packages/app/src/kete/ide-host.ts, packages/app/src/kete/ide-host.test.ts, .github/workflows/kete-jetbrains.yml, .github/workflows/kete-jetbrains-publish.yml]
verified-at: 139c15e1b2
---

## Quick answers

- **What is it?** Kete Code for IntelliJ-platform IDEs (plugin ID `ai.ketecode.kete-code`, vendor Kete
  Code, `sinceBuild` 243, no `untilBuild`): a thin client of its own bundled `kete serve`, the JetBrains
  twin of the VS Code extension (see the `vscode-extension` card). Kotlin, IntelliJ Platform Gradle
  Plugin 2.19.0, Gradle 9.8.0 wrapper, JDK 21, compiled against IntelliJ IDEA Community 2024.3.
- **How do I build or test it without a JDK?** You don't: push and let `.github/workflows/kete-jetbrains.yml`
  compile it (`./gradlew buildPlugin test`, then the Plugin Verifier per IDE in a matrix). With a JDK:
  `./gradlew buildPlugin test` in `packages/kete-jetbrains`; `-PverifyIde=IU:2026.2.3` for one verifier run.
- **How does the web UI know it runs in JetBrains?** `packages/app/src/kete/ide-host.ts` `detectHost`:
  the plugin loads `/connect?kete-host=jetbrains#<pairing>`; the flag is remembered in
  `sessionStorage` (`kete.host`) because the connect page navigates away, and the injected
  `window.__keteJetBrains` bridge also counts. A framed page is never JetBrains; VS Code is still "framed
  in the iframe named `kete-vscode`".
- **How do messages travel?** Page → plugin: `window.__keteJetBrains.postMessage(msg)` → JSON through a
  `JBCefJSQuery` → `core/Bridge.kt` `parse` (allowlist `FROM_PAGE`, field validation, 64 KB cap) →
  `KeteProject.receive`. Plugin → page: `Bridge.deliverScript` (allowlist `TO_PAGE`) runs
  `window.dispatchEvent(new CustomEvent("kete-jetbrains-message", { detail: JSON.parse("<literal>") }))`;
  `ide-host.ts` `onHostMessage` hands `detail` to the same validators (`vscode-messages.ts`,
  `vscode-theme.ts`). Message names are the VS Code relay's (`packages/kete-vscode/src/chat.ts`).
- **Which binary runs?** `core/Binary.kt`: `<plugin>/bin/<os>-<arch>/kete[.exe]` (darwin/linux/windows ×
  arm64/x64; x64 folders hold the `-baseline` CLI builds), or the CLI path setting (absolute paths only,
  development). Never the `PATH`. A missing executable bit is restored.
- **Why per-OS zips?** The JetBrains Marketplace takes one file ≤ 400 MB per version and six binaries are
  ~520 MB. `kete-release.yml`'s `jetbrains` job attaches `kete-code-jetbrains-<v>-{macos,linux,windows}.zip`
  and an all-platform zip only if it fits; `kete-jetbrains-publish.yml` needs that all-platform zip and
  stops otherwise. Open go-live decision (docs/release.md, "Publish the JetBrains plugin").
- **What does the diagnostics tool report?** The daemon's highlights (weak warning and up) for the
  requested file, or for every open editor when no path is given; the IDE has no project-wide problem
  list for unopened files. Same MCP contract as VS Code's `editor-tools.ts`.

## Purpose

Kete Code in IntelliJ IDEA, PyCharm, WebStorm, GoLand, PhpStorm, RubyMine, CLion, Rider, RustRover and
Android Studio with the VS Code extension's experience: chat (the runtime's web UI in JCEF), editor
context, diff review and revert, approvals/notifications, account, sessions, settings, and the IDE's
problems as an agent tool. No agent logic in the plugin (CLAUDE.md §3, §6). Spec:
`docs/tasks/2026-10-05-jetbrains-plugin/spec.md`.

## Entry points

- `packages/kete-jetbrains/src/main/resources/META-INF/plugin.xml` — tool window, configurable,
  status-bar widget, startup activity, notification group, app listeners, actions (`Kete.AddToChat` with
  `alt K`, the `Kete.Menu` Tools submenu, `Kete.StatusMenu`). The terminal plugin is an optional
  dependency (`kete-terminal.xml`).
- `packages/kete-jetbrains/build.gradle.kts` — plugin configuration (id, sinceBuild, verifier IDE from
  `-PverifyIde`, release bundling from `-PketeBinaries`, Marketplace token from the environment).
- `KeteToolWindowFactory` (`KeteToolWindow.kt`) — creates a `ChatPanel` per tool window content, or the
  no-JCEF message with "Open in Terminal".

## Key files

All under `packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/`. `core/` has no IntelliJ
imports and is unit-tested (JUnit 5, `src/test/kotlin/.../core/`).

- `KeteRuntime.kt` — app service: one `kete serve --stdio --hostname 127.0.0.1 --port 0` per IDE
  (cwd = home, the user's shell environment via `EnvironmentUtil`, `KETE_PASSWORD`,
  `KETE_PERMISSION_MODE`), start-line wait (60 s), restart with `Backoff`, stop on dispose or when the last
  project closes; `cli()` for `whoami`/`login`/`logout`/`debug paths`; the account; the `/api/event`
  stream → `Attention`, routed to the project whose chat shows the session.
- `KeteProject.kt` — project service: chats and their ready state/queue, `hello` handshake (theme,
  editor context, queued `openSession`, `kete.workspace`, queued context, `kete.panel`), editor context
  (debounced 150 ms), Add to Kete Code, review (`DiffManager` + `SimpleDiffRequestChain`, before-text
  from `ReviewDiff`), revert (confirmation, `WriteCommandAction`), session picker, badge and
  notifications.
- `ChatPanel.kt` — `JBCefBrowser` + `JBCefJSQuery`; injects `Bridge.bridgeScript` on main-frame load
  only for the runtime's origin; drops messages unless the browser shows that origin; external links and
  popups go to the system browser.
- `EditorToolsServer.kt` — app service: `com.sun.net.httpserver` on 127.0.0.1:0, `/mcp/<random key per
  project>`, `PUT /api/experimental/mcp/editor?directory=<project>` after every runtime start.
- `KeteSettings.kt` — `KeteSettingsService` (stored in `kete-code.xml`: cliPath, defaultMode,
  shareEditorContext, notifications, editorTools, gatewayUrl, platformUrl, sessionBudget, dismissed
  notices, cliHintDismissed) and the `Settings → Tools → Kete Code` page; `syncConfig` edits `kete.jsonc`.
- `KeteStatusBar.kt`, `KeteActions.kt` (actions, `KeteAccount` sign-in/out), `KeteTheme.kt` (LAF →
  `kete.theme`), `KeteTerminal.kt` (`TerminalToolWindowManager.createShellWidget` + quoted binary).
- `core/` — `Json.kt` (strict JSON), `Runtime.kt` (`StartLine`, `Pairing`, `Backoff`, `Paths.insideWorkspace`,
  `Shell.quote`), `Binary.kt`, `Bridge.kt`, `ContextFilter.kt` (`SECRET` = editor-context.ts's regex),
  `ReviewDiff.kt` (port of review.ts), `Events.kt` (port of events.ts), `EditorTools.kt` (port of
  editor-tools.ts), `Account.kt` (whoami, authorize URL, sessions), `Panel.kt` (notices = panel.ts's),
  `KeteConfig.kt` (`Jsonc.set`, `PluginSettings.mapped`), `Theme.kt`, `Status.kt`.
- `packages/app/src/kete/ide-host.ts` — host detection and transport for both editors; `vscode-host.tsx`
  uses it for every post and listener.

## Data flow

1. Tool window opens → `KeteProject.attach` → `KeteRuntime.connection()` starts the runtime →
   `ChatPanel.load` with `Pairing.url` (password only in the fragment).
2. Page loads → plugin injects the bridge → web UI posts `kete.hello` → `KeteProject.hello` sends theme,
   editor context, workspace, queued messages and the panel state.
3. Editor selection/file changes → `scheduleEditorContext` → `ContextFilter.editorContext` (local project
   file, not secret, not excluded/ignored/outside content) → `kete.editorContext` to ready chats.
4. Runtime events → `Events.reduce` → status bar + badge; `Change` → notification in the right project
   when its tool window is hidden.
5. Review Changes → `GET /api/session/:id/diff` → `ReviewDiff.before` per file → diff viewer; Revert File
   uses the stored before-text.
6. Runtime (re)start → every chat reloads (new port and password) and every project re-registers its
   editor tools.

## Data and APIs used

- CLI: `kete serve --stdio …`, `kete whoami --format json`, `kete login --no-browser`, `kete logout`,
  `kete debug paths`.
- Runtime API (Basic auth `opencode:<password>`): `GET /api/event`, `GET /api/permission/request?directory=`,
  `GET /api/session?directory=`, `GET /api/session/:id`, `GET /api/session/:id/diff`,
  `PUT /api/experimental/mcp/editor?directory=`, `POST /api/location/reload`.
- IntelliJ APIs: JCEF (`JBCefBrowser`, `JBCefJSQuery`, CEF load/request/life-span handlers), `DiffManager`,
  `DaemonCodeAnalyzerEx.processHighlights`, `ProjectFileIndex`, `FileTypeManager`, notifications,
  status-bar widget, Kotlin UI DSL, the Terminal plugin (optional).

## Rules that must not break

- Never run a `kete` from the `PATH`; only `Binary.resolve`'s result.
- The pairing password only in the URL fragment; never logged.
- Bridge: a message type must be in `Bridge.FROM_PAGE`/`TO_PAGE` and in the web UI's validators; keep the
  lists equal to `packages/kete-vscode/src/chat.ts`'s (`BridgeTest` pins them). Inject the bridge only
  into the runtime's origin; never `executeJavaScript` a message except through `deliverScript`.
- Every path from the page goes through `Paths.insideWorkspace`; editor context and diagnostics through
  `ContextFilter.shareable` (secrets, IDE-excluded/ignored, outside content).
- Diagnostics MCP server: `EditorTools.authorized` (no `Origin`, exactly one `Host` equal to
  `127.0.0.1:<port>`, timing-safe bearer compare). No terminal output is exposed.
- Notification text is escaped (`notify` in `Common.kt`); it can hold session titles and CLI output.
- `kete.jsonc` edits keep comments and only touch the plugin's three keys; an empty setting writes nothing.
- No agent logic, no direct platform calls: account and config changes go through the CLI or the runtime.

## Testing

- Narrowest (needs a JDK, else CI): `./gradlew test --tests 'ai.ketecode.jetbrains.core.BridgeTest'`.
- Package: `./gradlew buildPlugin test`; verifier: `./gradlew verifyPlugin -PverifyIde=<code>:<version>`.
- CI: `kete-jetbrains.yml` (path-filtered) — build, tests, zip check, web UI IDE-host tests, verifier
  matrix (IC 2024.3.7, IC 2025.2.6, IU/PY/WS/GO 2026.2.3).
- Web UI side: `bun test --conditions=solid --preload ./happydom.ts ./src/kete` in `packages/app`
  (`ide-host.test.ts`: detection, queued transport, JetBrains theme mapping, validators).
- Real IDE: the manual smoke checklist in `packages/kete-jetbrains/README.md`.

## Changes

- New bridge message: add it to `Bridge.kt` (`FROM_PAGE`/`TO_PAGE` and `parse`), `chat.ts`'s lists,
  `vscode-messages.ts`, and both hosts' handlers (`KeteProject.receive`, `vscode-host.tsx`).
- New setting: `KeteSettingsService.Settings`, `PluginSettings` (+ `mapped` if it reaches the runtime),
  `KeteConfigurable`.
- New verifier IDE: the `verify` matrix in `kete-jetbrains.yml` (`<product code>:<version>`).
- Gradle upgrade: `./gradlew wrapper --gradle-version <v> --gradle-distribution-sha256-sum <sha>`; commit
  the jar, scripts and properties (CI validates the jar).

## Gotchas

- The tests' JVM method names can't contain `;`, `.`, `:`, `/`, `<`, `>`, `[`, `]` (Kotlin backtick names).
- The plugin uses the IDE's Kotlin standard library (`kotlin.stdlib.default.dependency=false`), so
  `apiVersion`/`languageVersion` stay at 2.0 (the stdlib shipped by 2024.3).
- The runtime's event stream carries every streamed token: only attention changes reach the UI thread.
- Restarts change the port and password: chats reload and editor tools re-register on every `Running`.
- `ReviewDiff.before` throws when a partial-context patch no longer matches the file ("the file changed
  since this turn"); that file is skipped from the review, by design.
- The Windows terminal command is PowerShell syntax (`& "<path>"`), the IDE terminal's default shell there.
