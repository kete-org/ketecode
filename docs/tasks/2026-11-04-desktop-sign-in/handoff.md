# Handoff: desktop sign-in

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-04 planner

Done: read INDEX.md, spec.md, and the cards account-login, sync, gateway, web-app, ui-branding (all fresh at e34caf4d08) and todo (fresh). plan.md is **not written**: the plan needs cards that are stale.

Blocked, the librarian must refresh these cards first (`node scripts/agent/stale-cards.mjs`):
- **server-sdk** (stale since c979e8f4e1, 61 files changed: server process, auth, local guard, protocol, client). AC5 (refuse `login`/`logout` unless the client is local and the same user, not a remote or paired one) and AC9 (no protocol regeneration) both depend on it. Planning a credential/security gate from a stale card is not safe.
- **brand-env** (stale: `util/src/kete/brand.ts`, `env.ts`). Spec item 3 sets `Brand.urls.platform`.
- **session-share** (stale: 9 files). Spec says share must pick up a new account without a restart (AC6 reload set).

Facts found in code while checking (for the librarian to add as Quick answers):
- Docs enough: no. Missing: whether a plugin RPC handler knows anything about its caller. It doesn't. `server/src/handlers/rpc.ts:8-32` passes only `params.rpcID`, `params.method` and `payload.input` to `Rpc.Service.call`, and `ctx.rpc.register` handlers (`plugin/src/effect/rpc.ts:25`) receive only `input`. So AC5 can't be decided inside `core/src/kete/` from the request. It needs either a server-side gate (an `rpc.call` check in `packages/server`, which is upstream or Kete middleware next to `server/src/kete/local-guard.ts`) or a fact the core plugin can read at start, such as the bind hostname or whether pairing is on. The refreshed server-sdk card should say: where the bind hostname, `--server`/LAN pairing and the password/auth mode are known; whether `local-guard.ts` (Host/Origin only, 95 lines) can tell loopback from LAN clients; and how a paired client is told apart from the desktop sidecar.
- Docs enough: no. Missing: the RPC pattern. Plugin RPCs are `Rpc.define({ id, methods, events })` in `schema/src/kete/*.ts` (`todo.ts:47-54`), registered in core with `ctx.rpc.register(Definition, handlers)` and events sent with `registration.events.emit` (`core/src/kete/todo.ts:87-101`).

Open questions for the user: none yet. Re-run the planner after the refresh.

## 2026-11-04 planner (re-run)

Done: the librarian had refreshed the cards. `stale-cards.mjs` on account-login, sync, gateway, web-app, ui-branding, server-sdk, brand-env, session-share and todo printed "All cards current". Note: the script also prints that for an unknown card name, so I confirmed each card file exists and has `verified-at: e34caf4d08` (todo: a6f140247e). plan.md is written.

Decisions (see plan.md "Design decisions"):
- AC5 is a server middleware `KeteAccountGate`. It allows only a loopback bind with no socket, no tunnel URL and no SSH or remote-container env.
- The child-process helper moves to util.
- The runtime reloads over the bus event.
- Settings → Account is a GUI plugin page.
- The new-session prompt opens that page.

Deviation from the spec: the Account settings page lives in `packages/gui-plugins/src/kete/account/`, not `packages/app/src/kete/` (upstream-first: 1 upstream file instead of about 5). Its AC7 tests are therefore in gui-plugins. The user should confirm when approving.

Docs enough: no. Missing:
- **GUI plugin settings-page seam.** `SettingsPage` registry at `plugin/src/gui/registries.ts:379,782`; root pages are listed by `app/src/runtime/plugin/settings-pages.ts`; built-ins are composed in `gui-plugins/src/renderer.ts`; template `gui-plugins/src/pairing/`; a plugin has `client` and `openExternal` (`plugin/src/gui/host-apis.ts:23,1086`). No card covers it.
- **Location scope of RPC events.** `Rpc.emit` publishes with `location: ref` (`core/src/rpc.ts:96-100`), so another location's plugins don't see it. `LocationServiceMap.reload` (`core/src/location-service-map.ts:20`) reloads every location; that is what `kete login`'s `location.reload` uses.
- **Remote tunnel.** It exists only in service mode with `config.remote` (`cli/src/server-process.ts:196-213`). `ServerProcess.start`'s `remoteURLs` argument (`server/src/process.ts:52`) is empty until the tunnel reports a URL.
- **How the desktop starts its runtime.** It runs the bundled `kete` CLI binary (`desktop/src/main/service/desktop-cli.ts`), so `selfCommand()` works there.
- **`Brand.urls.platform` consumers.** The only one is `cli/src/kete/account-flow.ts:351`.
- **How a GUI plugin picks its server on the web (not desktop).** Pairing only handles desktop (`builtin` server). The implementer must check `plugin/src/gui/context.ts` `servers`.

Open questions for the user (at approval):
1. Is the GUI-plugin location for the Account page OK?
2. Is it OK that the new-session prompt opens the Account page instead of signing in inline?
3. Is the cross-location reload limit acceptable for now?
