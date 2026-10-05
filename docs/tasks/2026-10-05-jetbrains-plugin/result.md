# Result: JetBrains plugin (IntelliJ Platform), parity with the VS Code extension

Built on `feature/jetbrains-plugin` (draft PR kete-org/ketecode#5). No JDK locally: GitHub Actions
compiled, tested and verified every revision.

## What changed
**Web UI (`packages/app/src/kete`)**
- `ide-host.ts` (new): host detection (`detectHost`: VS Code's `kete-vscode` frame, or JetBrains via
  `?kete-host=jetbrains`, the remembered `sessionStorage` flag or the injected `window.__keteJetBrains`)
  and transport (`postToHost`, queued until the JetBrains bridge is ready; `onHostMessage`). `ide-host.test.ts` (new).
- `vscode-host.tsx`: every post/listener goes through `ide-host.ts`; `data-kete-host` and the panel's
  `host` come from `currentHost()`. Merged with main's race fix (editor chip reported on composer mount).
- `panel-state.ts` (`Host` + `"jetbrains"`, tip in any editor host), `tokens.css` (editor fonts for `jetbrains`).

**Plugin (`packages/kete-jetbrains`, new)**
- Gradle: `build.gradle.kts` (IntelliJ Platform Gradle Plugin 2.19.0, Kotlin 2.2.21 with API/language 2.0,
  JDK 21, compiled against IC 2024.3.7, `sinceBuild` 243, no `untilBuild`, verifier IDE from `-PverifyIde`,
  release bundling from `-PketeBinaries`), `settings.gradle.kts`, `gradle.properties`, Gradle 9.8.0 wrapper
  (jar extracted from the official distribution, SHA-256 matches `gradle-9.8.0-wrapper.jar.sha256`;
  `distributionSha256Sum` pinned; CI runs wrapper-validation), `LICENSE`, `README.md`.
- `core/` (pure, JUnit 5-tested): `Json`, `Runtime` (start line, pairing URL, Basic auth, backoff,
  `insideWorkspace`, shell quoting), `Binary`, `Bridge`, `ContextFilter`, `ReviewDiff`, `Events`,
  `EditorTools`, `Account` (+ sessions), `Panel`, `KeteConfig` (JSONC in-place edit, `PluginSettings.mapped`),
  `Theme`, `Status`.
- IDE glue: `KeteRuntime` (one `kete serve` per IDE, restart/backoff, account, event stream),
  `KeteProject` (chats, hello handshake, editor context, Add to Kete Code, review/revert, sessions,
  badge/notifications), `ChatPanel` (JCEF + JBCefJSQuery bridge, origin checks, external links to the
  system browser), `KeteToolWindow` (factory with no-JCEF fallback, startup listeners, focus/close
  listeners), `KeteActions` (Alt+K and the Tools menu, sign in/out), `KeteStatusBar`, `KeteSettings`
  (settings page + `kete.jsonc` sync), `EditorToolsServer` (diagnostics MCP), `KeteTheme`, `KeteTerminal`,
  `plugin.xml`, icons from the mark (`assets/brand` geometry via `kete-vscode/media`).

**CI / release**
- `.github/workflows/kete-jetbrains.yml` (new): wrapper validation, `./gradlew buildPlugin test`, zip
  check, web UI IDE-host tests, Plugin Verifier matrix.
- `.github/workflows/kete-release.yml`: `jetbrains` job (per-OS zips + all-platform zip only if ≤ 400 MB,
  checks, `.sha256`, artifact); `image` and `publish` need it; `publish` attaches the zips.
- `.github/workflows/kete-jetbrains-publish.yml` (new): manual, on a stable tag, environment
  `jetbrains-marketplace`, secret `JETBRAINS_MARKETPLACE_TOKEN`, refuses pre-releases; verifies and
  uploads the all-platform zip through the Marketplace API.

**Docs**: `docs/release.md` (channels, "Publish the JetBrains plugin", CI step, assets, folders), new
card `docs/context/modules/jetbrains-plugin.md` + INDEX and repo-map rows; refreshed `vscode-extension`,
`web-app`, `ui-branding`, `kete-tools-ci`, `job-image`.

## Checks
| Check | Result |
|---|---|
| CI `kete-jetbrains` (final run 37255810424, commit a7fb2cbcbf) | pass: build + 59 JUnit tests (Gradle 9 fails a test task that discovers none) + zip check + web UI tests; verifier Compatible on all six IDEs |
| CI `kete-build` (final run 37255810624) | pass (build, kete-checks) |
| `packages/app`: `bun run typecheck` | pass |
| `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/kete` | pass: 74/74 (VS Code host tests unchanged) |
| root `bun run lint` | pass: 0 warnings, 0 errors |
| `bun run --cwd packages/kete-tools upstream:check` | pass (no `isKeteOwned` change needed: `kete` is in every new path) |
| actionlint on `kete-jetbrains.yml`, `kete-jetbrains-publish.yml`, `kete-release.yml` | pass |
| `node scripts/agent/stale-cards.mjs` | All cards current |
| `node scripts/agent/card-check.mjs` | ✓ 29 cards and docs/context clean |
| Release `jetbrains` job and the publish workflow | not run (instructed); actionlint only |

Verifier IDEs: IntelliJ IDEA Community 2024.3.7 (oldest supported) and 2025.2.6 (2025.3 has no Linux
x64 build), IntelliJ IDEA 2026.2.3, PyCharm 2026.2.3, WebStorm 2026.2.3, GoLand 2026.2.3. All
"Compatible". Remaining notes: on 2026.2, 7 deprecated / 6 experimental usages; on IC 2024.3 and 2025.2,
6 deprecated / 2 experimental / 6 internal usages. They are the overrides the Kotlin compiler synthesises
for `ToolWindowFactory`/`StatusBarWidget` interface defaults (`getAnchor`, `getIcon`, `manage`,
`isApplicable`, `isDoNotActivateOnStart`, `getPresentation(PlatformType)`) plus the deprecated
`TerminalToolWindowManager.createShellWidget`; the plugin's own internal-API calls
(`PluginManagerCore.getPlugin`, `PluginManager.getPluginByClass`) and `ReadAction.compute` were removed.

## Acceptance criteria
- [x] AC1 — `kete-jetbrains.yml` build + verify jobs green against IC (2), IU, PY, WS, GO, no compatibility problems.
- [x] AC2 — JUnit 5: start line (`StartLineTest`), binary per OS/arch (`BinaryTest`), secret/exclude
  filtering (`ContextFilterTest`), diff reconstruction (`ReviewDiffTest`), bridge allowlists
  (`BridgeTest`), settings mapping (`PluginSettingsTest`, `KeteConfigTest`); plus events, MCP tool and
  auth, accounts, sessions, panel, theme, status, JSON.
- [x] AC3 — VS Code tests unchanged and passing; `ide-host.test.ts` covers JetBrains detection, transport,
  theme mapping and message validation.
- [x] AC4 — release `jetbrains` job attaches the zips; `kete-jetbrains-publish.yml` refuses non-stable
  tags. Not run. **Open decision:** six binaries (~520 MB) exceed the Marketplace's 400 MB per-version
  limit, so releases carry per-OS zips and the publish workflow stops until an all-platform zip fits
  (runtime binary download vs. smaller binary) — docs/release.md.
- [x] AC5 — README, docs/release.md section, `jetbrains-plugin` card; `upstream:check` passes.
- [x] AC6 — manual smoke checklist in the README (not run: needs a real IDE).

## Not done / not provable in CI
- Nothing ran inside a real IDE: JCEF rendering, the bridge round trip, the theme, notifications, the
  diff viewer, revert, sign-in, terminal and the diagnostics tool are covered only by the manual checklist.
- High-contrast IDE themes are mapped as light/dark (no reliable high-contrast detection across 243–262).
- The diagnostics tool reports open files' highlights only (no project-wide problems for unopened files).
- Windows terminal command assumes PowerShell (the IDE terminal's default there).

## Security review fixes (2026-10-05)

Merged `origin/main` first (local models, Windsurf, MCP presets; conflicts only in
`docs/context/modules/kete-tools-ci.md` `verified-at` and `docs/tasks/metrics.md`, both sides kept).
All findings fixed as recommended:

| # | Finding | Fix | Tests |
|---|---|---|---|
| 1 | `cefQuery_*` callable from any frame | `{nonce, message}` envelope; nonce from Kotlin (`Bridge.newNonce`, 256-bit), only in the bridge script's closure, new on every main-frame load start, constant-time compare (`Bridge.open`) | `BridgeTest` (envelopes, stale/guessed/missing nonce, script shape, nonce uniqueness) |
| 2 | popups open any URL, no gesture, no limit | popups open nothing (JCEF's `onBeforePopup` has no gesture info); `onBeforeBrowse` opens the system browser only for a main-frame http(s) navigation with `userGesture`, ≤ 1/s (`core/ExternalLinks.kt`); the bridge script turns trusted clicks on `target="_blank"` links into navigations | `ExternalLinksTest`; real-IDE behaviour: README checklist item 10 |
| 3 | lexical-only workspace boundary | `Paths.insideWorkspace` = lexical + `Paths.realInside` (target or nearest existing parent `toRealPath()` inside the real project; dangling links refused); revert confirmation shows the resolved path and re-checks before writing; applies to open-diff and diagnostics too | `PathsTest` with real symlinks in `@TempDir` (dir link, file link, dangling link, missing folders, inside links, project via link) |
| 4 | `post()` without origin guard | same `showsRuntime()` check as the handler | — (JCEF glue) |
| 5 | one bearer token for the IDE's life | per-project token, rotated on every registration (every runtime start/restart); unknown path → 401 | — (IDE glue; `EditorTools.authorized` unchanged and tested) |
| 6 | runtime output in idea.log | `drain` counts lines, logs only the count | — |
| 7 | JSONC parser ignored `\uXXXX` | JSON escapes decoded (`\u` strictly 4 hex digits) | `KeteConfigTest` (escaped keys found, not duplicated; bad escapes refused) |
| 8 | non-atomic `kete.jsonc` write | `core/AtomicFile.kt`: temp file in the same folder, `ATOMIC_MOVE` (fallback `REPLACE_EXISTING`), symlink target replaced, POSIX permissions kept; comments kept as before | `AtomicFileTest` |
| 9 | gone "added" file restored as empty | `ReviewDiff.reviewStatus` keeps "added"; `ReviewDiff.revert` skips (gone added file, or nothing to restore) | `ReviewDiffTest` |
| 10 | allowlist test hard-coded | `BridgeTest` reads `fromFrame`/`toFrame` from `packages/kete-vscode/src/chat.ts` (path via the `kete.vscodeChat` system property, declared as a test input); the workflow's path filter includes chat.ts | itself |
| 11 | six verifier IDEs on every PR | PRs: only IC 2024.3.7 (+ build/test); push to main and workflow_dispatch: all six | actionlint |
| 12 | per-zip `.sha256` | documented (workflow + docs/release.md) that it guards only corruption: the signed `SHA256SUMS` doesn't list the plugin zips | actionlint |

Also recorded in docs/release.md ("Publish the JetBrains plugin") the pre-approved go-live decision for
the 400 MB limit: the Marketplace build downloads the platform's `kete` from `kete-org/kete-releases` on
first use, verified against the Ed25519-signed `SHA256SUMS` with the pinned update key (Java's built-in
Ed25519) before running it. Implementation is a follow-up before the Marketplace publish.

Checks after the fixes: see the PR #5 runs listed in handoff.md; locally `packages/app` typecheck and
74/74 tests, root lint, `upstream:check`, actionlint on both changed workflows, stale-cards and
card-check. Still not exercised in a real IDE: the nonce round trip, link handling and revert dialogs
(README checklist). The symlink check is check-then-write (no lock): a link swapped in between is not
caught.

## Cards updated
New `jetbrains-plugin`; refreshed `vscode-extension` (bridge via `ide-host.ts`), `web-app` (host values,
tip), `ui-branding` (`tokens.css`, `vscode-host.tsx`), `kete-tools-ci` and `job-image` (release job graph).

## Metrics
- Agents used: one build agent (no subagents)
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~3 h (7 CI rounds)
