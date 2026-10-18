# Plan: One first-run setup flow (A15)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Size: Large — approved by the user 2026-10-18.** It edits upstream files
(three runtime files, two test files; listed under "Upstream edits") and adds two contracts (`/setup`,
TUI storage key `kete-setup`). No config schema, protocol or server change; no regeneration.
Security-relevant: the TUI spawns a `kete login` child (secret handling, timeout, cancel).

## Cards read
- docs/context/modules/local-models.md (verified-at a6f140247e, stale: no)
- docs/context/modules/account-login.md (verified-at ecfae5cce7, stale: no)
- docs/context/modules/cli.md (verified-at b8e534dfcb, stale: no)
- docs/context/modules/ui-branding.md (verified-at 41ddef7737, stale: no)
- also `gateway.md`, `sync.md` (Quick answers only), `pitfalls.md`, `commands.md`

## Decisions (made here; see handoff.md for the questions behind them)
- **Mechanism for sign-in: a child `kete login` process**, not a runtime call. The login flow
  (`cli/src/kete/account-flow.ts:32`) lives in `packages/cli`, which the TUI can't import, and it already
  prints only the URL and organization (never the key). The TUI parses the URL line from the child's
  stdout, shows it, never logs or toasts raw child output, and on exit 0 calls
  `client.api.location.reload()` (as `/reload` does, `tui/src/app.tsx:1043-1056`) so the runtime reads
  the new account. The key stays in the OS store; the child's `KeteSync.sync` and reload notice run as
  in `kete login`.
- **Self command:** the TUI runs in the CLI's process, so it mirrors `selfCommand()`
  (`cli/src/util/process.ts:5-28`) in a Kete-owned file with a comment naming the original (the
  `kete skill` mirroring pattern in pitfalls.md). No upstream `args` edit.
- **When it shows:** `!done && !connected && !hasModel`, where `connected` =
  `hasConnectedProvider(integrations)` (`tui/src/util/connected-provider.ts:3`) **or** `kete.sync`
  status `signedIn`, and `hasModel` is the same expression `local-offer.tsx:43-47` computes. If the
  `kete.sync` status RPC fails, the screen does not show (advisory, like the notices).
- **Hook placement:** the trigger lives in Kete code called from the existing `useKeteLocalModels()`
  (already mounted at `tui/src/app.tsx:497`), so `app.tsx` is not edited. The local offer runs only
  after the setup decision, and is skipped in a launch where the setup screen showed.
- **Esc on the screen counts as Skip** (records `done`), so it shows once; `/setup` reopens it.
- **Default gateway model:** after sign-in, the first `kete` model in the catalog that can call
  tools, else the first `kete` model (the existing `KeteLocalPicker.pick` rule, widened to any
  provider ID). Wait up to 30 s for `kete` models to appear; if none, record done and toast
  "Signed in. Pick a model with /models." (no silent success).
- **CLI hint:** detected from the session error the client receives — `type === "provider.no-route"`
  and the message starts with `No model is available for session` (`core/src/session/runner/model.ts:17`,
  mapped at `core/src/session/to-session-error.ts:56-64`). A core Kete test pins that pairing so an
  upstream message change fails a test, not silently drops the hint. Human output only; JSON output is
  unchanged.
- **TUI side of the hint:** the TUI never sends a prompt without a model (`promptModelWarning`), and
  that path now opens the setup screen, so no TUI error-text change.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/util/src/kete/local-picker.ts` | change | widen `pick`'s `providerID` (`:115-121`) to `string`; reused for the gateway default |
| `packages/util/src/kete/setup.ts` | **new** | pure rules: `shouldShow`, `rows` (sign-in hidden offline; local row from status; hint when none), `parseLoginURL(line)`, `HINT` text (from `Brand.cliName`), `isNoModel(error)`, `withHint(error)` |
| `packages/util/test/kete/setup.test.ts` | **new** | rules, URL parse (only `http(s)` lines; ignores others), hint matching |
| `packages/util/src/kete/notices.ts`, `brand.ts` | read | `Brand` usage and module shape to copy |
| `packages/tui/src/kete/local-offer.tsx` | change | call the setup hook; run `firstRunOffer` only after setup decided and not shown this launch |
| `packages/tui/src/kete/local-models.ts` | read | `fetchStatus` (`:19`), `canCallTools`; add a `rediscover` call (`KeteLocalModelsRpc` method `rediscover`) for "check again" |
| `packages/schema/src/kete/local-models.ts` | read | `Status`/`ProviderStatus` shape, `rediscover` method (`:58-72`) |
| `packages/schema/src/kete/sync.ts` | read | `KeteSyncRpc.Status` (`signedIn`, `offline`) |
| `packages/tui/src/kete/home-notices.tsx` | read | how `kete.sync` `status` is called and decoded (`:73-96`), storage store pattern (`:120+`) |
| `packages/tui/src/kete/setup.tsx` | **new** | `useKeteSetup()` (storage `kete-setup` `{ done }`, decision, `/setup` + palette command via `Keymap.createLayer` as `permission-mode.tsx:102-116`), `KeteSetupDialog` (rows, sign-in waiting view with URL and Cancel, local list / hint + "Check again"), exported for the prompt |
| `packages/tui/src/kete/setup-login.ts` | **new** | child sign-in: mirrored self command, `spawn` with `stdio: ["ignore","pipe","pipe"]`, URL from stdout, 6 min kill timer, `cancel()` kills the child, result `{ kind: "ok" } | { kind: "failed"; reason } | { kind: "cancelled" }`; `KeteJobMode.refuseSpawn` first (as `util/src/kete/secret-store.ts:178`); injectable `spawn` for tests |
| `packages/tui/src/kete/permission-mode.tsx` | read | `Keymap.createLayer` command with `slash` and `palette` (`:102-116`) |
| `packages/tui/src/kete/local-status.tsx` | read | offline read: `offlineFrom(KeteOffline.enabled(), config)` (`:30`) |
| `packages/tui/src/kete/statusline.tsx` | read | `DialogSelect` usage in Kete code (`:341,373`) |
| `packages/tui/src/ui/dialog-select.tsx`, `ui/dialog.tsx` | read | dialog API (`replace`, `clear`, on-close callback) |
| `packages/tui/src/component/dialog-integration.tsx` | read | `onConnected` prop (`:41,75-76`) to record done |
| `packages/tui/src/component/dialog-model.tsx` | read | what `/connect` opens after connecting (`app.tsx:974-978` replaces with `DialogModel`) |
| `packages/tui/src/context/local.tsx` | read | `model.ready`/`catalogReady` (`:383-388`), `model.set` (`:452`), fallback order (`:181-206`) |
| `packages/tui/src/util/connected-provider.ts` | read | `hasConnectedProvider` |
| `packages/tui/src/feature-plugins/sidebar/footer.tsx` | **change (upstream)** | `:64` dispatch `kete.setup` instead of `provider.connect`, marked one-liner |
| `packages/tui/src/component/prompt/index.tsx` | **change (upstream)** | `:327` `<DialogIntegration />` → `<KeteSetupDialog />`, plus its import near `:46`; both marked (comment on its own line in JSX — pitfalls.md) |
| `packages/cli/src/run/noninteractive.ts` | **change (upstream)** | `:482` and `:491` `UI.error(event.data.error.message)` → `UI.error(KeteSetup.withHint(event.data.error))`, plus import near `:15`; marked; `process.exitCode = 1` untouched |
| `packages/tui/test/feature-plugins/sidebar-footer.test.tsx` | **change (upstream test)** | `:117` expects `["kete.setup"]`; marked |
| `packages/tui/test/fixture/tui-client.ts`, `test/fixture/app.ts`, `test/fixture/tui-environment.tsx` | read, then **change one (upstream test)** | the fixture has no providers or models (`tui-client.ts:150`), so the screen would open in every whole-app test: seed `kete-setup` `{ done: true }` in the test state dir by default with an opt-out for the setup tests (path pattern `<state>/test/tui/<key>.json`, see `test/kete/home-notices.test.tsx:122`); marked |
| `packages/tui/test/kete/home-notices.test.tsx`, `test/kete/local-models.test.tsx` | read, change if needed | storage-file pattern; the offer test must still pass (offer after setup decided) |
| `packages/tui/test/kete/setup.test.tsx` | **new** | AC1–AC6 through the app fixture |
| `packages/tui/test/kete/setup-login.test.ts` | **new** | fake spawn: URL shown, cancel kills, timeout kills, exit≠0 → failed with last stderr line only, nothing printed to stdout/log |
| `packages/core/test/kete/setup-hint.test.ts` | **new** | `isNoModel(toSessionError(new ModelNotSelectedError({ sessionID })))` is true; `ModelUnavailableError` is false |
| `packages/core/src/session/to-session-error.ts`, `session/runner/model.ts` | read | the mapping the test pins |
| `.github/README.md` | change | "Get started" (`:72-80`): `kete` with nothing set up offers sign-in, own key or local model; `/setup` |
| `CHANGELOG.md` | change | "Unreleased" entry |
| `docs/local-models.md` | change | `:26` first-run paragraph: the setup screen comes first; the offer only later |
| `docs/upstream-patches.md` | change | new section "First-run setup (feature/first-run-setup)" listing the five upstream edits |

## Steps
1. **util rules.** Widen `pick` to `providerID: string`. Write `util/src/kete/setup.ts` (namespace
   export `KeteSetup`, like `KeteLocalPicker`) and its test. `HINT` =
   `` Run `kete` to set up, or `kete login`, `kete auth login`, or start a local model server. `` built
   from `Brand.cliName`. `withHint(error)` returns `message + "\n" + HINT` when `isNoModel`, else the
   message.
2. **CLI hint.** Edit `cli/src/run/noninteractive.ts` at `:482` and `:491` (marked, minimal). Add the
   core pin test.
3. **Sign-in child.** Write `tui/src/kete/setup-login.ts`. Pass `--no-browser` only when the parent
   is in an SSH session (as `login.ts:20` detects); otherwise the child opens the browser. Inherit
   `process.env` (the child's env bridge must accept an already-bridged env — confirm by reading
   `util/src/kete/env.ts` `marker` handling; if it drops the bridged values, stop and write to
   handoff.md). Never forward child output anywhere except the parsed URL and, on failure, the last
   stderr line with the `Warning: ` prefix stripped. Its test.
4. **Setup screen.** Write `tui/src/kete/setup.tsx`:
   - storage `useStorage().store<{ done: boolean }>("kete-setup", { initial: { done: false } })`;
   - decision once, when `local.model.ready && catalogReady` and config/integrations are loaded,
     fetching `kete.sync` status (decode with `KeteSyncRpc.Status`, 15 s timeout);
   - rows from `KeteSetup.rows`: sign-in (hidden when offline per `offlineFrom` or status `offline`),
     own key → `DialogIntegration` with `onConnected` → record done, then `DialogModel` as `/connect`
     does; local → list reachable servers with model counts from `fetchStatus`, select via `pick` and
     `local.model.set(model, { recent: true })`, record done; none found → hint lines (`ollama serve`,
     start LM Studio's server) and "Check again" (`rediscover` then status); skip / Esc → record done;
   - sign-in view: "Waiting for approval…", the URL, Cancel; on ok → `location.reload()`, wait for
     `kete` models (≤ 30 s), pick, set, toast `Using kete/<model>.`, record done; on failed → toast the
     reason and return to the rows;
   - `/setup` command (`id: "kete.setup"`, palette, group "System") opens the dialog any time;
   - layout fits 80×24 (≤ 14 rows of content).
5. **Local offer.** In `local-offer.tsx`, call `useKeteSetup()` and make the offer effect wait for its
   decision; skip the offer when the screen showed this launch. Keep the `kete-local-offer` flag logic.
6. **Upstream one-liners.** Sidebar `:64` dispatch, prompt `:327` + import, both marked; JSX comments
   on their own line.
7. **Test fixture.** Seed `kete-setup` done by default; update `sidebar-footer.test.tsx:117`. Write
   `test/kete/setup.test.tsx`.
8. **Docs.** README, CHANGELOG, `docs/local-models.md`, `docs/upstream-patches.md`.
9. Run the verification below; then `upstream:check`.

## Upstream edits (and why no seam works)
- `tui/src/feature-plugins/sidebar/footer.tsx` — the button's target is a literal command ID; no slot
  or config replaces it (spec: "only changes what they open").
- `tui/src/component/prompt/index.tsx` — `promptModelWarning` opens `DialogIntegration` directly;
  no hook or plugin event for "prompt without provider".
- `cli/src/run/noninteractive.ts` — the error is printed inline from the event stream; no output hook.
- `tui/test/feature-plugins/sidebar-footer.test.tsx`, one fixture file under `tui/test/fixture/` —
  test consequences of the above.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun test ./test/kete/setup.test.tsx` in `packages/tui` (shows once with nothing set; not with a provider, a model, signed in, or `done`) |
| AC2 | same file (own-key row opens the integration dialog; `onConnected` writes `kete-setup.json` done) |
| AC3 | same file (status fixture with Ollama models → list and selection; empty → hint and "Check again" calls `rediscover`) |
| AC4 | `bun test ./test/kete/setup-login.test.ts` in `packages/tui`; plus `setup.test.tsx` (row hidden with status `offline: true`; ok → model selected) |
| AC5 | `bun test ./test/kete/setup.test.tsx` in `packages/tui` (Skip/Esc record done; `/setup` reopens) |
| AC6 | `bun test ./test/kete/setup.test.tsx ./test/kete/local-models.test.tsx ./test/feature-plugins/sidebar-footer.test.tsx` in `packages/tui` |
| AC7 | `bun test ./test/kete/setup.test.ts` in `packages/util`; `bun run test ./test/kete/setup-hint.test.ts` in `packages/core`; then binary: `bun run build --single --skip-install --skip-web-ui` in `packages/cli`, and with an empty temp `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME` run `dist/cli-<os>-<arch>/bin/kete run hi; echo $?` → hint printed, exit 1 |
| AC8 | `bun run typecheck` and `bun test` in `packages/tui`, `packages/cli`, `packages/util`; `bun run test ./test/kete` in `packages/core`; `bun run --cwd packages/kete-tools upstream:check`; `bun run lint` |

## Cards to update after the build
- `local-models` — first-run offer now runs after the setup decision; `pick` takes any provider ID.
- `account-login` — sign-in can also start from the TUI's setup screen (child `kete login`).
- `cli` — the `kete run` no-model hint (`noninteractive.ts`, `KeteSetup.withHint`).
- `ui-branding` — home/first run: the setup screen, `/setup`, `kete-setup`; plus the handoff's
  "Docs enough: no" gaps as Quick answers.
