# Result: WS0 sidecar supervision

## What changed
New (Kete-owned, `packages/desktop/src/`):
- `shared/kete/sidecar-events.ts` (+ test) — `KeteSidecarRestarting`, `KeteSidecarReady { url }` (no auth).
- `main/kete/sidecar-watcher.ts` (+ unit test with a fake clock, + integration test with a real child service) — the health loop (authenticated `GET /api/info`, 1.5 s timeout, every 500 ms; two failures → restart), restart with backoff (0.5 s doubling, capped 30 s), `singleFlight`.
- `main/kete/sidecar-supervision.ts` — a layer over `BackgroundService.Service`: single-flight `reconnect` shared by the watcher and the renderer's stream retry; emits the events to every window; stops on `before-quit`.
- `renderer/kete/sidecar-status-state.ts` (+ test), `sidecar-status.tsx` — the "Kete Code runtime stopped. Restarting…" notice and the "Kete Code runtime restarted" toast; updates the renderer's sidecar connection.

Upstream, marked and recorded in `docs/upstream-patches.md` ("WS0 sidecar supervision"):
`desktop/src/main/desktop.ts` (provide the layer), `desktop/src/shared/ipc-rpc/events.ts` (two union members),
`desktop/src/renderer/desktop-app.tsx` (mount), `app/src/runtime/i18n/en.ts` (two keys at the end of the dict).

Docs: new `docs/context/modules/desktop.md` card (+ INDEX, commands.md), web-app card.

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| desktop `bun test src/main/kete src/shared/kete src/renderer/kete --timeout 30000` | 16 pass |
| desktop `bun test --timeout 30000`, typecheck | 251 pass / 4 skip (Windows installer tests on macOS) / 0 fail; clean |
| app typecheck, `test:unit` | clean; 1074 pass / 0 fail |
| `bun run lint` | exit 0 |
| `upstream:check` | pass |
| `verify --base main` | see PR |
| Review | reviewer: approve, 5 minor → URL/auth inside `try` (fixed), cancelled-quit `shortcut:` comment (added), detached single flight and renderer-won restarts (accepted, below), result.md (this file). upstream-guard: approve; i18n keys moved to the end of the dict |

Manual, desktop dev app (`bun run dev`, isolated sidecar on port 3084): `kill -9` of the sidecar shows the
"Restarting…" notice, then the "restarted" toast, and the open session stays usable — screenshots taken during
the run. Time from kill to the port answering: 5.8–7.4 s in dev mode, where most of it is `kete serve` starting
from TypeScript source; detection itself is about 1 s.

## Acceptance criteria
- [x] AC1 — `sidecar-watcher.test.ts`: two failures → one restart and restarting/ready; one failure → nothing; failing restarts retried with growing delays capped at 30 s; overlapping callers share one restart; stop.
- [x] AC2 — `sidecar-events.test.ts`: payloads carry `url` only.
- [~] AC3 — `sidecar-watcher.integration.test.ts`: a real child service (client package fixture) is SIGKILLed and `ready` with a healthy new endpoint follows within the 5 s budget. In the dev app with a real `kete serve` from source it took 5.8–7.4 s; the packaged binary is timed in 0.3 (packaged smoke).
- [x] AC4 — `sidecar-status-state.test.ts`: restarting shows the notice, ready clears it and shows the toast; seen live in the dev app.
- [x] AC5 — see Checks.

Accepted limits: the single flight runs `reconnect` detached from the caller (bounded by `ensure`; a cancelled caller doesn't cancel it). If the renderer's own stream retry brings the service back before the watcher's second failed check, the user gets no notice or toast (the session still resumes).

## Cards updated
desktop (new card, then this task's watcher/layer/events/renderer and the handoff gaps), web-app. See card-check below.

## Metrics
- Agents used: scout, librarian ×3 (web-app refresh + new desktop card, close), planner ×2 (first stopped on a stale card), implementer (no shell), reviewer, upstream-guard
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-04)
