# Handoff: Desktop shell redesign

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## Spec: scout lookup (main session)
- Docs enough: no — missing: (1) app shell map (shell.tsx, titlebar vertical-tabs Portal `titlebar.tsx:810-896`, `appearance.tabLayout` horizontal|vertical|inbox `settings/model.tsx:148,312`, sidebar-peek) for `web-app.md`; (2) GUI plugin slots + built-in registration, and "desktop loads `@opencode/app`" — no gui-plugins/desktop card exists; (3) composer agent/model/variant pickers (`composer/editor/editor.tsx:426-438`, `kete/composer-controls.tsx` KeteModeToggle) for `web-app.md`; (4) web-app card's test:unit command is stale (actual: `--preload ../ui/test/solid-jsx.ts --preload ./happydom.ts`).

## 2026-11-04 planner
- Done: `plan.md` written. Cards web-app, ui-branding, account-login all current (`stale-cards.mjs`).
- Decisions: sidebar body swap only for `tabLayout === "vertical"` (inbox keeps upstream); default `tabLayout` is `"vertical"` only outside an editor host; `/` = `KeteHome` (opens/reuses a draft), former home at `/?view=sessions` (route type stays `home`, no layout edit); greeting/switch/under-card controls gated on `panelState().host === "browser"` so VS Code/JetBrains are unchanged; Plan drops out of the picker cycle only in the browser host.
- Docs enough: no — missing: (1) sidebar body seam lines in `titlebar.tsx` (`:854-887` nav + tab strip; `vertical-tabs-footer` `:889` holds plugin titlebar items and must stay); (2) `openNewTab` "home" case (`titlebar.tsx:390-412`) as the draft-from-home recipe, and `tabs.newDraft`/`addSessionTab` (`shell/tabs/tabs.tsx:233,267`); (3) home session data pipeline (`home/sessions/controller.tsx:55-91`, `HomeSessionStatusController` `:449` for busy) and `createHomeController` (`home/model.ts:11`); (4) `currentRoute` throws on unknown paths (`shell/state/layout.tsx:91`), so new top-level routes need a layout edit — use a query param instead; (5) settings defaults use `withFallback` (`settings/model.tsx:459`, defaults `:312`); (6) `kete.account` Status has only `signedIn`/`organization`/`platform`/`offline`/`signingIn` (no plan); (7) no notifications centre exists (Settings has a `notifications` page, `settings/pages.ts:8`).
- Open questions: whether `rpc.kete.account.changed` reaches a location-less listener (implementer verifies, see plan Risks); whether JSX components now mount under `test:unit`'s `solid-jsx.ts` preload.

- Plan approved by the user (2026-11-04), including the deviations: footer shows organization + host; bell opens Settings → Notifications; Build | Plan on the home only.

## 2026-11-04 implementer (stopped at step 1: no shell tool)
- Blocker: this run has no Bash tool, so `check-summary.mjs` and every verification command in the plan cannot be run. Nothing below has been run or typechecked.
- Done (step 1, unverified): new `packages/app/src/kete/shell-defaults.ts` and `shell-defaults.test.ts`; marked edits in `packages/app/src/settings/model.tsx` (import line and `tabLayout: keteDefaultTabLayout() /* kete_change */` at the defaults, line ~313).
- Not started: steps 2-10.
- (Superseded by the entry below: the coordinator runs all checks; steps 2-10 were then written without running anything.)

## 2026-11-04 implementer, steps 2-10 (nothing run: no shell)
- Done: records.ts + test; sidebar.tsx, account.tsx, sidebar.css; marked wrap in titlebar.tsx; home.tsx + routes.tsx; panel-state `homeLayout()`; mode.ts `next(mode, {plan})` + tests; composer-controls (`useKeteMode`, `placement`, `KeteAgentSwitch`); panel.tsx greeting; panel-layout.tsx attribute; view.tsx (inside the Kete block); panel-layout/tokens tests; tokens.css, panel.css; ui theme neutrals + test; component tests; upstream-patches entry.
- Decisions:
  - Sidebar reuses `createHomeController` and the Home pipeline (`homeSessionsQuery`, merge, retain, `buildHomeSessionRecords`) but not `createHomeSessionsController`, which registers the `palette` command. Open = `home.project.openProjectSession` (same as Home's own helper: message sync, `addSessionTab`, `select`, `projects.touch`).
  - `KeteModeToggle` "under" instance renders only in `homeLayout()`; the "toolbar" instance hides on a draft in `homeLayout()`. Editor hosts are unchanged (toolbar toggle, 4-way cycle). In a session in the browser the toolbar toggle stays and cycles without Plan.
  - `KeteHome` shows upstream `Home` when `?view=sessions` or no project; otherwise reuses the newest draft of the focused server, else `tabs.newDraft`. Renders nothing while redirecting.
  - routes.tsx: the `Home` import line is replaced by the `KeteHome` import (Home was only used on that route).
  - titlebar.tsx marker lines are JSX comments `{/* kete_change start ... */}` / `end`; the wrapped lines are not re-indented.
  - Strings in the sidebar/switch are English literals (like the rest of `kete/`), no i18n keys.
- Test runtime finding (not run): `../ui/test/solid-jsx.ts` compiles JSX with `solid-js/h`, whose `jsx(type, props)` passes props as plain values. So JSX is NOT reactive in `test:unit`: first render and click handlers can be tested, live updates (collapse toggling, async account status) cannot. The new component tests (`sidebar/sidebar.test.ts`, `composer-controls.test.ts`) use `createComponent()` + `mock.module` for data sources and only assert first render and click effects. The main session must confirm they mount (also that `onClick` props attach under `h`, and that mocking `*.css` paths works).
- Not covered by unit tests, needs the manual desktop run or a Playwright component test: section collapse (AC1), selection highlight after a click (AC2 live), account footer states and Sign in button (AC4; the label logic itself is in records.test.ts), submit from the home (AC5). I did not write a Playwright test.
- Open risks to check in the desktop run: (1) account change event reaching the sidebar without a location (AC4); if the footer doesn't update after sign-in, listen with the most recent project's location as `account-prompt-card.tsx` does; (2) `typecheck` of the `Show`/`For` generics in sidebar.tsx, `findLast` on the tabs store, and `SidebarRecord` assignability of `HomeSessionRecord`; (3) upstream:check accepting JSX-comment markers and the trailing-comment `routes.tsx` line; (4) VS Code screenshot for the theme neutrals; (5) existing users with a saved `tabLayout` keep it.
- Not done: screenshots; card updates (librarian); the `docs/context` cards.

## 2026-11-04 implementer, fix round after verification (nothing run)
- JSX cannot be mounted under bun test (`jsx_... is not defined`): the web-app card gotcha stands. Replaced the mount tests:
  - `kete/sidebar/sidebar.test.ts` and `kete/composer-controls.test.ts` are now comment-only stubs (I cannot delete files). The coordinator should `rm` both.
  - Pure logic: `mode.ts` gained `switchTarget` (Build | Plan decision) and `agentSwitchVisible`, tested in `mode.test.ts`. Sidebar logic was already pure in `records.ts`.
  - Rendering: split into story-safe views. `kete/sidebar/view.tsx` (`KeteSidebarView`, plain data and callbacks; `sidebar.tsx` is now only the connector) and `kete/agent-switch.tsx` (`KeteAgentSwitchView`; `KeteAgentSwitch` in composer-controls.tsx connects it). Stories in `kete/shell.stories.tsx` (`app-kete-shell--sidebar`, `app-kete-shell--agent-switch`), spec `component-tests/kete-shell.spec.ts` (6 tests: list/total/View more, collapse via aria-expanded, current page and selection move, handlers, project count and cap, Build/Plan switch).
- Not covered by a story: the real account footer (needs app contexts; label logic is in records.test.ts), and the switch being hidden without a plan agent (`agentSwitchVisible` unit test). The story's footer slot is empty, so the notifications button label is not asserted.
- (Review round, below.)
- `settings/model.test.ts`: empty-document default now `tabLayout: "vertical"` with a `kete_change` comment; added to upstream-patches.

## Main session: verification and fixes
- Removed the two bun mount tests (JSX can't mount under bun here, `solid-js/h` runtime: `jsxs_… is not defined`, also with `--conditions=browser`); replaced by `component-tests/kete-shell.spec.ts` (6 Playwright story tests, pass) + pure `switchTarget`/`agentSwitchVisible` unit tests. Installed Playwright's chromium-headless-shell v1223 locally to run them.
- Bug found in the desktop run: the Build | Plan switch never showed. Upstream hides the composer's agent picker unless custom agents exist (`providers/models/selection.tsx:109` `agentsVisible`), so `model.view.agent` is undefined and `plan` looked unavailable. Fix in `kete/composer-controls.tsx`: `applyAgent` falls back to `useLocal().agent` (the same list the picker reads). Side effect: the existing mode toggle's Plan now also selects the plan agent when the picker is hidden (it was permission-mode only), matching kete/mode.ts's intent.
- Desktop dev screenshots (light + dark, CDP of the app window only): sidebar, account footer (organization + host), greeting, Build | Plan, composer card, project + permission under the card.

## 2026-11-04 implementer, review round (nothing run)
- Switch in sessions: `KeteAgentSwitch` moved from `new-session/view.tsx` into the shared `composer/composer.tsx` (one marked line above `ComposerEditor`, plus the import), so new sessions and existing sessions both show it (hidden for `readOnly`). `agentSwitchVisible` now takes `{ browser, planAvailable }`; tests updated. The toolbar toggle is unchanged (browser host: Default/Auto/Ask). `panel-layout.test.ts` now asserts the switch is in composer.tsx before `<ComposerEditor` and not in view.tsx. Added story `app-kete-shell--agent-switch-in-plan` (a session already in Plan) and a spec test. The real session composer is not mounted by any test; check it in the desktop run.
- `kete/home-action.ts` (pure `homeAction`) + `home-action.test.ts`; `home.tsx` acts on it (once per mount, as before).
- `sidebar.tsx`: `now` is a 60 s ticking signal cleared on cleanup.
- `new-session/view.tsx`: the `NewSessionLocation` lines are back at their original indentation; only the wrapper open/close lines and the toggle were added. The `KeteAgentSwitch` import and element there were removed.
- docs/upstream-patches.md: view.tsx row reworded, composer.tsx row added.
- Check: `composer/composer.tsx` marker is on the same line as the JSX expression (`{!props.readOnly && ...} {/* kete_change */}`); confirm upstream:check accepts it.

## Main session: review round re-verify
- Fixed `kete/home.tsx:41` type error: `homeAction` is now generic over the branded server key (`S extends string`).
- `useKeteMode` reads `useLocal()` through `optionalLocal()` (try/catch): composer stories and hosts without `LocalProvider` render the composer.
- `component-tests/composer.spec.ts`: 28 fail / 7 pass — **pre-existing**: the same 28 fail on a clean `origin/main` worktree (blank `#story-root`), and also with the switch line removed. Not this task.
- typecheck app ok; `test:unit` 1061/0; `kete-shell.spec.ts` passes; lint 0; upstream:check passed; `verify --base main` 0 new failures.
- AC1 manual: Cmd+Shift+B via CDP → sidebar `data-state` open → closed → open.
- Desktop: Build | Plan shows above an existing session's composer; opened session highlighted in Sessions and Projects; sections stay expanded after reload.
- AC4 NOT verifiable in `bun run dev`: dev sets `OPENCODE_DESKTOP_ISOLATED_SERVER=1`, which starts the sidecar with `--hostname 0.0.0.0` (`desktop/src/main/service/background-service.ts:68`), so the account gate correctly refuses logout (403). Packaged builds don't pass `--hostname` (CLI default 127.0.0.1). Follow-ups for #82: the gate's 403 has no CORS headers, so the dev renderer sees a CORS error and shows the generic "Something went wrong" instead of the local-only text; the Settings → Account page has no heading/spacing.
