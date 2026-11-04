# Result: WS0 handshake

## What changed
New:
- `packages/schema/src/kete/handshake.ts` (+ `test/kete/handshake.test.ts`) — `KeteHandshakeRpc`: `ID`, `PROTOCOL = 1` (the one definition), `Result { protocol, runtime, modes }`, `Definition` (`get`).
- `packages/core/src/kete/handshake.ts` — `KeteHandshake.Plugin` registers `get` → `{ protocol, runtime: ctx.app.version, modes: ["code"] }`; needs no project.
- `packages/server/test/kete/handshake.test.ts` — the RPC over `POST /api/rpc/kete.handshake/get` with no location.
- `packages/app/src/kete/handshake.ts` (+ test) — `check(client, signal)`: same protocol → compatible; other protocol, undecodable output, or `rpc.unavailable`/`rpc.method_not_found` → incompatible; anything else rethrown to the existing health handling.
- `packages/app/src/kete/incompatible-gate-state.ts` (+ test), `incompatible-gate-view.tsx`, `incompatible-gate.tsx` — the app-wide cover (every route except Settings; session/draft keep their own panel; the off-session server is Home's focused one).

Changed:
- Upstream, marked: `core/src/plugin/internal.ts`, `app/src/runtime/server/health.ts`, `health.test.ts`, `app/src/shell/shell.tsx` (wrap, upstream lines not re-indented), `app/e2e/utils/mock-server.ts`.
- Kete: `app/src/kete/brand-text.ts` (+ test) incompatible copy; `kete/shell.stories.tsx` + `component-tests/kete-shell.spec.ts` (AC4); `kete-tools/src/lib.ts` treats `docs/desktop-enhancement-plan.md` and `docs/platform-issues/` as Kete-owned (both came in with #84, which ran no CI, so `upstream:check` failed on `main`).
- Docs: `docs/upstream-patches.md` (WS0 handshake section), `docs/desktop-enhancement-plan.md` (names the RPC).

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| schema `bun test ./test/kete/handshake.test.ts`, typecheck | 3 pass; clean |
| server `bun run test ./test/kete/handshake.test.ts` | 1 pass |
| core typecheck | clean |
| app typecheck, `bun run test:unit` | clean; 1074 pass / 0 fail |
| app `test:components -- component-tests/kete-shell.spec.ts` | 8 pass |
| kete-tools typecheck, `bun run test` | clean; 66 pass |
| `bun run lint` | exit 0 (warnings only, none blocking) |
| `upstream:check` | pass |
| `verify --base main` | see PR (run before the final `handshake.ts` tidy; app is not in verify) |
| Review | reviewer: approve, 5 minor (patch-record filename, web-app card, spec Settings note → fixed; AC4 limit and older-server shape → noted below). upstream-guard: approve |

## Acceptance criteria
- [x] AC1 — `schema/test/kete/handshake.test.ts`: decodes a valid result; rejects missing/negative/fractional `protocol` and a non-string `runtime`.
- [x] AC2 — `server/test/kete/handshake.test.ts`: `{ protocol: PROTOCOL, runtime: <version>, modes: ["code"] }` with no location.
- [x] AC3 — `app/src/kete/handshake.test.ts`: same / different protocol, `rpc.unavailable` (older server), network error (retry, not incompatible), unauthorized. A server older than this release still has the generic RPC route, so it answers an `RpcError`; a non-Kete server answering HTML/404 falls into the existing unhealthy path, not "incompatible".
- [x] AC4 — `kete-shell.spec.ts` "covers the page with the panel while a server is incompatible and restores it after", through `KeteIncompatibleGateView` with a stand-in panel (the real panel needs server contexts the story harness mocks); the route/selection/health decision is unit-tested in `incompatible-gate-state.test.ts`.
- [x] AC5 — `PROTOCOL` is defined once in `schema/src/kete/handshake.ts`; core, app and the e2e mock import it.
- [x] AC6 — see Checks.

Not verified by hand: the panel in a running desktop app against a mismatched server.

## Cards updated
server-sdk (handshake RPC, location-less RPCs, `ctx.app.version`, unknown-RPC error shapes), web-app (`incompatible` now set by the handshake, the gate, health flow and e2e mock, app-wide mount point), ui-branding (`brand-text.ts` overrides). `card-check.mjs`: 41 cards clean. Other stale cards (repo-wide drift, 30) were not this task's.

## Metrics
- Agents used: scout, librarian ×2, planner, implementer (no shell), reviewer, upstream-guard; verifier not called (main session ran checks)
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (spec through close on 2026-11-04)
