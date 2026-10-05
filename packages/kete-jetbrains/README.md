# Kete Code for JetBrains IDEs

Kete Code in IntelliJ IDEA, PyCharm, WebStorm, GoLand, PhpStorm, RubyMine, CLion, Rider, RustRover and
Android Studio (2024.3 and later, build 243+). Like the VS Code extension, the plugin is a thin client
of the Kete Code runtime bundled with it: it starts its own `kete serve`, shows the runtime's web UI,
and never contains agent logic (CLAUDE.md §3, §6). Plugin ID `ai.ketecode.kete-code`, vendor Kete Code.

## Features

- **Chat** in the **Kete Code** tool window (right side): the runtime's web UI in the IDE's embedded
  browser (JCEF), themed from the IDE's colours and fonts. The permission-mode toggle, approvals,
  sessions and models work as in the web UI. Without JCEF the tool window explains why and offers
  **Open in Terminal**.
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
| Which binary: `bin/<os>-<arch>/kete[.exe]` or the CLI path setting, never the `PATH` | `core/Binary.kt` |
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
```

A development build has no bundled binary: set **Settings → Tools → Kete Code → CLI path** to a `kete`
you built (`bun run build --single --skip-install --skip-web-ui` in `packages/cli`).

**Gradle wrapper:** Gradle 9.8.0. `gradle/wrapper/gradle-wrapper.jar` was extracted from the official
`gradle-9.8.0-bin.zip` (`lib/plugins/gradle-wrapper-main-9.8.0.jar`) and matches the published
`gradle-9.8.0-wrapper.jar.sha256` (`238e777f…21abd5`); `gradlew` and `gradlew.bat` are those of Gradle's
`v9.8.0` tag; `gradle-wrapper.properties` pins the distribution's SHA-256. CI checks the jar with
`gradle/actions/wrapper-validation`. To upgrade, run `./gradlew wrapper --gradle-version <v>
--gradle-distribution-sha256-sum <sha>` and commit the four files.

## Releases

`kete-release.yml` builds one plugin zip per OS (`kete-code-jetbrains-<v>-{macos,linux,windows}.zip`,
both architectures each) with the released binaries, plus an all-platform zip only if it fits the
JetBrains Marketplace's 400 MB limit, and attaches them to the GitHub Release. Install one with
**Settings → Plugins → ⚙ → Install Plugin from Disk…**. Publishing to the Marketplace is a separate,
manual step (`kete-jetbrains-publish.yml`); see `docs/release.md` ("Publish the JetBrains plugin"),
including the size-limit decision (the Marketplace build will download a verified `kete` on first
use; a follow-up before the first Marketplace publish).

## Manual smoke checklist

CI can't drive a real IDE. Before publishing a version to the Marketplace, a maintainer installs the
release's zip for their OS into a clean IDE (and ideally one other product, e.g. PyCharm) and checks:

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
