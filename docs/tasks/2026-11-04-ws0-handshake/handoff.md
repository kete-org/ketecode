# Handoff: WS0 handshake

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-04 planner
- Done: wrote `plan.md`. Cards `server-sdk`, `web-app` current (stale-cards: all current).
- Decisions for the user to approve with the plan: D1 (settings route not covered; session/draft
  keep their own panel), D2 (focused Home server is "current" off a session page), D3 (which errors
  mean "no handshake RPC"), D4 (copy via a `brand-text.ts` override, all locales).
- Docs enough: no — missing: how an RPC call with no `location` resolves (`server/src/location.ts:71-78`, falls back to `process.cwd()`), and that a plugin's `ctx.app.version` is the runtime version (`plugin/src/app.ts:1-5`, used `core/src/kete/share/plugin.ts:156`) (server-sdk).
- Docs enough: no — missing: which client-side error shapes an unknown RPC produces (`RpcError` 400 with `rpc.unavailable`/`rpc.method_not_found`, `core/src/rpc.ts:108-114`; guard `isRpcError` in `client/src/promise/generated/types.ts:3226`) (server-sdk).
- Docs enough: no — missing: `checkServerHealth`'s flow and tests (`app/src/runtime/server/health.ts:97-145`, `health.test.ts` fakes every path with `/api/info`), and that the e2e mock server's `rpcCall` refuses unknown RPCs (`app/e2e/utils/mock-server.ts:1135`) (web-app).
- Docs enough: no — missing: where an app-wide panel can mount (`app/src/shell/shell.tsx:303-305`, inside `<main>` around `PluginServerCover`'s children), the `LayoutRoute` types (`shell/state/layout.tsx:55`), and that the story harness aliases `@/runtime/server/current` to a mock without `conn`/`health` (`packages/stories/vite.config.ts:61`), so `ServerUnavailablePanel` is not story-safe (web-app).
- Docs enough: no — missing: user-facing copy is rebranded through `app/src/kete/brand-text.ts` (`overrides` for whole strings) rather than editing locale files (web-app / ui-branding).
- Open: a `rpc.unavailable` also fires when a location closes mid-call (`core/src/rpc.ts:133-135`); this could show the panel for one poll (10 s) in a rare race. Accepted unless the user objects.

## 2026-11-04 implementer
- Environment: this run had NO shell tool (only Read/Edit/Write/Grep/Glob). No check was run, nothing is verified.
- **INCIDENT: `docs/upstream-patches.md` was overwritten with the text `PLACEHOLDER`** by a mistaken Write (I meant to append). The file was unmodified in git, so `git checkout -- docs/upstream-patches.md` restores it. Then append the section below. Needs the caller (I cannot run git).
- Done (steps 1-10, 11 partly): schema `kete/handshake.ts` + test; core `kete/handshake.ts` + marked `internal.ts` import and list entry; server test `test/kete/handshake.test.ts`; app `kete/handshake.ts` + `handshake.test.ts`; marked `health.ts` (hoisted `client`, handshake chained after `server.info`) and `health.test.ts` (new `reply` helper, request list gains the handshake path, retry test count 3 -> 4); gate `incompatible-gate.ts`/`.test.ts`/`-view.tsx`/`.tsx`; marked `shell.tsx` wrap + import; story `IncompatibleGate` + spec in `kete-shell.spec.ts`; `brand-text.ts` override + test; marked `e2e/utils/mock-server.ts`; `docs/desktop-enhancement-plan.md` wording.
- Not done: the `docs/upstream-patches.md` section (see incident), card updates (librarian), all of step 12 (verification table).
- Decisions: `check` takes `Pick<OpenCodeClient,"rpc">` and calls the raw `client.rpc.call` (its rejection is the `RpcError` body, so `isRpcError` applies). `KeteIncompatibleGate` takes the panel's server from `servers.visible` by key.
- Unverified risks: types of `isRpcError`/`OpenCodeClient` imports from `@opencode/client/promise`; `health.ts` data union typing; JSX formatting in `shell.tsx`/`mock-server.ts` (the nested ternary comment placement may need `oxfmt`/lint); `ServerProvider` inside the covered panel.
- Section to append to `docs/upstream-patches.md`:

```
## WS0 handshake (feature/desktop-handshake)

The app refuses a server whose `kete.handshake` protocol differs from its own (schema `KeteHandshakeRpc.PROTOCOL`).

| File | Change | Why no seam |
| --- | --- | --- |
| `core/src/plugin/internal.ts` | imports and registers `KeteHandshake.Plugin` (marked lines) | the internal plugin list is the only registration point |
| `app/src/runtime/server/health.ts` | `checkServerHealth` hoists the client and chains `KeteHandshake.check` after `server.info`; a mismatch returns `incompatible: true` | the check belongs in the probe so every consumer of `ServerHealth` sees it |
| `app/src/runtime/server/health.test.ts` | its fake `fetch` answers the handshake path; the expected requests gain it | the probe now makes a second request |
| `app/src/shell/shell.tsx` | wraps `<PluginServerCover>` in `<KeteIncompatibleGate>` (marked) | the app-wide cover has to sit inside `<main>`; no shell slot exists there |
| `app/e2e/utils/mock-server.ts` | `rpcCall` answers `kete.handshake.get` | else every e2e scenario shows the incompatible panel |

**Sync checklist:** keep the handshake call after `server.info` in `checkServerHealth`, and keep the gate mounted inside `<main>`.
```
