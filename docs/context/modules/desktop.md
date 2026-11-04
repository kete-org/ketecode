---
module: desktop
paths: [packages/desktop/src/main/service/**, packages/desktop/src/main/kete/**, packages/desktop/src/shared/kete/**, packages/desktop/src/renderer/kete/**, packages/desktop/src/renderer/desktop-app.tsx, packages/desktop/src/main/desktop.ts, packages/desktop/src/main/ipc-events.ts, packages/desktop/src/main/ipc-handlers/**, packages/desktop/src/main/lifecycle/**, packages/desktop/src/shared/ipc-rpc/events.ts, packages/desktop/src/renderer/api.ts, packages/desktop/src/renderer/ipc-client.ts, packages/desktop/script/dev.ts, packages/client/src/effect/service.ts, .github/workflows/kete-desktop.yml]
verified-at: 437294ce2d
---

## Quick answers
- Who starts the runtime and does main hold its PID? `BackgroundService.connect` (`desktop/src/main/service/background-service.ts:38`) calls `Service.ensure` (`client/src/effect/service.ts:49`) with the bundled `kete serve --service` command. `ensure` spawns contenders and finds the server through the registration file; main keeps no child handle or PID, and quitting the app does not stop the service.
- How is an already-running service adopted? Packaged builds probe early: `startSidecarProbe` (`main/service/sidecar-probe.ts:15`) runs `Service.discover` (`service.ts:25`, read-only, never spawns) while the window loads; `connect` uses that result at once (`background-service.ts:84-87`) and still runs `ensure` in the background. `Service.incumbent` (`service.ts:34`) recognises a compatible server on an expected URL, including one still starting.
- What does reconnect do and how does it fail? `reconnect` (`background-service.ts:32`) runs the same `connect("reconnect")` with `Effect.orDie`, so a failed restart is a defect, not a typed error; `BackgroundServiceState.make` (`background-service-state.ts:9-31`) stores the latest exit so `connection` replays it and `reconnect` overwrites it. The renderer reaches both through `AppAwaitInitialization` / `AppReconnectService` (`ipc-handlers/app.ts:32-33`).
- What is isolated dev mode? `!app.isPackaged` and `OPENCODE_DESKTOP_ISOLATED_SERVER=1` (`background-service.ts:44`; `script/dev.ts:23` sets it by default): `XDG_STATE_HOME` becomes the app's userData (`:48`), the early probe is skipped (`:84`), and the service starts with `--hostname 0.0.0.0 --port 3084` (`:68`). The fixed port makes a second contender fail to bind; the 0.0.0.0 URL is rewritten to 127.0.0.1 (`:92`).
- Where do the sidecar's URL and password live? In `SidecarCredentials` (`main/service/sidecar-credentials.ts`), set by `connect` (`background-service.ts:119`). The renderer only learns the origin (`ready`, `:21`); main adds the Basic header only for requests to that origin (`authorization`, `:26`). `onChange` (`:15`) notifies after each connect and reconnect (the plugin host follows it, `main/plugin/host.ts:881`).
- How do I add a main-to-renderer event? Add a `Schema.TaggedClass` to `shared/ipc-rpc/events.ts` and to the `DesktopEvent` union (`:70-84`; the stream RPC is `DesktopEvents`, `:89`). Emit with `emitIpcEvent(win.webContents, event)` (`main/ipc-events.ts:26`), for every app window via `getMainWindows()` (`main/windows/index.ts:103`; broadcast helper `main/plugin/host.ts:209`). The renderer subscribes with `listen("Tag", cb)` (`renderer/ipc-client.ts:97`), exposed as `onMenuCommand` / `onDeepLink` etc. in `renderer/api.ts:56-57`. Events only reach a window whose stream is bound (`bindIpcEvents`, `ipc-events.ts:7`, called from `ipc-transport.ts:75`); an unbound sender drops them.
- Does the app already call `reconnect` while a window streams? Yes: the event stream calls the sidecar's `reconnect` on every retry with a fixed 1 s delay (`client/src/solid/connection.ts:33,165`; `app/src/runtime/server/client.tsx:91-94,153` maps it to `AppReconnectService`), so a dead service is re-ensured by the renderer and concurrent reconnects are normal. `KeteSidecarSupervision` (`main/kete/sidecar-supervision.ts:14`) wraps `BackgroundService.Service` so `reconnect` is single-flight (`singleFlight`, `sidecar-watcher.ts:65`) and the watcher shares that one `ensure`.
- How does main notice a dead sidecar? `SidecarWatcher.make` (`main/kete/sidecar-watcher.ts:21`) polls an authenticated `GET /api/info` (`healthy`, `:80`; no credential yet counts as healthy) every 500 ms (`sidecar-supervision.ts:23`); two failures emit `KeteSidecarRestarting`, then `restart` (single-flight reconnect) retries with 500 ms..30 s backoff and emits `KeteSidecarReady { url }`. `stop()` runs on `before-quit` (`sidecar-supervision.ts:31`). Wired by one marked `Effect.provide` above `BackgroundService.layer` (`desktop.ts:46`).
- Where are the restart events and what does the renderer do with them? `KeteSidecarRestarting` / `KeteSidecarReady` (`shared/kete/sidecar-events.ts:4,7`) are in the `DesktopEvent` union (`shared/ipc-rpc/events.ts:88-89`). `KeteSidecarStatus` (`renderer/kete/sidecar-status.tsx:10`, mounted at `renderer/desktop-app.tsx:123`) listens with `listen`, shows a persistent toast while restarting and a "restarted" `showToast` on ready; logic in `createSidecarStatus` (`renderer/kete/sidecar-status-state.ts:5`). Copy: keys `toast.kete.sidecar.restarting|restarted` (`app/src/runtime/i18n/en.ts:1324-1325`, `{{product}}` = `Brand.displayName`).
- What is the renderer's sidecar resource and how is it updated? `desktop-app.tsx:64`: `createResource(() => api.awaitInitialization())` with `mutate: setSidecar`. `createSidecarResolver` (`renderer/startup/initialization.ts:17`) is the stream's `reconnect` and updates it too (`desktop-app.tsx:98`). On `KeteSidecarReady`, `createSidecarStatus.ready` calls `update` only when the origin changed (`sidecar-status-state.ts:26`).
- What is the toast API? `toaster` (`show(render, { persistent })`, `dismiss(id)`; `ui/src/feedback/toast/toast.tsx:132`), `showToast` (`:202`) and `Toast` parts, imported from `@opencode/ui/toast`. A persistent custom toast: `sidecar-status.tsx:26-46` (precedent: `renderer/migration-status.tsx`).
- Is there a real-process service fixture for tests? `serviceFixture` (`client/test/fixture/service-fixture.ts:13`, spawns `client/test/fixture/service.ts`) with `accelerate` (`service-timing.ts`); `main/kete/sidecar-watcher.integration.test.ts:4-5` imports it by relative path across packages.
- What is Kete-owned here and what is upstream-derived? Kete-owned: `main/kete/` (`service-file.ts`, `runtime-env.ts`, `sidecar-watcher.ts`, `sidecar-supervision.ts`), `shared/kete/`, `renderer/kete/`, `script/kete-*`, the workflow. Everything else is upstream; Kete edits carry `// kete_change` (service files, `lifecycle/{index,configure,environment,deep-link}.ts`, `windows/{appearance,early}.ts`, `native/logging.ts`, `constants.ts`, `renderer/index.html`).
- Which state directory does the service file use? `serviceFile` (`main/kete/service-file.ts:10`): `$XDG_STATE_HOME` or `~/.local/state`, then `Brand.appDirectory`, `service.json` (`service-local.json` when `OPENCODE_DESKTOP_SERVER_CHANNEL=local`, `background-service.ts:54`). The shared client's default is OpenCode's directory, so it is always passed explicitly.

## Purpose
The Electron desktop app (`packages/desktop`, `docs/desktop.md`): a thin client that finds or starts the local `kete serve --service` runtime and shows the web UI (`packages/app`) in windows. Main process: service supervision, IPC, windows, plugins, menus, storage. No agent logic.

## Entry points
- `src/main/index.ts` (early window, `startSidecarProbe`, then `import("./desktop")`); `src/main/desktop.ts:25-50` (layers, parks until `will-quit`).
- `src/main/service/background-service.ts` (`BackgroundService.Service`: `connection`, `reconnect`).
- `src/main/ipc.ts` composes `src/main/ipc-handlers/*`; renderer side `src/renderer/api.ts`, `ipc-client.ts`.

## Key files
- `main/service/`: `background-service.ts`, `background-service-state.ts`, `sidecar-credentials.ts`, `sidecar-probe.ts`, `desktop-cli.ts` (resolves the bundled CLI), `cli-version.ts` / `cli-stages.ts` (staged CLI copies; `cleanStages` runs for packaged and isolated builds, `background-service.ts:113`), `shell-env.ts`.
- `main/kete/service-file.ts`, `main/kete/runtime-env.ts` (`forRuntime` sets both `OPENCODE_*` and `KETE_*` names; `devCors` passes `--cors <renderer origin>` only for an unpackaged app).
- `main/ipc-events.ts`, `shared/ipc-rpc/events.ts` (the `DesktopEvent` union: DeepLinksOpened, MenuCommandTriggered, Window*Changed, StorageChanged, Plugin* events, KeteSidecarRestarting/Ready).
- Supervision: `main/kete/sidecar-watcher.ts` (`make`, `singleFlight`, `healthy`), `main/kete/sidecar-supervision.ts` (layer), `shared/kete/sidecar-events.ts`, `renderer/kete/sidecar-status{,-state}.ts(x)`.
- `main/lifecycle/index.ts`, `lifecycle/shutdown.ts` (`Shutdown.Service`: `add`, cached `run`).
- `packages/client/src/effect/service.ts` (`discover`, `incumbent`, `ensure`).

## Data flow
Window opens -> `AppAwaitInitialization` -> `connection` awaits the first `connect("initial")` -> returns `{ url }` only -> renderer talks to the sidecar directly, main injects the credential. Server restart or loss -> renderer calls `AppReconnectService` -> `connect("reconnect")` -> `SidecarCredentials.set` -> `onChange` listeners. Main -> renderer: `emitIpcEvent` -> per-window queue -> `DesktopEvents` stream -> `listen` callbacks.

## Data and APIs used
Registration file written by `kete serve --service` (url, pid, version, password; `service.ts` header comment); the runtime's HTTP API; `@opencode/client/service`; `Brand` and `KeteEnv` from `@opencode/util/kete`. Env: `OPENCODE_DESKTOP_ISOLATED_SERVER`, `OPENCODE_DESKTOP_SERVER_CHANNEL`, `ELECTRON_RENDERER_URL`.

## Rules that must not break
- Main never holds the child process; supervision is through the registration file. Do not add kill-on-quit without a task: it would end the user's other clients' server.
- The password never goes to the renderer (`SidecarCredentials.ready`); the Basic header is added only for the sidecar's own origin.
- Pass `file` explicitly to every `Service.*` call (Kete's state directory, not OpenCode's).
- Isolated mode keeps the fixed port; port 0 could boot two services on one database (comment at `background-service.ts:62`).
- The desktop sets runtime variables under both names via `forRuntime`; `kete` drops inherited `OPENCODE_*`.
- Every edit to an upstream file in this package carries a `kete_change` marker.

## Testing
- Inside `packages/desktop`: `bun run test` (= `bun test --timeout 30000`); one file `bun test ./src/main/service/background-service-state.test.ts`. Typecheck: `bun run typecheck` (= `bun check --no-script -b`; it does not cover test files, so run `bun test <file>` for each one you touch).
- Kete tests: `main/kete/runtime-env.test.ts`, `main/kete/sidecar-watcher.test.ts` (fake clock), `sidecar-watcher.integration.test.ts` (real fixture process), `shared/kete/sidecar-events.test.ts`, `renderer/kete/sidecar-status-state.test.ts`, `service/sidecar-credentials.test.ts`, `service/background-service-state.test.ts`, `script/kete-icons.test.ts`, `electron-builder.config.test.ts`.
- CI: `.github/workflows/kete-desktop.yml` (PRs touching the desktop, app, gui-plugins, client service files, brand files, or by hand): macOS arm64 and Windows x64; runs desktop tests, builds the CLI (`--single --skip-install --skip-web-ui`), builds and packs the unsigned app, uploads artifacts. Nothing is published.

## Changes
- 2026-11-04: card created for the WS0 sidecar-supervision task (`docs/tasks/2026-11-04-ws0-sidecar-supervision`).
- 2026-11-04: added the Kete sidecar watcher, single-flight reconnect, restart events and renderer notice (WS0).

## Gotchas
- The watcher is stopped by `before-quit` and is not re-armed if a quit is cancelled (accepted; lifecycle always re-quits).
- App quit: `before-quit` cancels the first quit until shutdown effects finish, then re-quits on the next tick (`lifecycle/index.ts:108-118`); `will-quit` runs `shutdown.run` (`:123`); `desktop.ts:37` parks on `will-quit`. None of it stops the runtime service.
- `connect` throws if the service gives no Basic auth (`background-service.ts:89`).
- `emitIpcEvent` silently drops events for a sender with no bound queue.
- `getMainWindows()` excludes popups and destroyed windows; use it, not `BrowserWindow.getAllWindows()`, for broadcasts.
