# Plan: WS0 Electron e2e harness

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task (spec.md already approved).** It edits one upstream file: `packages/desktop/package.json`
> (JSON, so no marker is possible) to add the `@playwright/test` devDependency. The edit is recorded in `docs/upstream-patches.md`.
> No seam avoids it: the harness imports Playwright from the desktop package, and the spec asks for the devDependency.
> There is no shared contract, config schema or security change. Everything else is Kete-owned (`e2e/kete/`,
> `script/kete-*`, `kete-desktop.yml`, `docs/desktop.md`).

## Cards read
- docs/context/modules/desktop.md (verified-at 638fdfbe80, stale: no)
- docs/context/modules/kete-tools-ci.md (stale: no)
- docs/context/modules/config-kete.md (Quick answers only: the runtime drops an invalid config file silently, so the test checks that the provider loaded)
- docs/context/pitfalls.md, decisions.md, commands.md

## Design decisions (read before step 1)
- **Runner: a Bun script, not the Playwright test runner.** The helpers reused from `script/kete-packaged-smoke.ts`
  use Bun APIs (`Bun.listen`, `Bun.write`, `Bun.Glob`, `Bun.spawn`, `Bun.sleep`), and `playwright test` runs its
  workers in Node. So `e2e/kete/electron.ts` is a plain script like the smoke (`if (import.meta.main)`) that imports
  `_electron` from `@playwright/test`. On failure it keeps a Playwright trace zip (`electronApp.context().tracing`)
  and a screenshot in `$KETE_E2E_RESULTS`, or in a fresh `os.tmpdir()` folder whose path it prints. CI uploads that
  folder. The trace and screenshot stand in for the spec's "Playwright report", and writing them outside the repo means no `.gitignore` edit.
- **Paths must contain `kete`.** `upstream:check` fails any new file outside a kete path, so every new file goes in
  `packages/desktop/e2e/kete/`.
- **Onboarding**: before launch, write `<OPENCODE_DESKTOP_TEST_ROOT>/desktop/opencode.settings` =
  `{"firstLaunchOnboardingComplete": true}`. `userData` is `<testRoot>/desktop`. The store file name is
  `SETTINGS_STORE` and the key is `FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY` (`src/main/storage/keys.ts`); the key is
  read at `src/main/lifecycle/onboarding.ts:11`.
- **Opening a project without a native dialog**: Home's "add project" calls main's `dialog.showOpenDialog`
  (`src/main/files/index.ts:34`). The test stubs it in the main process with
  `electronApp.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, projectDir)`,
  so no app code changes. Selectors, taken from the app's own e2e: `[data-action="home-add-project-row"]`, then
  `[data-action="home-new-session"]`, editor `[data-component="composer-editor"]`, model control
  `[data-action="composer-model"]`.
- **Fake provider config** goes in `<testRoot>/config/kete/kete.json`. The runtime inherits the test root's
  `XDG_CONFIG_HOME`, the same directory `writeServiceConfig` writes to:
  `{ "model": "kete-e2e/fake", "provider": { "kete-e2e": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://127.0.0.1:<port>/v1", "apiKey": "unused" }, "models": { "fake": { "name": "Fake" } } } } }`.
  `@ai-sdk/openai-compatible` maps to the bundled native `@opencode/ai/providers/openai-compatible`
  (`core/src/aisdk-native.ts:70`), so nothing is downloaded. The runtime drops an invalid config file silently, so
  after registration the script checks that the runtime lists the `kete-e2e` provider (authenticated
  `GET <url>/api/config`, Basic `opencode:<password>`). If it doesn't, the script fails with a clear message.
- **The fake server answers every POST `/v1/chat/completions`** with the same SSE stream, because the runtime may
  also ask the model for a session title. Every other path gets a 404. It counts requests for the failure report.
- **Cleanup order**: close the app first (`electronApp.close()` raced against 15 s, then kill its pid), then kill
  every runtime pid seen plus the last registration's pid. Killing the runtime first would make the app's watcher
  restart it. Playwright pipes the app's stdio and the runtime inherits it; the timed race stops a pipe that never
  closes from hanging the run.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/desktop/script/kete-packaged-smoke.ts` | change | Export `until`. Extract and export `unpackApp(app, root)` (the tar/bundle/exe branch of `main`, returns the executable path) and `stopAll({ app?: { pid, exited }, runtimePids, current })` (the `finally` block's stop, kill and survivor check, returning the survivors). `main` calls both, with unchanged behaviour (Windows `taskkill`, the 10 s waits, the "left a process behind" failure). |
| `packages/desktop/script/kete-packaged-smoke.test.ts` | read, change | Must keep passing. Add one `stopAll` test: a spawned long-running child is killed and is not reported as a survivor. |
| `packages/desktop/e2e/kete/fake-provider.ts` | new | `FAKE_ANSWER` constant. `fakeProvider()`: `Bun.serve` on port 0 that streams SSE `chat.completion.chunk`s (a role+content chunk, then a `finish_reason: "stop"` chunk with `usage`, then `data: [DONE]`) and returns `{ baseURL, requests, stop }`. `writeProviderConfig(testRoot, baseURL)` writes the `kete.json` above. |
| `packages/desktop/e2e/kete/fake-provider.test.ts` | new | AC1: the stream shape (`content-type: text/event-stream`, every `data:` line parses as the chunk fields the reader decodes, the last is `[DONE]`); a 404 on any other path; `writeProviderConfig` writes the expected JSON at `<root>/config/kete/kete.json` and nowhere else. |
| `packages/ai/src/protocols/openai-compatible-chat.ts` | read only | Shows which chunk fields the native reader decodes, so the fake's SSE matches it. |
| `packages/desktop/e2e/kete/electron.ts` | new | The e2e. Find and unpack the app (`findApp`, `unpackApp`). Create the temp root, `smokeEnv`, `writeServiceConfig(freePort())`, the onboarding file, the provider config and the project dir `<root>/project`. `_electron.launch({ executablePath, env, cwd: root })` and start the trace. Time `firstWindow()` and `appConnected`. Check the registration and the provider. Stub the dialog. Add the project, open a new session, choose `Fake` through the model control only if it isn't already shown, type "hello" and press Enter, then wait up to 90 s for `getByText(FAKE_ANSWER)`. Print the timings. On failure, save the trace and screenshot and print the logs with `redact`. Always call `stopAll`. Flags `--dir`, `--app`, `--channel`, `--keep`, as in the smoke. |
| `packages/desktop/package.json` | change (upstream, JSON) | Add `"@playwright/test": "catalog:"` to devDependencies, then run `bun install` at the root (this updates `bun.lock`; no new lockfile). |
| `bun.lock` | change (generated) | Updated by `bun install`. |
| `.github/workflows/kete-desktop.yml` | change | After "Smoke packaged app", add an "E2E packaged app" step with `if: github.event_name == 'workflow_dispatch'`, `timeout-minutes: 15`, env `KETE_E2E_RESULTS: ${{ runner.temp }}/kete-e2e` and `run: bun run --cwd packages/desktop e2e/kete/electron.ts`. Then an upload step with `if: failure() && github.event_name == 'workflow_dispatch'` for that folder, using the `actions/upload-artifact` SHA already pinned at `:79`. |
| `docs/desktop.md` | change | New "End-to-end test" section after "Smoke test": what it does, how to run it locally after `pack`, the same-channel note, the timings it prints, where results go, and that CI runs it only on manual dispatch. |
| `docs/upstream-patches.md` | change | Add the `desktop/package.json` `@playwright/test` row next to the existing `desktop/package.json` row (~line 1601). |

## Steps
1. **Spike first, and stop if it fails.** Edit package.json and run `bun install`. Then, in the scratch dir, write a
   throwaway Bun script of about 10 lines that `_electron.launch`es the packed macOS app and gets `firstWindow()`.
   If Playwright's Electron launch does not work under Bun, stop and hand back to the planner: the fallback (the
   Playwright runner under Node, with Node-compatible helpers) changes how the helpers are reused.
2. Refactor `script/kete-packaged-smoke.ts`: export `until`, extract `unpackApp` and `stopAll` with no behaviour
   change, and add the `stopAll` test. Run the smoke's test file.
3. Write `e2e/kete/fake-provider.ts` and its test, after reading the native reader. Run the test.
4. Write `e2e/kete/electron.ts` following the design decisions. Never print the service password: pass every log
   excerpt through `redact`.
5. Run it twice on macOS against a fresh pack (AC2). After each run, confirm no process is left.
6. Add the workflow step and the upload step, then update `docs/desktop.md` and `docs/upstream-patches.md`.
7. Run the full checks (AC4).

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/desktop`: `bun test ./e2e/kete/fake-provider.test.ts`, then `bun test ./script/kete-packaged-smoke.test.ts` |
| AC2 | Fresh build from the repo root: `OPENCODE_CHANNEL=dev bun run --cwd packages/cli build --single --skip-install --skip-web-ui && OPENCODE_CHANNEL=dev bun run --cwd packages/desktop build && OPENCODE_CHANNEL=dev bun run --cwd packages/desktop pack`. Then run `bun run --cwd packages/desktop e2e/kete/electron.ts` twice: each run prints the window, connected and answer timings and exits 0. After each run, `pgrep -fl "Kete Code Dev\|opencode-cli"` prints nothing. |
| AC3 | A maintainer pushes the branch and runs `gh workflow run kete-desktop.yml --repo kete-org/ketecode --ref <branch>`, then `gh run watch --repo kete-org/ketecode <id>`: "E2E packaged app" passes on macOS and Windows. On the PR run, `gh run view --repo kete-org/ketecode <id>` shows the step skipped. |
| AC4 | in `packages/desktop`: `bun run typecheck`, `bun run test`; at the root: `bun run lint`, `bun run --cwd packages/kete-tools upstream:check`; check that `docs/desktop.md` has the "End-to-end test" section |

## Cards to update after the build
- `desktop`: the e2e harness (files; how it isolates; the onboarding settings file; the dialog stub; the fake
  provider config; the cleanup order; why it is a Bun script and not the Playwright runner); the new smoke exports
  `until`, `unpackApp` and `stopAll`; Quick answers for the gaps in handoff.md.
- `kete-tools-ci`: the dispatch-only "E2E packaged app" step and its artifact upload.
- `config-kete` (or a Quick answer in `desktop`): an OpenAI-compatible custom provider in `kete.json` maps to the bundled native package, so nothing is downloaded.
