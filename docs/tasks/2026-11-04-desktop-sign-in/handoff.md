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

## 2026-11-04 implementer (stopped, tooling blocker)

Blocked: this agent has no Bash tool (only Read, Edit, Write, Grep, Glob), so `check-summary.mjs` and every test, typecheck and lint run is impossible. The plan itself is not wrong. I stopped after steps 1 and 2 rather than write the gate and plugin unverified.

Written, NOT run or typechecked:
- `packages/schema/src/kete/account.ts` (step 1): `KeteAccountRpc` with `status`, `login`, `cancel`, `logout`, event `changed`, and `localOnlyMessage`.
- `packages/util/src/kete/login-child.ts` (step 2): `start({ args, onURL?, spawn?, command?, timeout?, env? })` and `selfCommand()`, moved from the TUI file. The job-mode refusal text now names `kete login` / `kete logout` instead of `sign-in`; check no test asserts the old text.
- `packages/tui/src/kete/setup-login.ts`: now a thin wrapper that adds `--no-browser` over SSH. Same exports (`start`, `TIMEOUT`, `Result`, `Spawn`).
- `packages/util/test/kete/login-child.test.ts`: new.

(Superseded by the next entry: the coordinator ran the step 1-2 checks and told me to continue without a shell.)

Next, from a session with Bash: run `bun test ./test/kete/login-child.test.ts` in util and `bun test ./test/kete/setup-login.test.ts` in tui (must pass unchanged), `bun run typecheck` in schema, util and tui; then continue at step 3. The TUI test file was not edited.

## 2026-11-04 implementer (steps 3-9 written, no shell: NOTHING below has been run)

Done (all unrun; the coordinator runs the Verification table and sends failures):
- Step 3: `util/src/kete/brand.ts` `urls.platform = "https://app.ketecode.ai"`. `cli/test/kete/login.test.ts` not edited (nothing in it relied on "no platform URL"; I grepped).
- Step 4: `server/src/kete/account-gate.ts` + `server/test/kete/account-gate.test.ts`; `server/src/process.ts` (import + one middleware line, both `kete_change`).
- Step 5: `core/src/kete/account.ts` (exports `make(options)` and `Plugin = make()`); `core/src/plugin/internal.ts` (marked import + entry after `KeteShare.Plugin`); `core/test/kete/fixtures/fake-login.ts`; `core/test/kete/account.test.ts`.
- Step 6: `core/src/kete/gateway.ts` (event type in the filter, routed to `reload()`); `core/src/kete/sync/plugin.ts` (subscribes to `rpc.kete.account.changed`, runs `tick`); `core/test/kete/gateway.test.ts` (new test "account: signing out through kete.account ..." using the real `Rpc.Service` to emit the event).
- Step 7: `gui-plugins/src/kete/account/{index.ts,i18n/en.ts,controller.ts,controller.test.ts,page.tsx,renderer.tsx}`; `gui-plugins/src/renderer.ts` (marked import x2 + `compose` entry).
- Step 8: `app/src/kete/account-prompt.{ts,tsx}`, `account-prompt.test.ts`; `panel.tsx` (mount), `panel.css` (selectors added to the local-offer rules).
- Step 9: `docs/upstream-patches.md` section "Desktop sign-in" (inserted before "Desktop app").

Deviations from plan.md:
- Logout in `account.test.ts` uses the `fake-login.ts` fixture (its `logout` arg removes account.json), not the real CLI. I could not check that the real CLI child runs against a fake platform without a shell. The plan allowed this fallback.
- `logout` is refused (as data) in offline mode and job mode, like `login`, since the real `kete logout` revokes the key on the platform.
- The gate allows only exactly `/…/kete.account/status`; any other path containing an `kete.account` segment is gated (stricter than "method !== status").
- The gate sits before `KeteLocalGuard` in the pipe, so it runs after the guard and CORS. An unauthenticated request to a gated method on a non-local server gets 403, not 401 (the 403 text is fixed).
- The new-session prompt also has a "Not now" button (in-memory dismissal, not persisted). Not in the plan; remove if unwanted.
- Job-mode refusal text in `login-child.ts` is `kete login` / `kete logout` rather than `sign-in` (the coordinator confirmed no test asserts the old text).
- `cli/src/kete/commands.ts` `--platform-url` help text still says "default: KETE_PLATFORM_URL, then kete.platform.url"; not updated.

Things most likely to fail typecheck or tests (I could not check):
- `account.ts`: `Effect.runForkWith(yield* Effect.context())` (copied from `kete/offline.ts`); the `Promise<KeteAccountRpc.Login>` inside `Effect.promise`; handler return literal types; `registration.events.emit("changed", { state, message })` with `message` undefined.
- `account.test.ts`: `host()` override for `rpc`; `Scope.close(scope, Exit.void)`; bun's `process.execPath` as the fixture runner.
- `gateway.test.ts`: whether `Rpc.Service` events reach the gateway plugin's `ctx.event.subscribe()` in `PluginTestLayer` (the host and `Rpc.Service` share one location there, I assumed).
- GUI: `ServerRef` and `usePlugin` exports of `@opencode/plugin/gui`; `ctx.t(key, params)` interpolation syntax (`{{x}}`) in `en.ts`; `ctx.ui.Button` accepting `disabled`; the `"shield"` icon; `client.event.subscribe({ signal })` and `client.rpc.call` types on `ServerRef.client`.
- App: `SettingsPluginTab` cast and `settings.open(...)`.

Manual checks for the user: desktop sign-in and sign-out against a real platform; refusal with `--hostname 0.0.0.0` (gate returns 403 with the local-only text); web UI on the same machine shows Settings -> Account.

Files touched (all): schema/src/kete/account.ts; util/src/kete/{login-child,brand}.ts; util/test/kete/login-child.test.ts; tui/src/kete/setup-login.ts; server/src/kete/account-gate.ts; server/src/process.ts; server/test/kete/account-gate.test.ts; core/src/kete/{account,gateway}.ts; core/src/kete/sync/plugin.ts; core/src/plugin/internal.ts; core/test/kete/{account.test.ts,gateway.test.ts,fixtures/fake-login.ts}; gui-plugins/src/renderer.ts; gui-plugins/src/kete/account/*; app/src/kete/{account-prompt.ts,account-prompt.tsx,account-prompt.test.ts,panel.tsx,panel.css}; docs/upstream-patches.md; this handoff.

## Main session: verification and fixes (2026-11-04)

The implementer and verifier have no shell here, so the main session ran every check and fixed:
- `util/test/kete/login-child.test.ts`: `.js` import extension.
- Removed the three placeholder files the implementer could not delete (`app/src/kete/account-prompt.{ts,tsx}`, `account-prompt.test.ts`).
- `core/test/kete/job-spawn-sites.test.ts`: classified `util/src/kete/login-child.ts` as `kete-guard` with its spawn pattern; `realSpawn` now also calls `KeteJobMode.refuseSpawn` before spawning.
- `gui-plugins/src/main.ts`: `kete-account` added (main lists every built-in so the id stays reserved and the desktop enables it); `gui-plugins/README.md` quoted blocks updated (sdk-docs lint); both recorded in `docs/upstream-patches.md`.
- Not this task: `packages/protocol` `check:generated` is stale on main (one `maximum` for `kete.subagents.max_concurrent` since the v2.2.5 sync). Left as a follow-up.

Results: typecheck ok in schema, util, core, server, tui, cli, gui-plugins, app, desktop. account 9, gateway 31, account-gate 4, controller 7, app prompt 2, cli login 37 pass. Kete suites: core 1679, server 47, util 453, tui 128, cli 430; gui-plugins 265, app 1032, desktop 237. `verify --base main`: 0 new failures. Lint, `upstream:check`, client `check:generated`: pass.

Manual check still to do: sign out and in from the desktop against the real platform; a refusal with `--hostname 0.0.0.0`.

## 2026-11-04 implementer: review fixes (no shell: NOTHING below has been run)

1. Real-CLI test: added to `core/test/kete/account.test.ts` (core reaches the CLI by path only: `../../../cli/src/index.ts` run with `process.execPath run`, same as `cli/test/kete/job-socket.subprocess.test.ts`). Fake platform is `Bun.serve` on 127.0.0.1 (token with a PKCE check, `/api/v1/cli/logout`). There is no env switch to force file key storage, so PATH is a temp dir holding stub `security` / `secret-tool` that exit 1: the native store fails and `KeteAccount.save` falls back to the file store under the temp XDG_DATA_HOME. Skipped on Windows. Asserts: URL origin is the fake platform, `/cli/authorize`, S256; after the "browser" hits the CLI callback, `signed-in` event and status; logout makes the platform see `POST /api/v1/cli/logout`, status signed-out; no api key or key id in any RPC output or event. Risks I could not check: CLI cold start inside the 45 s URL wait, the real login calling platform endpoints the fake answers 404 (e.g. sync after login), the `until` 10 s limit for the callback to finish.
2. `logout` now silences and cancels a pending attempt first and clears it. Test added (fixture child).
3. `util/src/kete/login-child.ts`: an `ok` result carries `warnings` (all sanitized stderr lines, max 20) when there were any. `core/src/kete/account.ts` logout returns `{kind:"done", message: REVOKE_WARNING}` when a line matches /could not revoke/. The message is fixed text: the CLI's own warning names the key id, so it is not forwarded. Schema `Logout.done` has optional `message`. GUI controller has a `notice` state shown by `page.tsx` as `role="status"`. Tests: core (fixture `-e` script printing the warning), controller.
4. gateway.ts ternary wrapped. 5. `--platform-url` help now ends "..., then <Brand.urls.platform>)".

Check: `bun test ./test/kete/login-child.test.ts` (util; `ok` results with no stderr stay `{kind:"ok"}`, but a test that feeds stderr on success and uses toEqual would now see `warnings`), `bun run typecheck` in schema, util, core, gui-plugins, cli.

## Main session: review round 1 re-verify

- Fixed the new real-CLI test: the child must run as `bun run --cwd=<cli> src/index.ts` (the CLI resolves its bunfig preload and JSX runtime from its own package); dropped the `BUN_OPTIONS --config` override. The OS key store is safe: `secret-store.ts` runs a bare `security`/`secret-tool`, which PATH resolves to the test's stubs.
- `account.test.ts` 12/12 (real CLI included); `login-child.test.ts` 5/5; gui-plugins account 8/8; app kete 1032/0; tui kete 128/0; cli kete 430/0.
- Typecheck ok: schema, util, core, gui-plugins, cli, app. `bun run lint` exit 0 (67 anti-slop warnings in the new gui-plugins/core files, warnings only). `upstream:check` passed.
- `verify --base main`: util 593, server 162, core 8804/27 (base 8790/27), tui 1722/2 (same as base), cli 782; new failures 0.

- User decision: keep the "Not now" button on the sign-in prompt (added outside the plan; dismissal is not persisted).
