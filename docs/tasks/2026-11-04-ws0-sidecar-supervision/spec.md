# Spec: WS0 sidecar supervision

- Task: `docs/tasks/2026-11-04-ws0-sidecar-supervision` · Size: large · Created: 2026-11-04
- Status: closed (approved 2026-11-04, Phase A pre-approval: "use your recommended best path or options") <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
When the desktop's background `kete serve` stops (crash, killed, or stops answering), the desktop
notices on its own, brings it back through the existing start path, and tells the user — without the
user having to reload. Target: the runtime answers again within 5 s of being killed. PR 0.2 of
`docs/desktop-enhancement-plan.md`.

## Scope
- **Watcher** (Kete-owned, `packages/desktop/src/main/kete/`): after the initial connect, the main
  process health-checks the current service endpoint at a short interval (about 1 s, with a per-check
  timeout). Two consecutive failures mean "stopped". It then calls the existing
  `BackgroundService.reconnect` (which runs `Service.ensure` and refreshes `SidecarCredentials`).
  A failed restart is retried with exponential backoff (about 0.5 s doubling, capped at 30 s); it never
  spins. Only one restart runs at a time; the renderer's own reconnect request and the watcher don't
  race (both go through the same reconnect path).
- The health check uses the existing client service API (`Service.incumbent`/endpoint auth) or the
  authenticated `server.info` request; no new endpoint and no credential handling beyond what main
  already holds. Nothing secret is logged.
- **Events**: two `DesktopEvent`s, `KeteSidecarRestarting` and `KeteSidecarReady` (with the new
  endpoint URL only, no auth), emitted to every window (pattern `emitIpcEvent` + `getMainWindows`).
- **Renderer**: while restarting, an app-wide notice "Kete Code runtime stopped. Restarting…"; on
  ready, "Kete Code runtime restarted" (toast), and the app's server connection and event stream
  resume against the (possibly new) endpoint without a reload. Reuse the existing toast/notice UI;
  strings through i18n (English).
- The watcher stops on app quit and doesn't restart a service the app is deliberately shutting down.
- Upstream edits (`background-service.ts` or `desktop.ts` wiring, `events.ts` union entries, the
  renderer listener) are marked `kete_change` and recorded in `docs/upstream-patches.md`.

## Out of scope
- Packaged-app smoke and the Electron e2e (0.3, 0.4); the e2e repeat of AC3 lands in 0.4.
- Web (non-desktop) runtimes: the web app has no process to restart; it keeps today's health polling.
- Restarting after the user quits the runtime on purpose from outside the app (still restarted; no
  "don't restart" setting).
- Crash reports or telemetry.

## Acceptance criteria
- [ ] AC1: Watcher unit tests with a fake service and fake clock: two failed checks → one `reconnect`
  and `restarting` then `ready` events; one failed check → nothing; a restart that fails → retried with
  growing delays capped at 30 s; overlapping failures → a single restart in flight; stop() → no more
  checks.
- [ ] AC2: Events carry no secrets (no password/auth in payloads); schema test for both events.
- [ ] AC3: A desktop `bun test` integration with a real `kete serve` child (or the closest real seam
  the planner finds): kill the service, expect `ready` with a healthy endpoint within 5 s.
- [ ] AC4: Renderer: a test (unit or story) that `restarting` shows the notice and `ready` clears it and
  shows the "restarted" toast.
- [ ] AC5: `upstream:check` passes; every upstream edit marked and recorded; desktop typecheck and
  `bun test`; app typecheck and `test:unit`; lint; `verify --base main` no new failures.

## Risks and constraints
- No child handle in main: detection is by health check only, so "stopped" vs "slow" relies on the
  timeout and the two-failure rule; a busy runtime must not be killed — the watcher never kills, it only
  calls `ensure`, which reuses a healthy service.
- Isolated dev mode binds a fixed port; a restart must reuse it.
- Free CI minutes: the AC3 integration must stay fast (seconds), or move behind the e2e of 0.4.
- Security: no auth weakening; the endpoint URL sent to the renderer is already known to it.
