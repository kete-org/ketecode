# Desktop app

The Kete Code desktop app is upstream OpenCode's Electron app (`packages/desktop`), branded as Kete Code
and launching Kete Code's runtime. It is a thin client like the TUI and the VS Code extension: the web UI
(`packages/app`) talks over HTTP and SSE to a local `kete serve --service`, which the app starts or adopts.
Phase 0 of the Work mode spec; there is no Tauri app.

## How it fits together

| Piece | Where | What it does |
| --- | --- | --- |
| Main process | `packages/desktop/src/main` | Windows, menus, deep links (`kete://`), the background service |
| Preload | `packages/desktop/src/preload` | The bridge `packages/app` uses as its `Platform` |
| Renderer | `packages/desktop/src/renderer` + `packages/app` | The shared web UI |
| Runtime | the bundled `kete` binary | `kete serve --service`, registered in `~/.local/state/kete/service.json` |
| Identity | `packages/util/src/kete/desktop.ts` | App IDs, product names, scheme, package names, update feeds |
| Icons | `packages/desktop/icons/{dev,beta,prod}` | Generated from `assets/brand` (see Icons) |
| Mode profiles | `packages/core/src/kete/modes` | `code.jsonc` (today's behaviour) and a `work.jsonc` placeholder; nothing reads them yet |

The server runs as the compiled Bun binary in its own process, not inside Electron's Node, so the
runtime's Bun APIs need no Node equivalent. The app authenticates with the password the service
registers (HTTP Basic).

Identity per channel:

| Channel | App ID | Name |
| --- | --- | --- |
| `dev` | `ai.ketecode.desktop.dev` | Kete Code Dev |
| `beta` | `ai.ketecode.desktop.beta` | Kete Code Beta |
| `prod` | `ai.ketecode.desktop` | Kete Code |

Updates are off: no channel has a feed in `KeteDesktop.updateFeeds`, so a packaged app never checks for
updates and packaging writes no `app-update.yml`. Setting a channel's feed turns on both, once desktop
releases are signed and published.

## Run it locally

```sh
bun install
bun run --cwd packages/desktop dev
```

`dev` runs the CLI from source (`packages/cli/src/index.ts`) with an isolated state directory, builds the
web UI in the background and opens **Kete Code Dev**. `dev --download-server <version>` uses a published
`@ketecode/cli-<platform>` instead.

## Build and package

```sh
bun run --cwd packages/cli build --single --skip-install --skip-web-ui   # add --baseline for x64
OPENCODE_CHANNEL=dev bun run --cwd packages/desktop build
OPENCODE_CHANNEL=dev bun run --cwd packages/desktop pack
```

`build` bundles the CLI from `packages/cli/dist` when it holds the target, otherwise it downloads
`@ketecode/cli-<platform>` (`latest`; `next` for beta). Production builds require the local CLI. `pack`
writes unsigned packages to `dist/desktop/` at the repository root: macOS `kete-desktop-mac-<arch>.app.tar`,
Windows the unpacked app in `app/`, Linux AppImage, deb and rpm.

Unsigned apps are for testing. macOS blocks them at first: right-click the app and choose **Open**, or run
`xattr -dr com.apple.quarantine "Kete Code Dev.app"`. Windows SmartScreen shows **More info → Run anyway**.

CI (`.github/workflows/kete-desktop.yml`) builds macOS (arm64) and Windows (x64) on pull requests that touch
the desktop, the web UI or the code they share, and uploads the apps as workflow artifacts. Signing,
notarisation and publishing come later; they need certificates this public repository must not hold.

## Icons

```sh
bun run --cwd packages/desktop script/kete-icons.ts [source.png]
```

Redraws every PNG under `icons/{dev,beta,prod}` at its own size from `assets/brand/kete-logo-512.png`
(default) and rebuilds `icon.ico` and `icon.icns`. macOS icons (`icon.icns`, `dock.png`) get Apple's
824/1024 margin; the rest are edge to edge. Commit the results. A 1024px source would make the largest
macOS image sharper than the current 512px one.

## Upstream merges

The desktop and the web UI follow upstream's structure so that syncs stay clean:

- Desktop and web UI changes from upstream arrive only through `upstream:sync` (`docs/upstream-sync.md`),
  never by copying files, cherry-picking or checking out paths.
- Kete Code's edits live in a few places, each marked `kete_change` and listed in
  `docs/upstream-patches.md` ("Desktop app"): the builder config, `src/main/constants.ts`, the CLI staging
  scripts (`script/utils.ts`, `script/build.ts`, `script/pack.ts`), the service file and the user-facing
  names. Identity values come from `packages/util/src/kete/desktop.ts` and `Brand`, never literals.
- New Kete code goes in Kete paths: `packages/desktop/src/main/kete/`, `packages/desktop/script/kete-*`.
- After a sync, look for new OpenCode names and endpoints in `packages/desktop` (update feeds, installer
  downloads, `opencode.ai` URLs): the leak check scans only the engine packages.
- Inherited internal names stay: storage keys, IPC event names and the bundled binary's file name
  (`opencode-cli` inside the app's resources).

Work mode's skills live in kete-loom, and the portal, credits and relay in kete-code-platform; none of
them belong in this repository.
