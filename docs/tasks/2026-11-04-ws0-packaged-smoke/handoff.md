# Handoff: WS0 packaged-app smoke

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-04 planner
- Done: read INDEX.md, spec.md, the desktop card; ran `node scripts/agent/stale-cards.mjs desktop kete-tools-ci server-sdk`.
- Blocked: **librarian must refresh these cards before planning.**
  - `desktop` STALE: 12 files changed since `437294ce2d` (desktop.ts, main/kete/sidecar-supervision.ts, sidecar-watcher{,.test,.integration.test}.ts, renderer/desktop-app.tsx, renderer/kete/sidecar-status-state{,.test}.ts, …), i.e. the #91 watcher work. The card's Changes section already mentions the watcher, so this may only need line-ref checks and a `verified-at` bump to `b84b58294d`.
  - `kete-tools-ci` STALE: 12 files since `3d489dad3d` (kete-build.yml, kete-release.yml, other workflows, .opencode-version, leak-allowlist.txt, …). The plan adds a step to `kete-desktop.yml` and may reuse `script/service-smoke.ts` (check-test.yml), so this card matters for the CI part.
  - `server-sdk`: not stale.
- For the refresh, please also add Quick answers for what this task needs: the packaged output names under `dist/desktop/` (from `electron-builder.config.ts`), where the packaged app stages its CLI (`desktop-cli.ts`), the client's Basic auth username for the service, and whether `script/service-smoke.ts` can be reused.
- No plan.md written yet. After the refresh, re-run `/task-plan`.

## 2026-11-04 planner (after the card refresh)
- Done: `stale-cards.mjs desktop kete-tools-ci server-sdk` → all current. Wrote `plan.md` (4 files changed/new, 11 read-only).
- Decisions: script at `packages/desktop/script/kete-packaged-smoke.ts` (card's `script/kete-*` convention, not `script/kete/`); app names from `KeteDesktop.productNames`; runtime killed with SIGKILL to simulate a crash; cleanup verifies every pid is gone and fails otherwise; userData isolated with the existing `OPENCODE_DESKTOP_TEST_ROOT`, not `--user-data-dir`.
- Docs enough: no — missing: `OPENCODE_DESKTOP_TEST_ROOT` isolates userData/sessionData (`main/lifecycle/configure.ts:47-52,66`).
- Docs enough: no — missing: on macOS/Linux the login-shell env replaces `process.env` and `XDG_STATE_HOME` is deleted unless the shell keeps it (`main/lifecycle/environment.ts:30-46`); a smoke must set `HOME` to its temp root.
- Docs enough: no — missing: the handshake wire shape (`{"input":{}}` → `{"output":…}`, `server/test/kete/handshake.test.ts:27-37`) and the import path `@opencode/schema/kete/handshake`.
- Docs enough: no — missing: desktop `typecheck` covers only `src/` (`tsconfig.json` include), so `script/` files are only checked by `bun test`.
## 2026-11-04 implementer
- Done: steps 1-6. NO SHELL available, so no check was run (tests, typecheck, lint, actionlint, AC2 all unrun).
- Files: packages/desktop/script/kete-packaged-smoke.ts (new), kete-packaged-smoke.test.ts (new), .github/workflows/kete-desktop.yml (step added, default --dir from script location), docs/desktop.md (Smoke test + Clean-install checklist).
- Decisions: `kete service stop` exists (cli commands.ts:526), used in the checklist. `findApp` also takes `app` and returns `{kind:"bundle"}` for a `.app` dir. Runtime pid is killed via the registration's pid.
- Risks to check on first run: decode errors from Schema could echo input (password) in the final "packaged smoke failed" message (only app output/logs go through redact); `Bun.serve` `server.stop` in tests; `Service.Info` import path.
- Cards not updated (librarian).
- Open: does the CLI offer a command to stop the background service for the checklist? Plan tells the implementer to fall back to Activity Monitor / Task Manager and not add one.
