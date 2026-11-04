# Plan: WS0 handshake

Approved 2026-11-04 (D1–D4 accepted under the user's Phase A pre-approval: "use your recommended best path or options").

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large task: needs the user's approval of this plan before building.** It adds a shared runtime
contract (the `kete.handshake` RPC result and the protocol number) and makes marked edits to five
upstream files: `core/src/plugin/internal.ts`, `app/src/runtime/server/health.ts`,
`app/src/runtime/server/health.test.ts`, `app/src/shell/shell.tsx`, `app/e2e/utils/mock-server.ts`.
No config schema change and no new HTTP endpoint. Nothing in `protocol`/`client` is regenerated (plugin RPC on the generic route;
server-sdk card). Auth and `KeteLocalGuard` are unchanged.

Decisions to approve (they go beyond the spec's wording):
- D1. **Settings stays reachable**: the app-wide panel covers every route **except** `settings`
  (so the user can remove or switch the server) and except `session`/`draft`, which already render
  the panel themselves (no double panel). The titlebar and sidebar stay usable because the panel
  replaces only `<main>`'s content.
- D2. **"Current server" off a session page** is the Home's focused server: the one in
  `layout.home.selection().server` if visible, else the first visible server (same rule as
  `home/model.ts:17-20`).
- D3. **"No `kete.handshake` RPC"** means the server answers an `RpcError` with type
  `rpc.unavailable` or `rpc.method_not_found`, or answers with output that doesn't decode. Any other
  failure keeps today's handling (unauthorized → `unauthorized`; transport → retry → unhealthy).
- D4. **Copy**: the English text comes from a whole-string override in Kete's `brand-text.ts`
  (applied in every locale, like the existing trademark override), so no upstream locale file
  changes: title "This server version isn't supported" (unchanged), description
  "{{server}} is running Kete Code {{version}}, which this app can't use. Update Kete Code on that
  server to continue."

## Cards read
- docs/context/modules/server-sdk.md (verified-at 94eab8d8fd, stale: no)
- docs/context/modules/web-app.md (verified-at 94eab8d8fd, stale: no)
- Also: docs/context/INDEX.md, pitfalls.md, commands.md

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/schema/src/kete/todo.ts` | read | `Rpc.define` pattern, header comment style, `export * as` |
| `packages/schema/src/rpc.ts:95-110` | read | the `rpc.unavailable` / `rpc.method_not_found` error types (D3) |
| `packages/schema/src/kete/handshake.ts` | **new** | `KeteHandshakeRpc`: `PROTOCOL = 1` (the one definition), `ID = "kete.handshake"`, `Result` schema (`protocol` int ≥ 0, `runtime` string, `modes` array of string), `Definition` with method `get` (input `Schema.Struct({})`), no events |
| `packages/schema/test/kete/handshake.test.ts` | **new** | AC1 decode tests |
| `packages/core/src/kete/doctor.ts:1-30,150-160` | read | core plugin pattern: `define({ id, effect })` + `ctx.rpc.register(...).pipe(Effect.orDie)` |
| `packages/core/src/kete/handshake.ts` | **new** | `KeteHandshake.Plugin`: registers `get` → `{ protocol: PROTOCOL, runtime: ctx.app.version, modes: ["code"] }`; needs no Location/Config service, so it works with no project |
| `packages/core/src/plugin/internal.ts:127-134,336-348` | **change (upstream, marked)** | one marked import, one marked list entry after `KeteDoctor.Plugin`, same comment style as its neighbours |
| `packages/server/test/rpc-handler-errors.test.ts` | read | in-process server pattern (`createEmbeddedRoutes`, `toWebHandlerWith`) |
| `packages/server/src/location.ts:71-78` | read | a call with no `location` query falls back to `process.cwd()`; the test omits `location` |
| `packages/server/test/kete/handshake.test.ts` | **new** | AC2 |
| `packages/client/src/promise/generated/types.ts:2980-2982,3220-3228` | read | `isUnauthorizedError`, `isRpcError` guards (generated; never edit) |
| `packages/app/src/kete/account-prompt-state.ts` | read | client `rpc.call` + decode-as-external-input pattern |
| `packages/app/src/kete/handshake.ts` | **new** | `check(client, signal): Promise<"compatible" \| "incompatible">`; rejects with the original error for anything not in D3 |
| `packages/app/src/kete/handshake.test.ts` | **new** | AC3 (fake `fetch`, through `checkServerHealth` and `check`) |
| `packages/app/src/runtime/server/health.ts:97-145` | **change (upstream, marked)** | after `server.info` succeeds, chain `KeteHandshake.check`; incompatible → `{ healthy: false, incompatible: true, version, hostname }` |
| `packages/app/src/runtime/server/health.test.ts` | **change (upstream, marked)** | its fake `fetch` answers every path with `info`; it must answer the handshake path too and the expected request list gains it |
| `packages/app/src/session/server-unavailable-panel.tsx` | read | the panel to reuse (needs `useServer`, `useServers`, `useLanguage`) |
| `packages/app/src/runtime/server/current.tsx` | read | `ServerProvider` (the panel needs it off a session page) |
| `packages/app/src/runtime/plugin/server-shell.tsx` | read | precedent for a route-aware cover inside `<main>` |
| `packages/app/src/shell/state/layout.tsx:55-80` | read | `LayoutRoute` types, `useCurrentRoute`, `home.selection` |
| `packages/app/src/home/model.ts:17-20` | read | the focused-server rule (D2) |
| `packages/app/src/runtime/server/registry.tsx` | read | `useServers().visible`, `ServerConnection.key` |
| `packages/app/src/kete/incompatible-gate.ts` | **new** | pure `coveredServer({ route, selected, visible, health })` → key or undefined (D1, D2) |
| `packages/app/src/kete/incompatible-gate.test.ts` | **new** | unit tests for the decision |
| `packages/app/src/kete/incompatible-gate-view.tsx` | **new** | `KeteIncompatibleGateView({ covered, panel, children })`: plain props, story-safe |
| `packages/app/src/kete/incompatible-gate.tsx` | **new** | connector `KeteIncompatibleGate`: reads route, layout, servers, health; renders the view with `<ServerProvider conn><ServerUnavailablePanel reason="incompatible" /></ServerProvider>` as `panel` |
| `packages/app/src/shell/shell.tsx:303-305` | **change (upstream, marked)** | wrap `<Suspense>{props.children}</Suspense>` in `<KeteIncompatibleGate>` with `{/* kete_change start */}`/`{/* kete_change end */}` on their own lines, plus a marked import |
| `packages/app/src/kete/shell.stories.tsx` | change | add an `IncompatibleGate` story: a toggle between covered/not, a stand-in "Home" child and a stand-in panel (the real panel needs server contexts the story harness doesn't mock) |
| `packages/app/component-tests/kete-shell.spec.ts` | change | AC4 |
| `packages/app/src/kete/brand-text.ts` | change | D4 override for `session.error.incompatible.description` |
| `packages/app/src/kete/brand-text.test.ts` | change | assert the override |
| `packages/app/e2e/utils/mock-server.ts:1134-1142` | **change (upstream, marked)** | the mock's `rpcCall` must answer `kete.handshake.get` with `PROTOCOL`, or every e2e scenario shows the incompatible panel |
| `docs/upstream-patches.md` | change | new section "WS0 handshake (feature/desktop-handshake)" listing the five upstream files and why |
| `docs/desktop-enhancement-plan.md:157,171,215,221` | change | name the `kete.handshake` RPC (`POST /api/rpc/kete.handshake/get`) instead of `GET /api/kete/handshake`; drop the "one marked mount" wording for WS0 |

## Steps
1. **Schema.** Write `schema/src/kete/handshake.ts` on the `todo.ts` pattern. `protocol`:
   `Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))` (match the check helpers `todo.ts` uses);
   `runtime`: `Schema.String`; `modes`: `Schema.Array(Schema.String)`. Header comment: what the RPC is
   for, that adding fields is fine and changing/removing one needs a `PROTOCOL` bump, exact match only.
   Test (AC1): decodes a valid result; rejects missing `protocol`, `-1`, `1.5`, and `runtime: 1`.
2. **Core plugin.** `core/src/kete/handshake.ts`: `export * as KeteHandshake`, `Plugin = define({ id:
   "kete.handshake", effect: (ctx) => ctx.rpc.register(KeteHandshakeRpc.Definition, { get: () =>
   Effect.succeed({...}) }).pipe(Effect.asVoid, Effect.orDie) })`. `runtime` is `ctx.app.version` (the
   same version `server.info` reports). Register it in `internal.ts` with marked lines.
3. **Server test (AC2).** `server/test/kete/handshake.test.ts` on the `rpc-handler-errors.test.ts`
   pattern, but with `config: { project: false, ... }`, no extra plugin registration, and **no**
   `location` query: `POST /api/rpc/kete.handshake/get` with `{ input: {} }` → 200, `output` equals
   `{ protocol: PROTOCOL, runtime: <version from GET /api/info on the same handler>, modes: ["code"] }`.
4. **App check.** `app/src/kete/handshake.ts`: call `client.rpc.call({ rpcID: ID, method: "get",
   input: {} }, { signal })` (no location), decode `response.output` with `Result` (external input);
   decoded and `protocol === PROTOCOL` → `"compatible"`; decoded with another number, or not
   decodable → `"incompatible"`; a rejection that `isRpcError` with type `rpc.unavailable` or
   `rpc.method_not_found` → `"incompatible"`; any other rejection is re-thrown unchanged.
5. **health.ts (marked).** Hoist the `OpenCode.make({...})` client into a marked `const client`, and
   change the `.then` after `server.info` to chain `KeteHandshake.check(client, signal)` so its
   rejections fall into the existing `.catch((error) => ({ error }))` (unauthorized and retry handling
   then apply unchanged). Incompatible result: `{ healthy: false, incompatible: true, version,
   hostname }`. Keep every other line as it is. Update `health.test.ts`'s fake `fetch` (marked) to
   answer `/api/rpc/kete.handshake/get` with `{ output: { protocol: PROTOCOL, runtime, modes } }`
   and add that path to the expected request list.
6. **App tests (AC3)** in `app/src/kete/handshake.test.ts`, driving `checkServerHealth` with a fake
   `fetch`: same protocol → `{ healthy: true, ... }`; `protocol: PROTOCOL + 1` → `incompatible: true`;
   `400 { _tag: "RpcError", type: "rpc.unavailable" }` → `incompatible: true`; handshake path throws
   `TypeError("fetch failed")` → `healthy: false`, not incompatible, and it was retried (count calls,
   `retryDelayMs: 0`); handshake 401 `UnauthorizedError` → `unauthorized: true`, one call.
7. **Gate.** `incompatible-gate.ts` (pure, no Solid import): returns the covered server key when the
   route type is not `session`/`draft`/`settings` and the focused server (D2) has
   `health.incompatible`. `incompatible-gate-view.tsx`: `<Show when={props.covered} fallback=
   {props.children}>{props.panel}</Show>` inside a `data-kete="incompatible-gate"` wrapper that keeps
   `<main>`'s flex sizing. `incompatible-gate.tsx`: the connector. Mark the `shell.tsx` wrap (start/end
   comments on their own lines). Unit-test the decision (home + incompatible → key; compatible →
   undefined; settings/session/draft → undefined; selection pointing at a hidden server falls back to
   the first visible).
8. **Story + component test (AC4).** Add the story (`app-kete-shell--incompatible-gate`) and two
   specs: covered → the panel stand-in is visible and the Home stand-in is absent; not covered →
   Home visible, no panel.
9. **Copy.** Add the D4 override to `brand-text.ts` `overrides` and a test line.
10. **e2e mock (marked).** `mock-server.ts` `rpcCall`: answer `kete.handshake`/`get` with
    `{ output: { protocol: KeteHandshakeRpc.PROTOCOL, runtime: <the mock's info version>, modes:
    ["code"] } }` before the `opencode.goal` branch.
11. **Docs.** `docs/upstream-patches.md` section; `docs/desktop-enhancement-plan.md` §2/§3/§5 wording.
12. Run the verification table, narrowest first.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/schema`: `bun test ./test/kete/handshake.test.ts`, then `bun run test`, `bun run typecheck` |
| AC2 | in `packages/server`: `bun run test ./test/kete/handshake.test.ts` (isolated runner; never bare `bun test`); in `packages/core`: `bun run test ./test/kete` and `bun run typecheck` |
| AC3 | in `packages/app`: `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/kete/handshake.test.ts ./src/runtime/server/health.test.ts ./src/kete/incompatible-gate.test.ts ./src/kete/brand-text.test.ts` |
| AC4 | in `packages/app`: `bun run test:components -- component-tests/kete-shell.spec.ts` (browser once: `node_modules/.bin/playwright install chromium-headless-shell`) |
| AC5 | from the repo root: `grep -rnE "protocol: *[0-9]\|PROTOCOL *= *[0-9]" packages/schema/src packages/core/src packages/app/src packages/app/e2e` shows exactly one hit (`schema/src/kete/handshake.ts`); confirm a second way with `grep -rn "KeteHandshakeRpc.PROTOCOL" packages/core/src packages/app/src packages/app/e2e` (core, app check, e2e mock all import it) |
| AC6 | `bun run --cwd packages/kete-tools upstream:check`; in `packages/app`: `bun run typecheck`, `bun run test:unit`; in `packages/server`: `bun run typecheck`, `bun run test`; root `bun run lint`; then `bun run --cwd packages/kete-tools verify --base main` |

## Cards to update after the build
- server-sdk: Quick answer for `kete.handshake` (schema, core plugin, the AC2 test as the
  location-less RPC test pattern; a call without `location` runs at `process.cwd()`); which RPC
  errors mean "this RPC doesn't exist".
- web-app: `incompatible` is now set by `checkServerHealth` from the handshake (correct the existing
  "never sets it" line); the app-wide gate (`kete/incompatible-gate*`, `shell.tsx` seam, D1/D2); the
  copy override; the e2e mock answers the handshake.
- docs/context/contracts.md: add the `kete.handshake` result and `PROTOCOL` as a runtime contract
  (adding fields fine, change/remove needs a bump).
