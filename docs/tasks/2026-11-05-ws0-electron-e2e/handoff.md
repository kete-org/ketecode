# Handoff: WS0 Electron e2e harness

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 planner
- Done: plan.md written. Cards `desktop` and `kete-tools-ci` current (stale-cards.mjs: all current).
- Decisions: the e2e is a Bun script (`e2e/kete/electron.ts`) using `_electron` from `@playwright/test`, not the Playwright test runner, because the reused smoke helpers use Bun APIs and the runner's workers run in Node. Step 1 is a spike; if Playwright's Electron launch fails under Bun, hand back to the planner. New files go in `e2e/kete/` because `upstream:check` fails new files outside kete paths. Onboarding is skipped by writing the settings file; the native folder picker is stubbed in main through `electronApp.evaluate`. No app code changes. The only upstream edit is `desktop/package.json` (JSON, recorded in upstream-patches.md).
- Docs enough: no. Missing:
  - desktop card: where the onboarding flag is stored (`<userData>/opencode.settings`, key `firstLaunchOnboardingComplete`, `main/storage/keys.ts`, `main/lifecycle/onboarding.ts:11`).
  - desktop card: Home's "add project" opens a native `dialog.showOpenDialog` (`main/files/index.ts:34`), so an e2e must stub it.
  - desktop card: the renderer selectors an e2e drives (`home-add-project-row`, `home-new-session`, `composer-editor`, `composer-model`).
  - desktop card: the smoke's cleanup is inline in `main`'s `finally`, not an exported helper (the plan extracts `stopAll`).
  - desktop card: the smoke helpers are Bun-only, so the Playwright runner (Node) can't import them.
  - config-kete or a provider card: no card covers custom provider config in `kete.json`, or `@ai-sdk/openai-compatible` mapping to the bundled native package (`core/src/aisdk-native.ts:70`; reader at `ai/src/protocols/openai-compatible-chat.ts`).
- Open questions: whether the runtime fetches the models.dev catalogue at startup without network (CI has network; not checked). Whether Playwright's own Electron args (`--inspect=0`, `--remote-debugging-port=0`) reach a packaged app (no fuses are set in `electron-builder.config.ts`, so they should).

## 2026-11-05 implementer
- Done (no shell available, so NOTHING was run): added `@playwright/test: catalog:` to `packages/desktop/package.json` (bun.lock NOT touched; needs `bun install`); exported `until`, extracted `unpackApp` and `stopAll` in the smoke (+ one `stopAll` test); wrote `e2e/kete/fake-provider.ts` (+ test) and `e2e/kete/electron.ts`; workflow steps "E2E packaged app" and "Upload E2E results" (dispatch only); `docs/desktop.md` section; `docs/upstream-patches.md` row.
- Decisions: `stopAll` returns survivors (undefined if none) as the old inline code did. `electron.ts` takes the app's pid from `electronApp.process()`. Results dir is created on failure. The fake's usage chunk sets `total_tokens: 7`.
- Unverified: all checks (AC1, AC2, AC4), selectors/flow in electron.ts (model-control "Fake" click path is a guess), typecheck of `electronApp.evaluate` destructuring and the `page` type alias.
- Not done: step 5 (two macOS runs against a fresh pack).

## Main session: step 1 spike (2026-11-05)
PASS. A Bun script importing `_electron` from `@playwright/test` (1.60.0, from packages/app) launched the packed macOS
app (`Kete Code Dev.app/Contents/MacOS/Kete Code Dev`) with the smoke's isolated env, got the first window in 3.1 s
(title "Kete Code"), and `app.close()` returned; no app or runtime process was left. Proceed with the plan.
