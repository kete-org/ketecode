# Plan: desktop sign-in

**Large. Approved by the user on 2026-11-04 (GUI-plugin settings page).** The plan includes:
- **Upstream edits (3 files, each marked `kete_change`):** `packages/core/src/plugin/internal.ts`,
  `packages/server/src/process.ts`, `packages/gui-plugins/src/renderer.ts`.
- **Security:** a new server-side gate on a credential-changing RPC, and the runtime spawning `kete login` and
  `kete logout`.
- **New contract:** the `kete.account` runtime RPC.
- **Default change:** `Brand.urls.platform` (approved in spec.md).
- No config schema change. No HTTP API change, so no protocol or client regeneration.

## Cards read
- docs/context/modules/account-login.md (verified-at e34caf4d08, stale: no)
- docs/context/modules/server-sdk.md (e34caf4d08, stale: no)
- docs/context/modules/brand-env.md (e34caf4d08, stale: no)
- docs/context/modules/gateway.md (e34caf4d08, stale: no)
- docs/context/modules/sync.md (e34caf4d08, stale: no)
- docs/context/modules/session-share.md (e34caf4d08, stale: no). Share already reads the account on every call, so it needs no change.
- docs/context/modules/web-app.md (e34caf4d08, stale: no)
- docs/context/modules/ui-branding.md (e34caf4d08, stale: no)
- docs/context/modules/todo.md (a6f140247e, stale: no). This is the RPC pattern to copy.
- docs/context/pitfalls.md, decisions.md, commands.md

## Design decisions (and why)
1. **AC5 gate in the server, not in the plugin.** A plugin RPC handler never sees its caller (server-sdk card).
   A new Kete middleware `KeteAccountGate` sits next to `KeteLocalGuard`. It refuses every `kete.account`
   method except `status` unless all of these hold:
   - the server is bound to a loopback hostname (`KeteOffline.isLoopbackHost`; `0.0.0.0` and LAN names are refused);
   - the server is not on a unix socket;
   - no remote tunnel URL is active (the `remoteURLs` argument `ServerProcess.start` already receives; the tunnel dials from loopback, so a peer-address check would not catch it);
   - the server is not running in a remote session (`SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `CODESPACES`, `REMOTE_CONTAINERS`).

   When the server is loopback-only with no tunnel, a LAN or paired remote client cannot reach it. The
   server password is what makes the caller the local owner. Refusals return 403 with a fixed text that
   never echoes request values. Offline and job-mode refusals come from the plugin as data (`kind: "refused"`).
   The gate code is Kete-owned; `process.ts` gets 2 marked lines: the import, and one middleware in the
   existing pipe next to the local guard. No seam exists, because `ServerProcess.start` takes no
   middleware list (`transform` belongs to the web UI).
2. **One child-process helper.** Move the body of `tui/src/kete/setup-login.ts` `start()` into the new
   `util/src/kete/login-child.ts`, parameterised by the CLI args. The TUI file becomes a thin wrapper with
   the same exports, and its test must pass unchanged. The core plugin uses the same helper:
   - login runs `["login", "--no-browser"]` (the UI opens the browser, never the runtime);
   - logout runs `["logout"]`;
   - spawning uses `node:child_process` with no shell (pitfall: effect's spawner can't close a child's pipe);
   - `KeteJobMode.refuseSpawn` still applies.

   The packaged desktop runs the bundled `kete` binary as its server (`desktop/src/main/service/desktop-cli.ts`),
   so `selfCommand()` resolves to the right executable.
3. **Reload over the bus.** After a change the plugin emits `rpc.kete.account.changed`.
   - `gateway.ts` adds that event type to its existing `config.updated` reload filter, which calls `reload()`.
   - `sync/plugin.ts` subscribes and runs one `tick`. The child `kete login` has already synced, so this only reloads the cache.
   - Logout leaves already-applied managed agents in place until restart. That is existing behaviour (sync card), unchanged here.
   - Limit: RPC events are scoped to one location (`core/src/rpc.ts:96-100` publishes with `location: ref`), so other open locations pick up the change on their next reload or restart. See Risks.
4. **Settings → Account is a GUI plugin page, not new app settings tabs.**
   - Upstream-first: `@opencode/plugin/gui`'s `SettingsPage` registry (`plugin/src/gui/registries.ts:379,782`) adds a root page with 2 marked lines in `gui-plugins/src/renderer.ts`.
   - The alternative is editing the app's `settings/pages.ts`, `route.ts`, `shell.tsx`, `search-catalog.ts` and i18n, all upstream.
   - Code lives in `gui-plugins/src/kete/account/`, a Kete path; the template is the `pairing` plugin.
   - The new-session prompt stays in `app/src/kete/` (Kete-owned `panel.tsx`, next to `KeteLocalOffer`). Its **Sign in** button opens the Account settings page, so the sign-in flow lives in one place.
   - This deviates from spec item 2's "packages/app/src/kete/" for the Settings part. Approved by the user on 2026-11-04.
5. **Platform default:** `Brand.urls.platform = "https://app.ketecode.ai"`. Its only consumer is `account-flow.ts:351`, after flag, env, config and the previous account.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/schema/src/kete/todo.ts` | read | `Rpc.define` pattern (`:46-54`) |
| `packages/schema/src/kete/sync.ts` | read | status-shaped RPC example |
| `packages/schema/src/kete/account.ts` | **new** | `KeteAccountRpc.Definition`, id `kete.account`. Methods: `status` → `{ signedIn, organization?, platform? (host only), offline, signingIn }`; `login` → `{ kind: "started", url } \| { kind: "refused", reason, message } \| { kind: "failed", message }`; `cancel` → `{ cancelled: boolean }`; `logout` → `{ kind: "done" } \| refused \| failed`. Event `changed`: `{ state: "signed-in" \| "signed-out" \| "failed" \| "cancelled", message? }`. Also the shared text for the gate's 403 (`localOnlyMessage`). No key, key id, code or verifier fields. |
| `packages/util/src/kete/login-child.ts` | **new** | generalised `start({ args, onURL?, spawn?, command?, timeout?, env? })` + `selfCommand()`, moved from the TUI file |
| `packages/util/test/kete/login-child.test.ts` | **new** | URL parse, cancel → `cancelled`, timeout, non-zero exit → sanitised last stderr line, job-mode refusal |
| `packages/tui/src/kete/setup-login.ts` | change | delegate to `KeteLoginChild` (same exports, same behaviour incl. SSH `--no-browser`) |
| `packages/tui/test/kete/setup-login.test.ts` | read/run | must pass unchanged |
| `packages/util/src/kete/setup.ts` | read | `parseLoginURL` reused |
| `packages/util/src/kete/account.ts` | read | `read()`/`defaults()`/`Account` for `status` |
| `packages/util/src/kete/offline.ts` | read | `enabled()`, `isLoopbackHost()` |
| `packages/util/src/kete/job-mode.ts` | read | `enabled()`, `refuseSpawn()` |
| `packages/util/src/kete/brand.ts` | change | `urls.platform = "https://app.ketecode.ai"`; update the TODO comment at `:64-65` |
| `packages/core/src/kete/todo.ts` | read | `ctx.rpc.register` + `events.emit` pattern (`:87-101`) |
| `packages/core/src/kete/offline.ts` | read | `KeteOffline.active(config)` (honours `kete.offline` too) |
| `packages/core/src/kete/account.ts` | **new** | plugin `kete.account`: handlers above. One attempt per plugin instance: a second `login` returns the same URL. Validate the child's URL: `https:`, or `http:` only for a loopback host, and the path ending `/cli/authorize`. Waits ≤30 s for the URL. On the child's result, emit `changed`. A finalizer kills a running child. Offline / job mode → `refused`. Tests inject `command`. |
| `packages/core/src/plugin/internal.ts` | **change (upstream)** | marked import + `KeteAccount.Plugin` entry next to `KeteShare` (`:139`, `:384`) |
| `packages/core/src/kete/gateway.ts` | change | add `"rpc.kete.account.changed"` to the reload filter at `:469-476` (route it to `reload()`) |
| `packages/core/src/kete/sync/plugin.ts` | change | subscribe to `rpc.kete.account.changed` → run `tick` once (forked), near `:454` |
| `packages/core/test/kete/todo.test.ts` | read | plugin/RPC test harness to copy |
| `packages/core/test/kete/gateway.test.ts` | change | AC6: a `changed` event makes gateway models appear (fake gateway signed in) and disappear after the account is cleared |
| `packages/core/test/kete/fixtures/fake-login.ts` | **new** | stand-in for `kete login` (the real one would write the developer's OS keychain): prints the authorize URL with `state` + S256 `code_challenge`, listens on 127.0.0.1, and on the callback writes a file-storage `account.json` and exits 0. On SIGTERM it closes the listener and exits non-zero. |
| `packages/core/test/kete/account.test.ts` | **new** | AC1–AC5 (offline, job) and AC8. Logout runs the **real** CLI child (`[process.execPath, <repo>/packages/cli/src/index.ts]`) against a fake platform with a `storage: "file"` account, so no keychain is touched. Pass dirs to the child via HOME/XDG, never `OPENCODE_*` (the child's env bridge deletes inherited `OPENCODE_*`). If that proves infeasible, use a fixture and say so in handoff.md. Assert that no payload, event or log contains the key, key id, code or verifier. |
| `packages/server/src/kete/local-guard.ts` | read | middleware shape to copy |
| `packages/server/test/kete/local-guard.test.ts` | read | test shape |
| `packages/server/src/kete/account-gate.ts` | **new** | pure `check({ method, path }, { hostname, socket, remoteURLs, environment })` + `middleware(options)`. Match the decoded path segments `.../rpc/kete.account/<m>` with `m !== "status"`. 403 with fixed text and `cache-control: no-store`. |
| `packages/server/test/kete/account-gate.test.ts` | **new** | loopback v4/v6/localhost allowed; `0.0.0.0`/LAN name/socket/tunnel URL/each SSH var refused; `status` always passes; other RPCs untouched; percent-encoded id still gated |
| `packages/server/src/process.ts` | **change (upstream)** | marked import + `KeteAccountGate.middleware({ hostname, socket: options.socket, remoteURLs })` in the pipe at `:81` |
| `packages/server/src/handlers/rpc.ts` | read | confirm the route the gate matches (`/api/rpc/:rpcID/:method`) |
| `packages/plugin/src/gui/registries.ts` | read | `SettingsPage` (`:379-410`, `:782`) |
| `packages/plugin/src/gui/context.ts` | read | `servers` (`:280`), `desktop` (`:150`), how to pick the server the page talks to |
| `packages/plugin/src/gui/host-apis.ts` | read | `client` (`:23`), `openExternal` (`:1086`) |
| `packages/gui-plugins/src/pairing/index.ts`, `renderer.tsx`, `page.tsx`, `i18n/en.ts` | read | template for a settings-page plugin |
| `packages/gui-plugins/src/kete/account/index.ts` | **new** | `Plugin.define({ i18n: { en } })` |
| `packages/gui-plugins/src/kete/account/i18n/en.ts` | **new** | strings: "Account", "Signed in to {org}", "Sign in", "Sign out", "Waiting for the browser…", "Cancel", errors |
| `packages/gui-plugins/src/kete/account/controller.ts` | **new** | non-JSX state: status load, `signIn()` (RPC `login` → `openExternal(url)` → waiting), `cancel()`, `signOut()`, `changed` event → state; 403 → `localOnlyMessage` |
| `packages/gui-plugins/src/kete/account/controller.test.ts` | **new** | AC7 with a fake client and a fake `openExternal`: waiting, cancel, success, error, refused |
| `packages/gui-plugins/src/kete/account/renderer.tsx`, `page.tsx` | **new** | `ctx.add(SettingsPage, { id: "kete-account", icon, title, entries, render })`. The page renders controller state. Not gated on `ctx.desktop` (the web UI on the same machine gets it too). |
| `packages/gui-plugins/src/renderer.ts` | **change (upstream)** | marked import + `"kete-account": { ...keteAccount, windowEntry: eager(keteAccountRenderer) }` in `compose` |
| `packages/app/src/kete/todo-dock.tsx`, `todo.ts` | read | RPC call + event listen pattern in the app |
| `packages/app/src/kete/local-ui.tsx` | read | empty-state card markup to match |
| `packages/app/src/kete/panel.tsx` | change | mount `<KeteAccountPrompt />` next to `<KeteLocalOffer />` (`:43`) |
| `packages/app/src/kete/panel.css` | change | `data-kete="account-prompt"` rules (reuse the local-offer look) |
| `packages/app/src/settings/surface.tsx` | read | `useSettingsSurface().open(tab)` for a plugin tab (`:176`) |
| `packages/app/src/kete/account-prompt.ts` | **new** | pure `shouldShow(status)`, `fromEvent(event)` |
| `packages/app/src/kete/account-prompt.tsx` | **new** | status RPC + `changed` listener; signed out and not offline → card "Sign in to Kete Code to use your organization's models" + **Sign in** → open the Account settings page |
| `packages/app/src/kete/account-prompt.test.ts` | **new** | non-JSX test of `shouldShow`/`fromEvent` (app can't mount JSX components, web-app card gotcha) |
| `packages/cli/test/kete/login.test.ts` | run | still passes with the new `Brand.urls.platform` default. Adapt any assertion that relied on "no platform URL"; never delete it. |
| `docs/upstream-patches.md` | change | new section "Desktop sign-in": the 3 upstream files and why no seam fits |

## Steps
1. Schema: write `schema/src/kete/account.ts` (definition, unions, `localOnlyMessage`).
2. Util: create `login-child.ts` by moving the TUI `start()` logic. Make `setup-login.ts` delegate to it. Add `login-child.test.ts`. Run the util and TUI tests.
3. Brand: set `urls.platform`. Run the cli `login.test.ts`.
4. Server gate: write `account-gate.ts` and its test, then add the 2 marked lines in `process.ts`. Run the server test.
5. Core plugin: write `core/src/kete/account.ts` and register it in `internal.ts` (marked). Write the fixture and `account.test.ts`. Run it.
6. Reload: gateway filter + sync subscription; gateway test for AC6.
7. GUI plugin: create `gui-plugins/src/kete/account/*` plus the controller test, and register it in `renderer.ts` (marked).
8. App: `account-prompt.{ts,tsx}` + test; mount in `panel.tsx`; CSS.
9. `docs/upstream-patches.md` entry. Run all checks below and `upstream:check`.
10. Append to handoff.md what was done, any deviation, and the manual check list: desktop sign-in/out against a real platform, and refusal with `--hostname 0.0.0.0`.

## Verification
| Criterion | Command (narrowest first, inside the package) |
|---|---|
| AC1 | core: `bun run test ./test/kete/account.test.ts -t status` |
| AC2 | core: `bun run test ./test/kete/account.test.ts -t login`; cli: `bun test ./test/kete/login.test.ts` (PKCE S256, state, key saved: the real flow) |
| AC3 | core: `bun run test ./test/kete/account.test.ts -t cancel`; util: `bun test ./test/kete/login-child.test.ts`; tui: `bun test ./test/kete/setup-login.test.ts` |
| AC4 | core: `bun run test ./test/kete/account.test.ts -t logout` |
| AC5 | server: `bun run test ./test/kete/account-gate.test.ts`; core: `bun run test ./test/kete/account.test.ts -t refused` |
| AC6 | core: `bun run test ./test/kete/gateway.test.ts -t account` |
| AC7 | gui-plugins: `bun test ./src/kete/account/controller.test.ts`; app: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/account-prompt.test.ts` |
| AC8 | core: `bun run test ./test/kete/account.test.ts -t secret` |
| AC9 | `bun run typecheck` in schema, util, core, server, tui, cli, gui-plugins, app; `bun run test ./test/kete` in core and server; `bun test ./test/kete` in util, tui, cli; `bun run test:unit` in app; `bun test` in gui-plugins; root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run check:generated` in `packages/protocol` and `packages/client` (must be clean: no regeneration) |

## Cards to update after the build
- account-login: the `kete.account` RPC, `login-child.ts`, the platform default, and the UI sign-in path (replace the "no UI path" quick answer)
- server-sdk: `KeteAccountGate` (rules, what it trusts, and the 2 marked lines in `process.ts`)
- brand-env: `urls.platform` is set (fix the quick answer and the "stay undefined" rule)
- gateway: reloads on `rpc.kete.account.changed`
- sync: runs a tick on `rpc.kete.account.changed`
- web-app: the account prompt in the empty state, and the GUI-plugin settings page seam
- ui-branding: none unless styles move
- New quick answers from handoff.md's "Docs enough: no" lines
- docs/context/INDEX.md: add `gui-plugins/src/kete/account` under account-login's covered paths

## Risks
- **Cross-location reload:** RPC events are per location, so a second open project keeps its old gateway models until it reloads. Follow-up if desktop users hit it: the app calls the existing `location.reload` on `changed`, as `kete login` does.
- **Gate scope:** the gate is decided from how the server was started. Desktop or service setups bound to a LAN address for pairing will refuse sign-in. The refusal says to use the app on this computer or run `kete login`. A user's own `ssh -L` forward to a loopback server is not detectable; it needs the server password anyway.
- **Concurrency:** one attempt per location instance. Two locations can start two `kete login` children; the last to finish wins, and the CLI already revokes the replaced key.
- **Default platform URL** changes `kete login` for everyone (approved).
