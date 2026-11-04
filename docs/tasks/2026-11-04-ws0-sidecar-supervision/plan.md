# Plan: WS0 sidecar supervision

Approved 2026-11-04 under the user's Phase A pre-approval ("use your recommended best path or options").

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large task: approval needed before building.** It edits four upstream files (`desktop/src/main/desktop.ts`,
`desktop/src/shared/ipc-rpc/events.ts`, `desktop/src/renderer/desktop-app.tsx`, `app/src/runtime/i18n/en.ts`), each
with a few marked lines. It changes no shared contract (platform API, SDK, protocol), no config schema and no auth.
On security: the watcher reuses main's existing credential (`SidecarCredentials`), and renderer events carry only the
origin URL the renderer already has.

## Design in one paragraph
A Kete layer (`main/kete/sidecar-supervision.ts`) wraps `BackgroundService.Service`. It gives `reconnect` a
single-flight guard and forks a watcher. The renderer's stream reconnect (`client/src/solid/connection.ts` calls
`AppReconnectService` about once a second while the stream is down) and the watcher then share one `ensure` run.
The watcher (`main/kete/sidecar-watcher.ts`, pure Effect, no electron import) waits for `connection`. Then it loops:
sleep about 1 s, run an authenticated `GET /api/info` against `SidecarCredentials.get()` with a per-check timeout.
After 2 consecutive failures it emits `KeteSidecarRestarting`, runs the shared reconnect and retries defects with
exponential backoff (0.5 s, doubling, capped at 30 s). On success it emits `KeteSidecarReady { url }`.

The watcher never kills anything; `ensure` reuses a healthy service and keeps isolated mode's fixed port. It stops at
`before-quit`, and its fiber is interrupted when the layer scope closes.

In the renderer, a Kete component listens for both events with `listen` from `renderer/ipc-client.ts`, so `api.ts` and
`api-types.ts` don't change. It shows a persistent toast as the app-wide notice. On ready it dismisses the notice,
shows a "restarted" toast and calls the existing `setSidecar` when the origin changed. The stream already resumes
through its own reconnect callback (`app/src/runtime/server/client.tsx:94`).

Upstream-first: no config, plugin or hook covers main-process supervision. Everything runs through Kete-owned modules
injected at existing seams: the layer stack in `desktop.ts`, the event union, and the renderer tree. The upstream edits
are only registrations.

## Cards read
- docs/context/modules/desktop.md (verified-at 437294ce2d, stale: no)
- docs/context/modules/web-app.md (verified-at 437294ce2d, stale: no). Only the i18n/brand-text facts are used.
- docs/context/modules/server-sdk.md (stale: no; checked by the earlier planner run, not needed beyond that)
- docs/context/commands.md, pitfalls.md, CLAUDE.md §4/§9/§10

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/desktop/src/main/service/background-service.ts` | read | `Interface` (`connection`, `reconnect`), `Service` tag, `connect` (fixed port, `SidecarCredentials.set`) |
| `packages/desktop/src/main/service/background-service-state.ts` | read | `reconnect` replaces the stored exit; dies on failure (`orDie`) |
| `packages/desktop/src/main/service/sidecar-credentials.ts` | read | `get`, `authorization(data, url)` for the health check; `Data` type |
| `packages/desktop/src/main/ipc-handlers/app.ts` | read | `AppReconnectService` uses `BackgroundService.Service`, so it gets the decorated one automatically |
| `packages/desktop/src/main/ipc-events.ts` | read | `emitIpcEvent` |
| `packages/desktop/src/main/windows/index.ts` (around :103) | read | `getMainWindows` |
| `packages/desktop/src/main/desktop.ts` | **change (upstream, 2 marked lines)** | import and `Effect.provide(KeteSidecarSupervision.layer)` between `Ipc.layer` and `BackgroundService.layer`, so Ipc handlers see the decorated service |
| `packages/desktop/src/main/kete/sidecar-watcher.ts` | **new** | pure watcher `make({ connection, check, restart, emit, interval, timeout, threshold, backoff })` returns `{ run, stop }`; `singleFlight(effect)`; `healthy(data, timeout)` (fetch `new URL("/api/info", data.url)` with `SidecarCredentials.authorization`, `AbortSignal.timeout`, ok status = healthy, any error = unhealthy; logs only the origin, never the header) |
| `packages/desktop/src/main/kete/sidecar-supervision.ts` | **new** | `layer`: `Layer.effect(BackgroundService.Service, …)` reads the inner service, returns `{ connection, reconnect: singleFlight(inner.reconnect) }`, forks `watcher.run` scoped, `app.once("before-quit", stop)`, emit = broadcast to `getMainWindows()` via `emitIpcEvent` |
| `packages/desktop/src/shared/kete/sidecar-events.ts` | **new** | `KeteSidecarRestarting` (no fields) and `KeteSidecarReady { url: Schema.String }` as `Schema.TaggedClass` |
| `packages/desktop/src/shared/ipc-rpc/events.ts` | **change (upstream, marked)** | import from `../kete/sidecar-events` and add both to the `DesktopEvent` union |
| `packages/desktop/src/renderer/ipc-client.ts` (around :97) | read | `listen(tag, cb)` typing |
| `packages/desktop/src/renderer/migration-status.tsx` | read | pattern for a persistent toast (`toaster.show`/`dismiss`, `useLanguage`) |
| `packages/ui/src/feedback/toast/toast.tsx` (:132 `toaster`, :202 `showToast`) | read | toast API |
| `packages/desktop/src/renderer/startup/initialization.ts` | read | `ServerReadyData` shape, `sameSidecar` semantics |
| `packages/desktop/src/renderer/kete/sidecar-status-state.ts` | **new** | pure `createSidecarStatus({ notice: { show, hide }, toast, current, update })` returns `{ restarting(), ready(data) }`; idempotent show; `update` only when the origin differs |
| `packages/desktop/src/renderer/kete/sidecar-status.tsx` | **new** | connector: `listen` both tags, wire the state to `toaster`/`showToast` and `language.t(…, { product: Brand.displayName })`, unsubscribe in `onCleanup` |
| `packages/desktop/src/renderer/desktop-app.tsx` | **change (upstream, marked)** | import and mount `<KeteSidecarStatus current={sidecar} update={setSidecar} />` inside `AppInterface` next to `<DesktopEffects>` (own line, `{/* kete_change */}` above) |
| `packages/app/src/runtime/i18n/en.ts` | **change (upstream, 2 lines, `// kete_change` each)** | `"toast.kete.sidecar.restarting": "{{product}} runtime stopped. Restarting…"`, `"toast.kete.sidecar.restarted": "{{product}} runtime restarted"`. Other locales fall back to `en` (`runtime/i18n/language.tsx:100-106`) |
| `packages/client/test/fixture/service-fixture.ts`, `service-timing.ts`, `service.ts` | read | the AC3 seam: a real child service process that writes the registration file and answers `/api/info` with Basic auth (`compatible` mode); `accelerate` for fast `ensure` timing |
| `packages/client/src/effect/service.ts` | read | `Service.ensure` options (`file`, `command`) for AC3 |
| `packages/desktop/src/main/service/background-service-state.test.ts` | read | test style for Effect in desktop |
| `packages/desktop/src/main/kete/sidecar-watcher.test.ts` | **new** | AC1 (fake check/restart, `TestClock` from `effect/testing`) |
| `packages/desktop/src/shared/kete/sidecar-events.test.ts` | **new** | AC2 |
| `packages/desktop/src/main/kete/sidecar-watcher.integration.test.ts` | **new** | AC3 |
| `packages/desktop/src/renderer/kete/sidecar-status-state.test.ts` | **new** | AC4 |
| `docs/upstream-patches.md` | **change** | new section "WS0 sidecar supervision (feature/desktop-sidecar-supervision)", same format as "WS0 handshake" (:1801) |

## Steps
1. **Events.** Write `shared/kete/sidecar-events.ts` and add both classes to the `DesktopEvent` union in `events.ts`:
   one marked import line and two marked union lines. Write `sidecar-events.test.ts`. It encodes both events with
   `Schema.encodeSync(DesktopEvent)`, checks that the keys are exactly `_tag` (+ `url`), that no key matches
   `/pass|auth|token|secret/i`, and that it round-trips through decode.
2. **Watcher** (`main/kete/sidecar-watcher.ts`). Inputs are injected so tests need no electron:
   - `connection`: await `Effect.exit`, so a failed initial connect doesn't kill the watcher.
   - `check(): Effect<boolean>`
   - `restart(): Effect<Data>`, which may die
   - `emit(event)`
   - timings: interval default 1 s, timeout 1.5 s, threshold 2, backoff base 0.5 s, cap 30 s
   
   Loop:
   - Skip the check while `SidecarCredentials.get()` is undefined (it's passed in as a getter).
   - Count consecutive failures. At the threshold, emit `KeteSidecarRestarting` once, then retry the restart.
   - Catch the defect with `Effect.catchCause` or `sandbox`, wait `min(base * 2^n, cap)`, and stop retrying when
     `stopped`.
   - On success, emit `KeteSidecarReady({ url })` and reset the counter.
   
   `stop()` sets `stopped`; the loop exits before the next check or retry.

   `singleFlight(effect)`: a `Ref` holds an in-flight `Deferred`. Later callers await it, and it clears on completion,
   whether the effect succeeded or failed. `healthy(getData, timeout)` makes the real HTTP check described in the file
   table.
3. **AC1 tests** (`sidecar-watcher.test.ts`, `TestClock.adjust`):
   - 2 failures → 1 restart, with events `[Restarting, Ready]`.
   - 1 failure, then success → no restart and no events.
   - The restart fails 3 times → the restart call times grow `500, 1000, 2000` ms. With many failures the delay stays
     at 30 s.
   - Two concurrent `singleFlight` calls plus the watcher → the inner restart runs once.
   - After `stop()`, advancing the clock runs no checks.
4. **Supervision layer** (`main/kete/sidecar-supervision.ts`). Wire it in `desktop.ts` with one marked
   `Effect.provide(KeteSidecarSupervision.layer)` placed after `Effect.provide(Ipc.layer)` and before
   `Effect.provide(BackgroundService.layer)`, plus one marked import line. Fork the watcher with `Effect.forkScoped`
   and register `app.once("before-quit", stop)`. Log only `{ url }` origins at info level, never credentials.
5. **AC3 integration** (`sidecar-watcher.integration.test.ts`):
   - Setup: `serviceFixture()` from `../../../../client/test/fixture/service-fixture`. The restart runs real
     `Service.ensure` with `file: fixture.registration`, `command: fixture.command("compatible")`, timing through
     `accelerate`, provided `NodeFileSystem.layer`, then `SidecarCredentials.set({ url, password })`. Use the real
     `healthy` check, `interval` 200 ms and real timers.
   - Run: start the watcher after the initial ensure. Read `pid` from the registration JSON and
     `process.kill(pid, "SIGKILL")`.
   - Assert: wait on a condition (no fixed sleep) for the `Ready` event, at most 5 s. `healthy` against the new
     endpoint must be true.
   - Clean up: the fixture's cleanup plus `Service.stop`.
   
   If the cross-package relative import fails (tsconfig or bun resolution), stop and log it in handoff rather than
   copying the fixture.
6. **Renderer.**
   - Write `renderer/kete/sidecar-status-state.ts` and its test. AC4 covers: `restarting` shows the notice once (a
     repeat doesn't duplicate it); `ready` hides it, shows the restarted toast, and calls `update` only for a new
     origin; `ready` without a prior `restarting` still shows the toast.
   - Write the `sidecar-status.tsx` connector: a persistent `toaster.show` notice like `MigrationStatus`, then
     `showToast({ title })`.
   - Add the 2 `en.ts` keys and mount the connector in `desktop-app.tsx` (marked).
7. **Docs.** Add the `docs/upstream-patches.md` section with a table for the 4 upstream files and the "why no seam"
   for each, a sync checklist (keep the provide order in `desktop.ts`; keep the union entries) and the test list.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/desktop`: `bun test ./src/main/kete/sidecar-watcher.test.ts` |
| AC2 | in `packages/desktop`: `bun test ./src/shared/kete/sidecar-events.test.ts` |
| AC3 | in `packages/desktop`: `bun test --timeout 30000 ./src/main/kete/sidecar-watcher.integration.test.ts` |
| AC4 | in `packages/desktop`: `bun test ./src/renderer/kete/sidecar-status-state.test.ts` |
| AC5 | in `packages/desktop`: `bun run typecheck` and `bun run test`. In `packages/app`: `bun run typecheck` and `bun run test:unit`. Root: `bun run lint`, `bun run --cwd packages/kete-tools upstream:check`, `bun run --cwd packages/kete-tools verify --base main` |

Desktop typecheck excludes test files (desktop card), so run each new test file with `bun test`.

## Cards to update after the build
- `desktop`:
  - Quick answer: supervision (watcher, single-flight reconnect, thresholds, before-quit stop).
  - Two new events in the "add an event" answer; the `main/kete/`, `shared/kete/` and `renderer/kete/` file lists.
  - The `desktop.ts` provide-order rule; Testing (the 4 new tests, AC3's use of the client fixture).
  - Add `paths` for `shared/kete/**`, `renderer/kete/**`, `renderer/desktop-app.tsx`.
- `web-app`: one line in Quick answers: the `toast.kete.sidecar.*` keys in `en.ts` are used by the desktop renderer.
