# Result: desktop shell redesign

## What changed
New (packages/app unless noted):
- `src/kete/shell-defaults.ts` (+ test) — `keteDefaultTabLayout()`: vertical sidebar in desktop/web, horizontal in editor hosts.
- `src/kete/sidebar/records.ts` (+ test) — recent sessions, project groups and counts, relative times, account label (organization/host only).
- `src/kete/sidebar/view.tsx`, `sidebar.tsx`, `account.tsx`, `sidebar.css` — `KeteSidebar` (nav, Sessions, Projects, account footer); 60 s ticking clock.
- `src/kete/home-action.ts` (+ test), `src/kete/home.tsx` — `/` opens the newest draft or a new one; `/?view=sessions` shows upstream's Home.
- `src/kete/agent-switch.tsx` — Build | Plan segmented view.
- `src/kete/shell.stories.tsx`, `component-tests/kete-shell.spec.ts` — story-based component tests.

Changed:
- Upstream, marked: `src/shell/titlebar/titlebar.tsx` (sidebar body → `KeteSidebar` in vertical layout, unindented wrap), `src/shell/routes/routes.tsx` (`/` → `KeteHome`), `src/settings/model.tsx` (default layout), `src/settings/model.test.ts` (expects the new default), `src/composer/composer.tsx` (switch above the composer), `src/new-session/view.tsx` (inside the existing kete block: home-controls wrapper, toggle under the card).
- Kete: `src/kete/{mode.ts, mode.test.ts, composer-controls.tsx, panel.tsx, panel.css, panel-layout.tsx, panel-layout.test.ts, panel-state.ts, tokens.css, tokens.test.ts}`; `packages/ui/src/theme/kete/{theme.ts, theme.test.ts}`.
- `docs/upstream-patches.md` — "Desktop shell redesign" section.

## Checks
The verifier has no shell; the main session ran every check.

| Check | Result |
|---|---|
| `bun run typecheck` app, ui, desktop | pass |
| `bun run test:unit` (app) | 1061 pass / 0 fail |
| `bun run test:components -- component-tests/kete-shell.spec.ts` | pass (Playwright chromium-headless-shell installed locally) |
| `component-tests/composer.spec.ts` | 28 fail / 7 pass — same 28 fail on a clean `origin/main` worktree; pre-existing, not this task |
| ui `bun test ./src/theme` | 16 pass |
| `bun run lint` | exit 0 |
| `upstream:check` | pass |
| `verify --base main` | 0 new failures (server 162, core 8805/27 = base, tui 1722/2 = base, cli 782) |
| Hard-coded color grep (sidebar, home, composer-controls) | none |
| Review | reviewer: 3 major + 3 minor → fixed (Plan in sessions via the switch, home-action tests, ticking clock, view.tsx indent); AC1/AC4 manual below. upstream-guard: approve |

## Acceptance criteria
- [x] AC1 — `shell-defaults.test.ts` + `settings/model.test.ts` (default vertical, editor hosts horizontal, saved value wins via `withFallback`); `kete-shell.spec.ts` collapse/expand; manual: Cmd+Shift+B in the desktop dev app toggles the sidebar open → closed → open.
- [x] AC2 — `records.test.ts` (newest first, limit, relative times); spec: eight newest + View more, current page mark moves on selection; desktop run shows "Just now"/"51 min ago"/"09:50".
- [x] AC3 — `records.test.ts` project grouping and counts; spec: full count, three newest per project.
- [ ] AC4 — label logic unit-tested (never key/key id); desktop shows organization + host. **Live update after sign-in not verified**: dev mode's isolated sidecar binds 0.0.0.0, so the account gate (correctly) refuses sign-out there. Needs a check in a packaged build.
- [~] AC5 — `home-action.test.ts` (reuse newest draft, new draft, `?view=sessions`, no server/project, not ready); `/` opens the composer-first home in the desktop run. Submitting a prompt from it was not exercised (the session's models are out of quota on this account).
- [x] AC6 — `mode.test.ts` (`switchTarget`, `agentSwitchVisible`, browser cycle without Plan); spec: Build/Plan switching incl. a session in Plan; desktop: switch on the home and in an existing session.
- [x] AC7 — tokens/theme tests; color grep clean; light + dark screenshots of the desktop app.
- [x] AC8 — `upstream:check` passes; six upstream files marked and recorded; upstream-guard approve.
- [x] AC9 — see Checks; desktop dev build shows the new shell.

Decisions: Plan lives only on the Build | Plan switch, which shows above the composer on the home and in sessions (desktop/web); the toolbar toggle keeps Default / Auto / Ask there. Footer shows organization + host; the bell opens Settings → Notifications.

Follow-ups (not this task): #82's gate 403 has no CORS headers, so the dev renderer shows a generic error instead of the local-only text; Settings → Account page has no heading/spacing; `composer.spec.ts` fails on main; VS Code screenshot for the theme tint not taken.

## Cards updated
web-app (shell map, `keteDefaultTabLayout`, titlebar swap seam, `KeteSidebar`, `KeteHome`/`homeAction` and `/?view=sessions`, `useKeteMode`/`KeteAgentSwitch`/`homeLayout()`, browser vs editor-host cycle; pitfalls: JSX can't mount under bun → Playwright story tests, pre-existing `composer.spec.ts` failures, `agentsVisible`/`useLocal().agent` fallback), ui-branding (new neutrals and tokens), account-login (dev sidecar binds 0.0.0.0, so the gate refuses sign-in/out in `bun run dev`). Earlier, before planning: web-app, ui-branding, account-login refreshed. `card-check.mjs`: 41 cards clean. Not recorded as separate answers: `withFallback` detail, account status has no plan field, no notifications centre.

## Metrics
- Agents used: scout, librarian ×3 (pre-plan refresh ×2, close), planner, implementer ×3 rounds (no shell), reviewer, upstream-guard; verifier not called (no shell; main session ran checks)
- Scout lookups: 1, docs enough: 0 (0%); planner also logged "Docs enough: no" gaps
- Tokens / cost (from /usage): n/a
- Time: n/a (spec through close on 2026-11-04)
