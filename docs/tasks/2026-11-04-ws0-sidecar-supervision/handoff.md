# Handoff: WS0 sidecar supervision

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-04 planner
- Done: read INDEX.md, spec.md, handoff.md. Ran `node scripts/agent/stale-cards.mjs server-sdk` (current) and
  `node scripts/agent/stale-cards.mjs web-app` → **STALE** (1 file since 94eab8d8fd:
  `packages/app/component-tests/kete-shell.spec.ts`, changed by #85 `kete.handshake`; the card's
  `verified-at` was not bumped and the handshake build's card updates may not have landed).
- **Blocked: the librarian must refresh `docs/context/modules/web-app.md` first** (verify against #85:
  the `incompatible` health flag, the app-wide incompatible gate, the brand-text override, the e2e mock,
  the kete-shell component spec; bump `verified-at`). This task's renderer half (notice, "restarted"
  toast via `showToast`, resuming the server connection and event stream against a new endpoint) lives
  in `packages/app` and is planned from that card.
- Docs enough: no — missing: there is **no desktop module card** (`packages/desktop`). This task needs
  one for: where the service is started (`Service.ensure` in `packages/client/src/effect/service.ts:25-59`,
  `Service.incumbent` :34-43; main holds no child handle/PID), `BackgroundService` connection/reconnect
  (`desktop/src/main/service/background-service.ts:17-87`, `background-service-state.ts:9-31`, reconnect
  uses `orDie`), the `DesktopEvent` union (`desktop/src/shared/ipc-rpc/events.ts:6-87`), emit
  (`main/ipc-events.ts:26` + `getMainWindows` in `main/plugin/host.ts:209`), renderer listen
  (`renderer/api.ts:57`), Kete-owned folder `desktop/src/main/kete/`, app-quit lifecycle, isolated dev
  fixed port, and commands (`bun test --timeout 30000`, `bun check --no-script -b`; not yet in
  `commands.md`). Recommend the librarian writes a `desktop` card in the same pass (facts above came
  from a scout lookup, not a card).
- No plan.md written yet; re-run the planner after the librarian.

## 2026-11-04 planner (second pass)
- Done: the desktop, web-app and server-sdk cards are current (`stale-cards.mjs`: "All cards current"). Wrote `plan.md`.
- Decisions:
  - A Kete layer decorates `BackgroundService.Service`: `reconnect` becomes single-flight, so the renderer's stream
    reconnect (about 1 s, `client/src/solid/connection.ts:33,165`) and the watcher share one `ensure`. It is wired with
    one marked `Effect.provide` in `desktop.ts`.
  - The health check is an authenticated `GET /api/info` with `SidecarCredentials.authorization`.
  - The renderer uses `listen` directly, so `api.ts` and `api-types.ts` don't change.
  - The notice is a persistent toast (the `MigrationStatus` pattern).
  - AC3 uses the client's real-child-process service fixture (`client/test/fixture/service.ts`) instead of a real
    `kete serve`. A source `kete serve` start risks the 5 s budget and CI time; the true `kete serve` repeat is 0.4's
    e2e.
- Docs enough: no — missing: the desktop card doesn't say that the app's event stream already calls the sidecar
  `reconnect` (`AppReconnectService`) on every retry with a fixed 1 s delay (`client/src/solid/connection.ts:33,165`;
  `app/src/runtime/server/client.tsx:91-94,153`). This means a dead service is already re-ensured while a window
  streams, and concurrent reconnects are the norm.
- Docs enough: no — missing: no card names the renderer's sidecar resource and its updater (`desktop-app.tsx:63`
  `setSidecar`, `startup/initialization.ts` `createSidecarResolver`), the toast API (`ui/src/feedback/toast/toast.tsx`
  `toaster`/`showToast`; desktop precedent `renderer/migration-status.tsx`), or the client service test fixture
  (`client/test/fixture/service-fixture.ts`).
- Open: the cross-package relative import of the client fixture into a desktop test is unproven (step 5 says to stop
  and log if it fails). A cancelled quit after `before-quit` would leave the watcher stopped; lifecycle always
  re-quits (`lifecycle/index.ts:108-118`), so this is accepted.

## 2026-11-04 implementer
- **No shell in this run: NOTHING was executed** (no typecheck, tests, lint, upstream:check). All code is unverified.
- Done: all plan steps. New: `desktop/src/shared/kete/sidecar-events.ts` (+test), `main/kete/sidecar-watcher.ts`
  (+test, +integration test), `main/kete/sidecar-supervision.ts`, `renderer/kete/sidecar-status-state.ts` (+test),
  `renderer/kete/sidecar-status.tsx`. Edited (marked): `main/desktop.ts`, `shared/ipc-rpc/events.ts`,
  `renderer/desktop-app.tsx`, `app/src/runtime/i18n/en.ts`; appended a section to `docs/upstream-patches.md` via Edit.
- Decisions: `singleFlight` is promise-based (`Effect.runPromiseExit`), so the inner effect runs on the default clock
  (its test uses real time). Watcher fiber is stopped by `stop()` (loop exit) plus layer scope close. Integration test
  uses the client's promise `Service.ensure` (no fs layer) with mode `graceful`, and only tracks the new pid for cleanup.
- Risks to check first: Effect v4 API names (`Effect.suspend`, `Effect.exit`, `Exit.isSuccess`, `Effect.runPromiseExit`,
  `Effect.flatMap(exit => exit)`, `Effect.logWarning`); `TestClock.adjust` firing sequential sleeps in one adjust;
  cross-package relative imports in the integration test; `current={sidecar}` / `update={setSidecar}` prop types;
  `language.t` typing of the new keys; the `Layer.effect(Service)` that also requires `Service` (relies on provide order).
