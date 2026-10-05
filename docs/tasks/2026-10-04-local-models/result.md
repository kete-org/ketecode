# Result: Local models: remote Ollama, setup and picker, offline mode, capabilities

Built in three passes on `feature/local-models`: A = core, util and schema (steps 1–10), B = CLI
(11–12), C = TUI, web UI, docs and verification (13–16). Not pushed.

## What changed
**util / schema**
- `util/src/kete/offline.ts`: the offline flag (`KETE_OFFLINE`, fails closed) and the "is this host local?" rule.
- `util/src/kete/local-picker.ts`: rules shared by the TUI and web UI (badges, unreachable lines, first-run offer, no-tools notice, offline from config).
- `schema/src/config/kete.ts` (`kete.offline`); `schema/src/kete/local-models.ts` (RPC `kete.local-models`: `status`, `rediscover`).

**core**
- `core/src/kete/local-hosts.ts`: `KETE_OLLAMA_HOST` > `OLLAMA_HOST`, `KETE_LMSTUDIO_HOST`, `KETE_VLLM_HOST` fed in as the upstream plugins' `origin` (config `baseURL` still wins).
- `core/src/kete/local-models.ts`: status probe, plain-HTTP warning, rediscovery, no-tools `session.context` hook, Ollama context warning.
- `core/src/kete/offline.ts`: model, remote-MCP and web-tool filters; the offline no-ops in `gateway.ts`, `sync/plugin.ts`, and the check in `run-checks.ts`.
- Upstream edits (marked): `plugin/provider/{ollama,lmstudio,vllm,opencode}.ts`, `plugin/internal.ts`, `session/runner/{llm,model}.ts`.
- Regenerated `protocol/openapi.json` and `client/src/*/generated/` for `kete.offline`.

**cli**
- `--offline` global flag, `cli/src/kete/{offline,offline-startup}.ts`, private-server rule (`--server` refused), refusals in `login`, `sync`, `upgrade`, `updater`.
- `kete models pull` (`cli/src/kete/models-pull.ts`), `kete models` TTY details (`models-list.ts`).
- Upstream edits (marked): `index.ts`, `framework/runtime.ts`, `commands/commands.ts`, `services/server-connection.ts`, `commands/handlers/models.ts`.

**tui** (pass C)
- `tui/src/kete/local-models.ts` (status fetch, dialog fields, unreachable rows), `local-offer.tsx` (first-run offer, once-per-session notice, dialog status + context warnings), `local-status.tsx` (Offline footer indicator).
- Upstream edits (marked): `component/dialog-model.tsx`, `plugin/builtins.ts`, `app.tsx`, `test/fixture/tui-client.ts`.

**app / VS Code** (pass C)
- `app/src/kete/local-models.ts` (status fetch, badges, group titles), `local-ui.tsx` (badges, unreachable lines, Offline indicator, first-run offer card, no-tools notice), wiring in `panel.tsx`, `panel.css`, `composer-controls.tsx`.
- Upstream edits (marked): `providers/models/select-dialog.tsx`, `providers/models/provider-group.tsx`.

**docs**
- `docs/local-models.md` (new guide), a "Local models" section in `.github/README.md`, `docs/upstream-patches.md` "Local models" rows, the new card and card refreshes (below).

## Checks
| Check | Result |
|---|---|
| `bun run typecheck` in util, schema, core, cli, tui, app | pass (all six) |
| core `bun run test ./test/kete` | pass: 352 pass, 0 fail (363 tests, the rest skipped) |
| core upstream provider tests (`provider-{ollama,lmstudio,vllm}.test.ts`) | pass: 14/14 |
| util `bun test ./test/kete` | pass: 271/271 |
| cli `bun test ./test/kete` | pass: 230 pass, 0 fail. `models-pull.test.ts` failed one test once when run alone right after the full suite; 15 more runs all passed (16/16). Counted as a flaky timing test, not reproduced |
| tui `bun test ./test/kete` | pass: 22/22 |
| tui full suite `bun run test` | pass: 1406 pass, 0 fail (a first run failed 56, caused by the new status request and fixture models without `capabilities`; fixed) |
| app `bun run test:unit` | pass: 995 pass, 0 fail (the "disk full" / ECONNRESET lines are simulated errors in `namespace.test.ts`) |
| root `bun run lint` | pass: 0 warnings, 0 errors |
| `bun run --cwd packages/kete-tools upstream:check` | pass |
| `bun run check:generated` in `packages/protocol` and `packages/client` | pass (exit 0, no diff) |
| `node scripts/agent/stale-cards.mjs` | "All cards current." |
| `node scripts/agent/card-check.mjs` | "✓ 28 cards and docs/context clean." |
| `bun run --cwd packages/kete-tools verify --base main` | not run (the PR step; the package checks above cover it) |

## Acceptance criteria
- [x] AC1: env hosts, config wins, one-time plain-HTTP warning. Evidence: core `local-hosts.test.ts` 28/28.
- [x] AC2: status served over the RPC and shown in the TUI dialog and web picker, including the unreachable line. Evidence: core `local-models.test.ts -t status` 9/9; tui `local-models.test.tsx` 11/11 (unreachable rows, Local group, frame test of the Offline indicator); app `local-models.test.ts` 9/9 (RPC fetch + validation, unreachable lines). The TUI full suite exercises the dialog against the fixture's status answer.
- [x] AC3: offer shown once when no model is set and a server is reachable; accepting selects a model. Evidence: tui `-t offer` 4/4, app `-t offer` 3/3. Per R3, accepting sets the client's persisted selection, not config.
- [x] AC4: `kete models pull`. Evidence: cli `models-pull.test.ts` 16/16 (see the flaky note); core `-t rediscover` 2/2.
- [x] AC5: offline mode. Evidence: util `offline.test.ts` 41/41; core `offline.test.ts` 12/12, `gateway.test.ts -t offline` 2/2, `policy-sync.test.ts -t offline` 2/2 (cached deny policy still applies); cli `offline-startup.test.ts` 12/12, `updater.test.ts -t offline` 1/1.
- [x] AC6: no-tools models run without tools, with the user notice; a config override restores tools. Evidence: core `-t tools` 4/4; tui and app `-t notice` 1/1 each.
- [x] AC7: Ollama small-context warning once. Evidence: core `-t context` 5/5. The TUI shows it once per model when the model dialog loads status.
- [x] AC8: `docs/local-models.md`, the `.github/README.md` section and the `local-models` card exist; `upstream:check` passes; typecheck and tests pass in every touched package.

## Deviations
- The README section is in `.github/README.md`; the root README is upstream's (plan note).
- Shared client rules live in `util/src/kete/local-picker.ts` rather than being copied into the TUI and app helper files. util has no internal dependencies, so the status types there are structural.
- TUI: the plan's `tui/src/kete/local-models.tsx` plugin is `local-status.tsx` (so it doesn't share a module name with `local-models.ts`). The Offline indicator reads the process flag and the location's config with no RPC. The Ollama context warning toast is shown from the model dialog's status fetch (`useKeteLocalStatus`), not at startup, so startup does no probing.
- The first-run offer asks for status only when the catalog already lists a model from a local server. Without one there is nothing to offer, and this avoids probing on every start.
- TUI unreachable rows stay selectable: the dialog hides disabled rows. Selecting a row shows the full hint as a toast.
- Web: local provider groups are titled "Local · Ollama" (dialog sections and menu labels), not merged into one group. Unreachable lines appear in the model dialog only, not in the compact composer menu.
- An upstream test fixture edit (`tui/test/fixture/tui-client.ts`, marked) answers the status RPC.

## Review findings fixed (2026-10-05)
| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | MAJOR: offline mode still contacted public hosts (status probe, upstream discovery) | `KeteOffline.active`/`blocks` (`core/src/kete/offline.ts`); one marked guard line in `discover` of `plugin/provider/{ollama,lmstudio,vllm}.ts`; the status probe returns a new state `blocked` with "offline mode: `<url>` isn't on this machine or a private network" and sends nothing (no API key). Schema `State` gains `blocked` (plugin RPC only, not in `openapi.json`); util `unreachable()` gives it a line, so the TUI and web picker show it unchanged | core `offline-discovery.test.ts` 10/10 (recording stub client: public base URL + offline → zero requests for all three plugins; private-network host still discovered; offline off → contacted); `local-models.test.ts` "status in offline mode" 3/3 (config and env offline, zero requests to the public host, key never in the status); util/tui/app blocked-line tests |
| 2 | MAJOR: status `error` could leak a credentialed URL | transport failures map to fixed texts by error code (`transportReason`: "connection refused", "host not found", "connection reset", "timed out", "TLS certificate not accepted", "can't connect"); requests built from the credential-free base URL; `clean()` also strips query strings | `local-models.test.ts` "status errors" 2/2: `http://user:hunter2@127.0.0.1:<closed>/v1?token=abc` → neither `hunter2` nor `abc` (nor `user:`) in the status JSON or logs |
| 3 | MINOR: project `kete.offline` vs running loops | gateway `refresh`/`balance`, sync ticks (periodic and on-demand) and each registration tick re-check `KeteOffline.active`; `opencode.ts` uses it through `Effect.serviceOption(Config.Service)` (no change to its declared requirements or upstream tests); `docs/local-models.md` "Scope" lists process-wide vs live switches | `gateway.test.ts` live offline test; `policy-sync.test.ts` sync pause/resume and registration re-check tests |
| 4 | MINOR: `--offline=false` / `--offline false` | `flagged` uses the parser's truthy/falsy values (`--offline false` was on, `--offline=yes` was off); unknown values fail closed | `offline-startup.test.ts` 2 new tests, one pinning `flagged` against the real effect CLI parser |

Also: `upstream:check` was failing on this branch ("new file outside a kete path: docs/local-models.md"); `docs/local-models.md` is now in `isKeteOwned` (`kete-tools/src/lib.ts`, like `docs/jobs.md`).

Checks after the fixes (2026-10-05): typecheck util, schema, core, cli, tui, app, kete-tools pass; core `bun run test ./test/kete` 370 pass / 0 fail (11 skip); provider tests ollama/lmstudio/vllm 14/14, opencode 30/30; util `./test/kete` 258 pass / 0 fail (14 skip); cli `./test/kete` 232 pass / 0 fail; tui `./test/kete` 23/23 and full `bun run test` 1407 pass / 0 fail; app `test:unit` 995 pass / 0 fail; kete-tools `bun run test` 59/59; root lint 0 warnings / 0 errors; `upstream:check` pass; protocol and client `check:generated` pass (no diff); `stale-cards.mjs` all current; `card-check.mjs` clean.

## Left undone / follow-ups
- `kete models pull` against a bearer-token Ollama (documented limitation).
- Request-executor guard for process-wide offline (R4 follow-up).
- Clamping `limit.context` to Ollama's served window (R2 follow-up).
- `verify --base main` before opening the PR.

## Cards updated
- New: `docs/context/modules/local-models.md` (+ INDEX row). Its Quick answers cover every "Docs enough: no" gap in handoff.md: plugin RPC, `session.context` hook, CLI `{ $, sub }` handler map, TUI slots/toast, web picker files, `ModelUnavailableError`, config PATCH accepting only `shell`, no LSP download.
- Refreshed (verified-at `604889ab32`): attribution-hosted (outbound-call list, what offline turns off), cli, config-kete, gateway, sync, runtime-registration, permissions, unattended, web-app, server-sdk, account-login, budget, subagents, workflows, brand-env, ui-branding; `docs/context/commands.md` (new test files).

## Metrics
- Agents used: planner; implementer (pass A); build agents for passes B and C; librarian (pass C cards).
- Scout lookups: 0, docs enough: – (– %)
- Tokens / cost (from /usage): n/a (librarian ~89k subagent tokens)
- Time: about 1 day across three passes
