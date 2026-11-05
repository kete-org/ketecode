# Spec: WS0 Electron e2e harness

- Task: `docs/tasks/2026-11-05-ws0-electron-e2e` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, Phase A pre-approval: "continue building until Phase A is complete", recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
One end-to-end test drives the packaged desktop app the way a user does. It launches the app, starts a new Code
session, sends a prompt and sees the answer from a fake model provider. Later desktop work (Work mode, approvals,
library) gets a harness to add tests to. PR 0.4 of `docs/desktop-enhancement-plan.md`. To stay within the free
CI minutes, it runs on manual dispatch, not on every PR.

## Scope
Modules: `desktop`, `kete-tools-ci`.

- **Harness** (`packages/desktop/e2e/`, Kete-owned): Playwright `_electron.launch` with `executablePath` set to the
  packaged app from `pack` (macOS: the binary inside the unpacked `.app`; Windows: `Kete Code Dev.exe`), isolated
  exactly like the packaged smoke:
  - `OPENCODE_DESKTOP_TEST_ROOT` and the XDG directories in a temp root;
  - a free port in the CLI's service config;
  - first-launch onboarding skipped through the app's store key, or a fresh state that `hasExistingAppState`
    accepts;
  - the helpers from `script/kete-packaged-smoke.ts` reused, not copied.
- **Fake provider**: a `Bun.serve` OpenAI-compatible `/v1/chat/completions` that streams (SSE) a fixed answer, wired
  through a `kete.json` custom provider (`@ai-sdk/openai-compatible`, `baseURL` set to the fake server) in the test
  root's config, so no key and no network are used.
- **Test**: launch → the app connects → open a new session → choose the fake model if needed → send "hello" → the
  assistant message shows the fake answer. Records the time from launch to window and from launch to connected
  (the cold-start budget, reported only).
- **Cleanup**: the app and its runtime are stopped on success and on failure (the smoke's cleanup), traces and
  screenshots are kept on failure, and nothing is left running.
- **CI**: a step in `kete-desktop.yml` after the smoke that runs only on `workflow_dispatch`, on both jobs, and
  uploads the Playwright report on failure.
- **Dependency**: `@playwright/test` in `packages/desktop` devDependencies (catalog version 1.60.0, already used by
  `packages/app`). No new lockfile.
- Docs: `docs/desktop.md` "End-to-end test" (how to run it locally after `pack`).

## Out of scope
- Tests for sign-in, Work mode, approvals; running on every PR; Linux.

## Acceptance criteria
- [ ] AC1: Unit tests for the fake provider (SSE shape matches what `@ai-sdk/openai-compatible` reads; one chunk
  stream plus `[DONE]`) and the config writer.
- [ ] AC2: Local run on macOS against a freshly packed app passes, prints the timings, and leaves no process
  behind (run twice).
- [ ] AC3: The workflow's dispatch run passes the e2e step on macOS and Windows; PR runs skip it.
- [ ] AC4: desktop typecheck and test, lint, `upstream:check`; `docs/desktop.md` updated.

## Risks and constraints
- Electron + Playwright on Windows runners: allow a generous timeout and keep traces.
- The provider config must not leak into the user's real config: test root only.
- No secrets: the fake provider takes any key or none.
