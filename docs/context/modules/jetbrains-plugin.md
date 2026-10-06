---
module: jetbrains-plugin
paths: [packages/kete-jetbrains/**, packages/app/src/kete/ide-host.ts, packages/app/src/kete/ide-host.test.ts, .github/workflows/kete-jetbrains.yml, .github/workflows/kete-jetbrains-publish.yml]
verified-at: 370606839e
---

## Quick answers

- **What is it?** Kete Code for IntelliJ-platform IDEs (plugin ID `ai.ketecode.kete-code`, vendor Kete
  Code, `sinceBuild` 243, no `untilBuild`): a thin client of its own `kete serve`, the JetBrains
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
- **How do messages travel?** Page → plugin: `window.__keteJetBrains.postMessage(msg)` → a
  `{nonce, message}` envelope through a `JBCefJSQuery` → `core/Bridge.kt` `open` (the current load's
  nonce, constant-time; then allowlist `FROM_PAGE`, field validation, 64 KB cap) → `KeteProject.receive`.
  The nonce (`Bridge.newNonce`, new on every main-frame load start) lives only in the injected script's
  closure: `cefQuery_*` exists in every frame, so a cross-origin iframe could otherwise call it. Plugin → page: `Bridge.deliverScript` (allowlist `TO_PAGE`) runs
  `window.dispatchEvent(new CustomEvent("kete-jetbrains-message", { detail: JSON.parse("<literal>") }))`;
  `ide-host.ts` `onHostMessage` hands `detail` to the same validators (`vscode-messages.ts`,
  `vscode-theme.ts`). Message names are the VS Code relay's (`packages/kete-vscode/src/chat.ts`).
- **Which binary runs?** `core/Binary.kt` `resolve`, in order: the CLI path setting (absolute paths only,
  development); `<plugin>/bin/<os>-<arch>/kete[.exe]` (per-OS zips; darwin/linux/windows × arm64/x64, x64
  folders hold the `-baseline` CLI builds); the one downloaded earlier for this plugin version,
  `<IDE system dir>/kete-code/cli/<version>/<os>-<arch>/kete[.exe]`; else `Resolved.Download`. Never the
  `PATH`. A missing executable bit is restored; a bundled or downloaded file that can't run is an error,
  never a reason to download.
- **How does the Marketplace build get its `kete`?** It carries none (six binaries are ~520 MB; the
  Marketplace takes 400 MB). `KeteRuntime.binary()` → `KeteCliDownloads.binary()`: without consent
  (`cliDownloadConsent`, app setting) it shows a sticky notification ("Kete Code CLI download" group) and
  throws `KeteCliMissingException` → `RuntimeStatus.Failed(download = true)` → the chat offers Download.
  With consent, a `Task.Backgroundable` runs `core/CliInstall.kt` and callers wait. `CliInstall`: file
  lock in the root; `SHA256SUMS` (≤ 64 KB) + `SHA256SUMS.sig` (exactly 64 bytes) from
  `kete-org/kete-releases` `kete-v<pluginVersion>`, Ed25519-verified (`core/CliRelease.kt`, JDK
  `Signature("Ed25519")`) against the jar's `ai/ketecode/jetbrains/update-keys.json`; archive (≤ 300 MB)
  hashed while streaming; only `kete[.exe]` extracted (Commons Compress from the platform; any absolute name,
  `..`, link or duplicate in the archive refuses it; ≤ 1 GiB); `--version` must report the version; one
  `ATOMIC_MOVE` into place (retried 5× on `FileSystemException`, e.g. Windows AV); other versions removed
  (links/junctions never followed). Each IDE (major version) has its own copy in its system folder. HTTP: `HttpRequests` with a tuner refusing non-HTTPS on every redirect hop. A
  failed download isn't retried until Retry/Download (`lastFailure`).
- **Where do the pinned keys come from?** Gradle's `generateUpdateKeys` copies
  `packages/cli/src/kete/update-keys.json` (validated: ≥ 1 key, 32-byte base64) into the jar's resources;
  `UpdateKeysResourceTest` compares bytes, the release job `cmp`s the jar's copy.
- **What does a release attach?** `kete-release.yml`'s `jetbrains` job: the Marketplace zip
  `kete-code-jetbrains-<v>.zip` (no `-PketeBinaries`; checked: no `bin/`, < 400 MB) and
  `kete-code-jetbrains-<v>-{macos,linux,windows}.zip` with binaries, plus the `.sha256`.
  `kete-jetbrains-publish.yml` uploads the Marketplace zip after checking it and verifying the tag's
  kete-releases release with `script/verify-public-release.ts` (bun, `release-verify.ts`): signature
  against the zip's own keys, SHA-256 of the six archives the plugin picks (`ArchiveTargetsTest` keeps the
  list equal to `Binary.targets`).
- **Why does revert refuse a path inside the project?** `Paths.insideWorkspace` is lexical and then
  `Paths.realInside`: the target (or its nearest existing parent) after `toRealPath()` must be inside the
  real project folder, and a dangling link is refused. `confirmRevert` shows the resolved path and checks
  again before writing. `ReviewDiff.reviewStatus`/`revert`: an added file that's gone stays "added"
  (nothing to do), never restored as an empty file.
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
- `ChatPanel.kt` — `JBCefBrowser` + `JBCefJSQuery`; injects `Bridge.bridgeScript(nonce)` on main-frame
  load only for the runtime's origin; drops messages (and doesn't `post`) unless the browser shows that
  origin, and messages without the current nonce; navigations away open the system browser only on a
  user gesture, at most once a second (`core/ExternalLinks.kt`); popups open nothing (JCEF gives them no
  gesture), the bridge script turns real clicks on `target="_blank"` links into navigations instead.
- `EditorToolsServer.kt` — app service: `com.sun.net.httpserver` on 127.0.0.1:0, `/mcp/<random key per
  project>` with its own bearer token, rotated on every registration; `PUT
  /api/experimental/mcp/editor?directory=<project>` after every runtime start.
- `KeteCliDownload.kt` — app service `KeteCliDownloads`: download root and plugin version, consent
  notification, the one in-flight download (`Task.Backgroundable`, cancellable), `IdeFetcher`
  (`HttpRequests`, 15 s connect / 60 s read, HTTPS-only tuner), `probe` (`kete --version`, 60 s), and
  restart + account refresh after an install.
- `KeteSettings.kt` — `KeteSettingsService` (stored in `kete-code.xml`: cliPath, defaultMode,
  shareEditorContext, notifications, editorTools, gatewayUrl, platformUrl, sessionBudget, dismissed
  notices, cliHintDismissed, cliDownloadConsent) and the `Settings → Tools → Kete Code` page; `syncConfig` edits `kete.jsonc`
  and writes it with `core/AtomicFile.kt` (temp file in the same folder, `ATOMIC_MOVE`, a symlink's
  target replaced, permissions kept).
- `KeteStatusBar.kt`, `KeteActions.kt` (actions, `KeteAccount` sign-in/out), `KeteTheme.kt` (LAF →
  `kete.theme`), `KeteTerminal.kt` (`TerminalToolWindowManager.createShellWidget` + quoted binary).
- `core/` — `Json.kt` (strict JSON), `Runtime.kt` (`StartLine`, `Pairing`, `Backoff`, `Paths.insideWorkspace`,
  `Shell.quote`), `Binary.kt`, `CliRelease.kt` (pinned keys, Ed25519, `SHA256SUMS`, archive names —
  mirrors `packages/cli/src/kete/release-verify.ts`), `CliInstall.kt` (installer + `Archives`), `Bridge.kt`, `ContextFilter.kt` (`SECRET` = editor-context.ts's regex),
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
  `kete debug paths`, `kete --version` (download probe).
- Public releases: `https://github.com/kete-org/kete-releases/releases/download/kete-v<v>/{SHA256SUMS,SHA256SUMS.sig,kete-<v>-<target>.zip|tar.gz}`.
- Runtime API (Basic auth `opencode:<password>`): `GET /api/event`, `GET /api/permission/request?directory=`,
  `GET /api/session?directory=`, `GET /api/session/:id`, `GET /api/session/:id/diff`,
  `PUT /api/experimental/mcp/editor?directory=`, `POST /api/location/reload`.
- IntelliJ APIs: JCEF (`JBCefBrowser`, `JBCefJSQuery`, CEF load/request/life-span handlers), `DiffManager`,
  `DaemonCodeAnalyzerEx.processHighlights`, `ProjectFileIndex`, `FileTypeManager`, notifications,
  status-bar widget, Kotlin UI DSL, the Terminal plugin (optional).

## Rules that must not break

- Never run a `kete` from the `PATH`; only `Binary.resolve`'s result.
- Nothing lands in `<system>/kete-code/cli/<version>/<platform>/` unless the signature, checksum, safe
  extraction and version probe all passed (`Binary.resolve` trusts what it finds there). Signature before
  checksum before extraction; no network request before consent; never wrap or swallow the IDE's
  `ProcessCanceledException` (only `IOException`s are mapped in `CliInstall`).
- The pairing password only in the URL fragment; never logged. The runtime's stdout/stderr lines are never
  logged either (`KeteRuntime.drain` logs only a line count).
- Bridge: a message type must be in `Bridge.FROM_PAGE`/`TO_PAGE` and in the web UI's validators; keep the
  lists equal to `packages/kete-vscode/src/chat.ts`'s (`BridgeTest` reads chat.ts through the
  `kete.vscodeChat` system property set in `build.gradle.kts`, so drift fails the test). Inject the bridge only
  into the runtime's origin; never `executeJavaScript` a message except through `deliverScript`.
- Every path from the page goes through `Paths.insideWorkspace` (lexical + real path); editor context and diagnostics through
  `ContextFilter.shareable` (secrets, IDE-excluded/ignored, outside content).
- Diagnostics MCP server: `EditorTools.authorized` (no `Origin`, exactly one `Host` equal to
  `127.0.0.1:<port>`, timing-safe bearer compare). No terminal output is exposed.
- Notification text is escaped (`notify` in `Common.kt`); it can hold session titles and CLI output.
- `kete.jsonc` edits keep comments and only touch the plugin's three keys; an empty setting writes nothing.
- No agent logic, no direct platform calls: account and config changes go through the CLI or the runtime.

## Testing

- Narrowest (needs a JDK, else CI): `./gradlew test --tests 'ai.ketecode.jetbrains.core.BridgeTest'`.
  Locally `export JAVA_HOME=/opt/homebrew/opt/openjdk@21` works.
- Download: `CliReleaseTest`, `CliInstallTest` (test Ed25519 key, fake fetcher), `BinaryTest`,
  `UpdateKeysResourceTest`; opt-in live: `KETE_LIVE_RELEASE=0.2.4 ./gradlew test --tests '*CliLiveReleaseTest*'`
  (`KETE_LIVE_TARGET=linux-arm64` checks a tar.gz without running it).
- Package: `./gradlew buildPlugin test`; verifier: `./gradlew verifyPlugin -PverifyIde=<code>:<version>`.
- CI: `kete-jetbrains.yml` (path-filtered, includes `packages/kete-vscode/src/chat.ts`) — build, tests,
  zip check, web UI IDE-host tests, verifier: pull requests only IC 2024.3.7; pushes to main and
  workflow_dispatch the full matrix (IC 2024.3.7, IC 2025.2.6, IU/PY/WS/GO 2026.2.3).
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
- Commons Compress comes from the IDE (`lib-client.jar` in 2024.3, 1.26.1): use APIs that exist there
  (`ZipFile(Path)`, not the builder); the Plugin Verifier checks it resolves in every verified IDE.
- `Status.serverLine` says "stopped: <reason>"; the crash path's reason carries "Stopped restarting after
  N failures" itself.
- `ReviewDiff.before` throws when a partial-context patch no longer matches the file ("the file changed
  since this turn"); that file is skipped from the review, by design.
- The Windows terminal command is PowerShell syntax (`& "<path>"`), the IDE terminal's default shell there.
