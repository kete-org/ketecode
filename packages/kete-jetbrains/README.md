# Kete Code for JetBrains IDEs

Kete Code in IntelliJ IDEA, PyCharm, WebStorm, GoLand, PhpStorm, RubyMine, CLion, Rider, RustRover and
Android Studio (2024.3 and later, build 243+). Like the VS Code extension, the plugin is a thin client
of the Kete Code runtime: it starts its own `kete serve`, shows the runtime's web UI, and never
contains agent logic (CLAUDE.md §3, §6). Plugin ID `ai.ketecode.kete-code`, vendor Kete Code.

**Where its `kete` comes from.** The per-OS zips on the GitHub Release bundle it. The JetBrains
Marketplace build doesn't (one zip with every platform's binary is ~520 MB; the Marketplace takes
400 MB): the first time it needs `kete`, the plugin asks, then downloads the `kete` of its own version
for this OS and architecture (about 80–95 MB) from
[github.com/kete-org/kete-releases](https://github.com/kete-org/kete-releases) into the IDE's system
folder (`<system>/kete-code/cli/<version>/<os>-<arch>/`). Before anything runs, it checks the release's
`SHA256SUMS.sig` (Ed25519) against the update keys pinned in the plugin (the ones `kete upgrade`
trusts, copied from `packages/cli/src/kete/update-keys.json` at build time) and the archive's SHA-256
against that signed `SHA256SUMS`; any mismatch, and nothing is installed. The answer is remembered
(**Settings → Tools → Kete Code → Download the kete CLI when the plugin needs it**), so later versions
download with a progress bar and no question. It never falls back to a `kete` on the `PATH`. Each
IDE (and each major IDE version, which has its own system folder) keeps its own downloaded copy, about
180–210 MB unpacked; a new plugin version removes the previous version's copy, but the copies left in
the system folders of IDE versions you no longer use stay until you delete them (or that IDE's system
folder).

## Features

- **Chat** in the **Kete Code** tool window (right side): the runtime's web UI in the IDE's embedded
  browser (JCEF), themed from the IDE's colours and fonts. The permission-mode toggle, approvals,
  sessions and models work as in the web UI. Without JCEF the tool window explains why and offers
  **Open in Terminal**.
- **Task list:** for multi-step work the agent keeps a task list, shown above the message box with the
  item in progress and the count done (click to fold).
- **Context:** the current file and selection follow the editor into the chat as one chip. Secret-looking
  files (`.env`, keys, `.npmrc`, `.netrc`) and anything the IDE excludes or ignores are never shared
  automatically. **Add to Kete Code** (`Alt+K`, editor, editor tab and project-view context menus) adds
  the selection, or the file, explicitly.
- **Review:** **Tools → Kete Code → Review Changes** opens the last turn's changes in the IDE's diff
  viewer (the "before" side rebuilt from the runtime's unified diff; the right side is the editable
  file). **Revert File…** puts a file back as it was before the turn, after a confirmation. Opening a
  changed file in the chat's review also opens its diff.
- **Attention:** a waiting approval or a session that finished while the tool window was hidden raises
  an IDE notification; the tool-window icon shows a badge and the count while approvals wait.
- **Account and sessions:** the status-bar widget shows the runtime state, the signed-in organization
  and waiting approvals, and its menu signs in (`kete login`, approved in the browser) or out, opens a
  session, reviews changes, opens the terminal and restarts the server.
- **Settings → Tools → Kete Code:** CLI path (development only), default permission mode for new
  sessions, context sharing, notifications, the IDE-problems tool, and the gateway URL, platform URL and
  session budget, which are written into Kete Code's global `kete.jsonc` in place (comments kept), so
  the CLI, TUI and every editor share them.
- **IDE problems for the agent:** an MCP tool (`editor` → `diagnostics`) with the IDE's errors and
  warnings for a file, or for every open file, served on 127.0.0.1 with a random bearer token (exact
  loopback `Host`, no `Origin`) and registered with the plugin's own runtime.

## How it works

| Piece | File |
| --- | --- |
| Runtime: `kete serve --stdio`, start line, restart backoff, account, event stream | `KeteRuntime.kt`, `core/Runtime.kt`, `core/Events.kt` |
| Which binary: the CLI path setting, `bin/<os>-<arch>/kete[.exe]`, the downloaded one, else download; never the `PATH` | `core/Binary.kt` |
| First-use download: consent, background task, IDE HTTP stack (proxy, HTTPS only) | `KeteCliDownload.kt` |
| Download verification (Ed25519 `SHA256SUMS.sig`, SHA-256), safe extraction, atomic install | `core/CliRelease.kt`, `core/CliInstall.kt` |
| Chat: JCEF browser, pairing password only in the URL fragment, JS ↔ Kotlin bridge | `ChatPanel.kt`, `core/Bridge.kt` |
| Per project: chats, editor context, review, notifications | `KeteProject.kt`, `core/ContextFilter.kt`, `core/ReviewDiff.kt` |
| Web UI side of the bridge | `packages/app/src/kete/ide-host.ts`, `vscode-host.tsx`, `vscode-messages.ts` |
| Theme: IDE colours → the web UI's `kete.theme` message | `KeteTheme.kt`, `core/Theme.kt` |
| Diagnostics MCP tool | `EditorToolsServer.kt`, `core/EditorTools.kt` |
| Settings and `kete.jsonc` edits | `KeteSettings.kt`, `core/KeteConfig.kt` |

The bridge carries the same messages as the VS Code relay (`packages/kete-vscode/src/chat.ts`):
page → plugin `kete.hello`, `kete.openDiff`, `kete.session`, `kete.contextAdded`,
`kete.editorContextApplied`, `kete.themeApplied`, `kete.dismissNotice`, `kete.dismissCliHint`; plugin →
page `kete.workspace`, `kete.addContext`, `kete.editorContext`, `kete.newSession`, `kete.openSession`,
`kete.panel`, `kete.theme`. Both sides validate against allowlists; the plugin injects the bridge only
into pages from its runtime's origin, accepts messages only while the browser shows that origin, and
opens every other link in the system browser.

## Build and test (in CI)

There is no JDK on the maintainers' machines, so `.github/workflows/kete-jetbrains.yml` is the
compiler: it validates the Gradle wrapper, runs `./gradlew buildPlugin test`, the web UI's IDE-host
tests, and the JetBrains Plugin Verifier against IntelliJ IDEA Community 2024.3 (the oldest supported)
and 2025.2, and IntelliJ IDEA, PyCharm, WebStorm and GoLand 2026.2.

With a JDK 21 locally:

```sh
./gradlew buildPlugin test                          # build/distributions/kete-jetbrains-<version>.zip
./gradlew verifyPlugin -PverifyIde=IU:2026.2.3      # one IDE through the Plugin Verifier
./gradlew runIde                                    # a sandbox IDE with the plugin (set a CLI path in its settings)
./gradlew buildPlugin -PpluginVersion=0.3.0 -PketeBinaries=/path/to/bins   # bundle <bins>/<os>-<arch>/kete[.exe]
KETE_LIVE_RELEASE=0.2.4 ./gradlew test --tests '*CliLiveReleaseTest*'       # opt-in: download and verify a real release
```

A development build (version `0.0.0`) has no bundled binary and no public release to download: set
**Settings → Tools → Kete Code → CLI path** to a `kete` you built (`bun run build --single
--skip-install --skip-web-ui` in `packages/cli`). The build copies `packages/cli/src/kete/update-keys.json`
into the jar and fails if it is missing or has no keys. The live test also takes
`KETE_LIVE_TARGET=linux-arm64` (any `core/Binary.kt` folder) to check another platform's archive
without running it.

**Gradle wrapper:** Gradle 9.8.0. `gradle/wrapper/gradle-wrapper.jar` was extracted from the official
`gradle-9.8.0-bin.zip` (`lib/plugins/gradle-wrapper-main-9.8.0.jar`) and matches the published
`gradle-9.8.0-wrapper.jar.sha256` (`238e777f…21abd5`); `gradlew` and `gradlew.bat` are those of Gradle's
`v9.8.0` tag; `gradle-wrapper.properties` pins the distribution's SHA-256. CI checks the jar with
`gradle/actions/wrapper-validation`. To upgrade, run `./gradlew wrapper --gradle-version <v>
--gradle-distribution-sha256-sum <sha>` and commit the four files.

## Releases

`kete-release.yml` builds the Marketplace zip `kete-code-jetbrains-<v>.zip` (no binary; checked to
have no `bin/` and to fit the Marketplace's 400 MB limit) and one plugin zip per OS
(`kete-code-jetbrains-<v>-{macos,linux,windows}.zip`, both architectures each) with the released
binaries for offline installs, and attaches them to the GitHub Release. Install a per-OS zip with
**Settings → Plugins → ⚙ → Install Plugin from Disk…**. Publishing to the Marketplace is a separate,
manual step (`kete-jetbrains-publish.yml`, which uploads the Marketplace zip); see `docs/release.md`
("Publish the JetBrains plugin").

## Manual smoke checklist

CI can't drive a real IDE. Before publishing a version to the Marketplace, a maintainer installs the
release's zip for their OS into a clean IDE (and ideally one other product, e.g. PyCharm) and checks
1–12; then the Marketplace zip (`kete-code-jetbrains-<v>.zip`) into another clean IDE and checks 13–16:

1. **Tool window:** View → Tool Windows → Kete Code opens on the right; the chat loads (no error page),
   in the IDE's light or dark theme; switching the IDE theme restyles it.
2. **Chat:** send a prompt in a project; the reply streams; a new chat (Tools → Kete Code → New Chat)
   opens a session for the project folder.
3. **Context:** open a file and select lines; the chat shows the file chip with the line range. Open
   `.env`: no chip. `Alt+K` on a selection adds it with lines; Add to Kete Code from the project view
   adds a file.
4. **Review:** ask for an edit to two files; Tools → Kete Code → Review Changes shows both in the diff
   viewer with the pre-turn content on the left; Revert File… asks first, then restores the file.
5. **Permissions:** set new sessions to "ask" (or use the chat's mode toggle), ask for a command, hide
   the tool window: a notification "needs your approval" appears and the tool-window icon shows a badge;
   approve in the chat; the badge clears.
6. **Finished while hidden:** start a longer task, hide the tool window; a "finished" notification
   with Review Changes appears.
7. **Account:** the status-bar widget shows "Kete · Signed out" (or the organization); Sign In opens
   the browser and, once approved, shows the organization; Sign Out returns to signed out.
8. **Sessions:** Open Session… lists the project's sessions and opens the chosen one in the chat.
9. **Diagnostics:** with a type error in an open file, ask the agent to check problems; it calls the
   `editor` `diagnostics` tool and reports the error.
10. **Links:** click an external link in the chat (e.g. in a reply): it opens once in the system
    browser and the chat stays put; a page can't open the browser without a click.
11. **Terminal:** Open in Terminal runs the `kete` TUI in the IDE's terminal.
12. **Restart:** Restart Server; the chat reloads and keeps working. Close the last project: no
    `kete serve` process is left behind.
13. **First-use download, consent:** open the tool window. A notification says the plugin needs its
    kete CLI (version, OS, about 80–95 MB, github.com/kete-org/kete-releases, verified with the signing
    key) with Download / Open Settings, and the chat says so with Download. Nothing is downloaded
    before you choose Download (no traffic to github.com in a proxy log).
14. **Download:** choose Download. A background task shows progress and can be cancelled (cancel once:
    the chat offers Download again and `<system>/kete-code/cli` holds no version folder). Download
    again: the chat starts; `<system>/kete-code/cli/<version>/<os>-<arch>/kete` exists (Help → Show
    Log in Finder/Explorer → the `system` folder is its sibling, or `idea.system.path`).
15. **Failures are honest:** with the network off (or a bad proxy), the error names the URL and points
    at the proxy settings, with Retry and Open Settings; no binary is left behind. A plugin build
    whose version has no public release reports HTTP 404 and suggests the per-OS zip or a CLI path.
16. **Later versions:** after consenting once, a newer plugin version downloads its own kete with a
    progress bar and no question, and removes the old version's folder.
