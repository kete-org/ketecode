# Plan: JetBrains plugin (IntelliJ Platform), parity with the VS Code extension

<!-- Written by the build agent from spec.md and the module cards. This file list is the implementer's reading list. -->

## Cards read
- docs/context/modules/vscode-extension.md (verified-at 6c3649e3a6, stale: no)
- docs/context/modules/web-app.md (for `panel-state.ts` / `panel.tsx`)

## Decisions taken while planning (spec said "take the recommended option")
- **Toolchain:** Gradle 9.8.0 (wrapper committed: `gradle-wrapper.jar` extracted from the official
  `gradle-9.8.0-bin.zip` and checked against `gradle-9.8.0-wrapper.jar.sha256`; `gradlew`/`gradlew.bat`
  from the `v9.8.0` tag of gradle/gradle; `gradle-wrapper.properties` pins `distributionSha256Sum`),
  IntelliJ Platform Gradle Plugin 2.19.0, Kotlin 2.x, JDK 21 toolchain. Compiled against IntelliJ IDEA
  Community 2024.3 (the oldest supported, build 243) so newer-only APIs can't slip in; `untilBuild` unset.
- **Bundled binaries and the 400 MB Marketplace limit (D4):** one `kete` binary is ~80–93 MB
  compressed, so six platforms (~520 MB) don't fit in one Marketplace upload (limit 400 MB, per
  JetBrains' "common errors" page). The release therefore attaches **per-OS plugin zips**
  (`kete-code-jetbrains-<v>-{macos,linux,windows}.zip`, two architectures each) plus
  `kete-code-jetbrains-<v>.sha256`. The manual publish workflow uploads one file to the Marketplace;
  it refuses unless the chosen zip is ≤ 400 MB and documents that a single Marketplace listing for all
  platforms needs a follow-up decision (runtime download vs. per-OS listings). Recorded in result.md.
- **Host detection (spec 3):** the plugin loads `/connect?kete-host=jetbrains#<pairing>` in JCEF; the
  web UI remembers the flag in `sessionStorage` (the connect page navigates away from the query) and
  also accepts the injected bridge marker `window.__keteJetBrains`. VS Code detection (frame name
  `kete-vscode` inside a parent window) is unchanged.
- **Bridge transport:** JS → Kotlin through `JBCefJSQuery` (`window.__keteJetBrains.postMessage`, JSON),
  Kotlin → JS by `executeJavaScript` dispatching a `kete-jetbrains-message` `CustomEvent`. Same message
  names as the VS Code relay (`fromFrame`/`toFrame`), validated on both sides. The theme message is the
  same `kete.theme` (kind + `--vscode-*` variables): Kotlin maps the IDE's LAF colours onto the VS Code
  variable names, so `vscode-theme.ts` stays the single token mapping.
- **Diagnostics tool:** the IDE has no project-wide "problems" list for unopened files; the tool reports
  the daemon's highlights (errors/warnings) for the requested file, or for every open editor when no
  path is given. Same MCP contract, bearer token, exact loopback Host, no Origin.
- **One runtime per IDE process** (application service), cwd = home; each project passes its directory
  (`kete.workspace`, `?directory=`). One editor-tools MCP server per IDE with a path per project.
- **Settings:** plugin-local settings (cliPath, default mode, context sharing, notifications, editor
  tools) live in an application `PersistentStateComponent` (the IDE equivalent of VS Code settings);
  gateway URL / platform URL / session budget are written into the global `kete.jsonc` by an in-place
  JSONC edit (comments kept), like `settings.ts`. The runtime's `PATCH /api/experimental/config` only
  accepts `shell`, so it can't carry these.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/kete-vscode/src/{server,binary,chat,events,editor-context,review,editor-tools,settings,account,sessions,status,panel}.ts | read | behaviour to mirror |
| packages/app/src/kete/vscode-host.tsx | change | use the IDE-host layer (post/listen/detect) instead of `window.parent` directly |
| packages/app/src/kete/ide-host.ts (+ `ide-host.test.ts`) | new | host detection (VS Code/JetBrains), post/listen transport |
| packages/app/src/kete/panel-state.ts | change | `Host` gains `"jetbrains"`; tip visible in any IDE host |
| packages/app/src/kete/tokens.css | change | `[data-kete-host="jetbrains"]` font rule |
| packages/kete-jetbrains/** | new | the plugin (Gradle, Kotlin, resources, tests, README) |
| .github/workflows/kete-jetbrains.yml | new | build, test, verify |
| .github/workflows/kete-release.yml | change | `jetbrains` job + attach in `publish` |
| .github/workflows/kete-jetbrains-publish.yml | new | manual Marketplace publish |
| docs/release.md | change | JetBrains section |
| docs/context/modules/jetbrains-plugin.md, docs/context/INDEX.md | new / change | card + row |

## Steps
1. Web UI: add `ide-host.ts` (pure `detectHost`, `postToHost`, `onHostMessage`), switch `vscode-host.tsx` to it, extend `panel-state.ts`/`tokens.css`; tests for detection, JetBrains transport, theme and message validation.
2. Plugin skeleton: Gradle wrapper, `build.gradle.kts`, `plugin.xml`, icons from `assets/brand`.
3. Pure Kotlin (`ai.ketecode.jetbrains.core`): `Json`, `StartLine`, `Binary`, `ContextFilter`, `ReviewDiff`, `Bridge`, `Events`, `EditorTools`, `Account`, `Sessions`, `KeteConfig` (JSONC edit), `Panel`, `Theme`, `Paths`, `Shell`; JUnit 5 tests for each.
4. IDE glue (`ai.ketecode.jetbrains`): runtime service, project service, chat tool window (JCEF + fallback), actions (Alt+K), review/revert, notifications + badge, status-bar widget, settings page, editor-tools MCP server, terminal.
5. CI: `kete-jetbrains.yml`; release job; publish workflow. actionlint.
6. Draft PR, iterate until green.
7. Docs, card, result, metrics.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | CI `kete-jetbrains.yml`: `./gradlew buildPlugin test` then `./gradlew verifyPlugin -PverifyIde=<code>:<version>` per IDE (IC 2024.3, IC 2025.3, IU/PY/WS/GO 2026.2) |
| AC2 | CI `./gradlew test` (JUnit 5 reports) |
| AC3 | `cd packages/app && bun test --conditions=solid --preload ./happydom.ts ./src/kete`; `bun run typecheck` |
| AC4 | actionlint on `kete-release.yml`, `kete-jetbrains-publish.yml`; review the tag checks |
| AC5 | `bun run --cwd packages/kete-tools upstream:check`; `node scripts/agent/stale-cards.mjs`; `node scripts/agent/card-check.mjs` |
| AC6 | README "Manual smoke checklist" exists |

## Cards to update after the build
- new `jetbrains-plugin`; `vscode-extension` (web UI bridge now goes through `ide-host.ts`).
