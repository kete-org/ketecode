# Result: WS0 Electron e2e harness

## What changed
- `packages/desktop/e2e/kete/electron.ts` (new): a Bun script. It launches the packed app with Playwright `_electron`, isolated like the packaged smoke:
  - test root, XDG directories and a free port; onboarding skipped through `<testRoot>/desktop/opencode.settings`;
  - waits for the app to connect, then checks through `GET /api/config` that the runtime loaded the fake provider;
  - answers the native folder dialog in the main process, adds a project, and types "hello" in the home composer;
  - waits for the fake answer and prints window / connected / answer times;
  - stops the app and every runtime; on failure keeps `trace.zip` and `failure.png`.
- `packages/desktop/e2e/kete/fake-provider.ts` (new): an OpenAI-compatible `/v1/chat/completions` SSE server on 127.0.0.1 and the `kete.json` custom-provider writer. Tests: `fake-provider.test.ts`, `electron.test.ts`.
- `packages/desktop/script/kete-packaged-smoke.ts`: `until` exported; `unpackApp` and `stopAll` extracted from `main` (no behaviour change), plus a `stopAll` test.
- `.github/workflows/kete-desktop.yml`: "E2E packaged app" step on `workflow_dispatch` only, and a results upload on failure.
- `packages/desktop/package.json`: `@playwright/test` (catalog) devDependency; `bun.lock` updated by `bun install`. Recorded in `docs/upstream-patches.md`.
- `docs/desktop.md`: "End-to-end test".

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| Spike (plan step 1) | Playwright `_electron` under Bun launched the packed app (window 3.1 s), closed cleanly |
| desktop `bun test ./script ./e2e`, typecheck | 72 pass; clean |
| `bun run lint`, `upstream:check` | exit 0; pass |
| AC2 local, macOS arm64, fresh `OPENCODE_CHANNEL=dev` pack, two runs | window 2.1 / 2.3 s, connected 6.1 / 5.6 s, answer 0.3 / 0.2 s; no app or runtime process left |
| AC3 CI dispatch | see PR |
| Review | approve. Fixed: the exit promise is now made before `close()` (no 10 s wait). The provider check now walks the config entries instead of matching text (a model name contained the same string). |

Fixed after the implementer: the Kete home shows the composer for the added project, so `home-new-session` is clicked only if it is visible.

## Acceptance criteria
- [x] AC1: fake provider SSE and config writer tests; `declaresProvider` tests.
- [x] AC2: two local runs passed (above).
- [ ] AC3: dispatch run on macOS and Windows (PR).
- [x] AC4: checks above; `docs/desktop.md` updated.

## Cards updated
desktop (e2e, onboarding store, native picker, selectors, Bun-only helpers, custom-provider config), kete-tools-ci (dispatch step).

## Metrics
- Agents used: librarian ×2, planner, implementer (no shell), reviewer
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
