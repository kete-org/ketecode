# Plan: Desktop shell redesign

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task: upstream edits.** Three new upstream files get minimal marked edits
> (`shell/titlebar/titlebar.tsx`, `settings/model.tsx`, `shell/routes/routes.tsx`); one already-patched
> upstream file (`new-session/view.tsx`) changes only inside its existing `kete_change` block. No shared
> contract, config schema, server endpoint or security change. The user approves this plan before building.

## Cards read
- docs/context/modules/web-app.md (verified-at f380ab5898, stale: no)
- docs/context/modules/ui-branding.md (verified-at f380ab5898, stale: no)
- docs/context/modules/account-login.md (verified-at f380ab5898, stale: no)
- docs/context/pitfalls.md, docs/context/commands.md, CLAUDE.md §4/§9

## Design in one paragraph
Upstream's vertical sidebar (`aside#vertical-tabs-sidebar` in `shell.tsx`, body portalled from
`titlebar.tsx:810-896`) stays: its header row (traffic-light space, Home when there are no traffic
lights, `SidebarToggle`), collapse/peek, resize, `mod+shift+b` (`sidebar` command, `shell.tsx:151`) and
the plugin `vertical-tabs-footer` are untouched. Only the body (nav + tab strip, `titlebar.tsx:854-887`)
is swapped for `KeteSidebar` when `tabLayout === "vertical"` (inbox and horizontal keep upstream's). The
default `tabLayout` becomes `"vertical"` outside an editor host (VS Code/JetBrains webviews stay
`"horizontal"`; a saved value always wins via `withFallback`, `settings/model.tsx:459`). `/` becomes
`KeteHome`: it opens (or reuses) a new-session draft, exactly as the titlebar's `openNewTab` "home"
case does (`titlebar.tsx:390-412`), so the composer-first home *is* the new-session screen; `/?view=sessions`
renders upstream's `Home` (route type stays `"home"`, `shell/state/layout.tsx:64-91`, so no layout edit).
The greeting, centered layout, Build | Plan switch and under-card controls are gated on
`panelState().host === "browser"` (desktop + web), so the VS Code/JetBrains panel is unchanged.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/app/src/shell/titlebar/titlebar.tsx` | change (upstream, marked) | 1 import line; wrap `:854-887` in `<Show when={settings.appearance.tabLayout() !== "vertical"} fallback={<KeteSidebar newSession={openNewTab} />}>` … `</Show>` with `{/* kete_change start/end */}` on their own lines. **Do not re-indent the wrapped lines.** Read `:340-520` (`openNewTab`, `homeButton`, `searchButton`) and `:810-896` |
| `packages/app/src/settings/model.tsx` | change (upstream, marked) | `:312` `tabLayout: keteDefaultTabLayout()` + 1 import line, both `// kete_change` |
| `packages/app/src/shell/routes/routes.tsx` | change (upstream, marked) | `:53` `component={KeteHome}` + 1 import line, both `// kete_change` |
| `packages/app/src/new-session/view.tsx` | change (inside existing kete block `:109-146`) | add `<KeteAgentSwitch model={props.composer} />` above `data-slot="new-session-composer"`; wrap the `NewSessionLocation` `Show` and `<KeteModeToggle model={props.composer} placement="under" />` in `<div data-kete="home-controls">` |
| `packages/app/src/shell/shell.tsx` | read only | sidebar aside, `verticalTabs`, sidebar command, palette's session-open pattern (`:170-187`) |
| `packages/app/src/shell/tabs/tabs.tsx` | read only | `newDraft` `:267`, `addSessionTab` `:233`, `select`, `ready`, `store`, `draftHref` `:45` |
| `packages/app/src/home/model.ts` | read only | `createHomeController` (focused server, `project.list`, `newSessionProject`) |
| `packages/app/src/home/sessions/controller.tsx` | read only | how `homeSessionsQuery` + `mergeHomeSessionIndex` + `retainHomeSessions` + `buildHomeSessionRecords` are combined (`:55-91`); `HomeSessionStatusController` `:449` (busy = `loading`) |
| `packages/app/src/home/sessions/{queries,index,records}.ts` | read only | reused as-is |
| `packages/app/src/home/route.tsx` | read only | upstream `Home`, rendered by `KeteHome` for `?view=sessions` and when there is no server/project |
| `packages/app/src/settings/surface.tsx` | read only | `useSettingsSurface().open(tab)` `:176` (Settings, `"notifications"`, `"kete-account"`) |
| `packages/app/src/kete/account-prompt-state.ts` | read only | reuse `fetchStatus`, `fromEvent`, `settingsTab` |
| `packages/app/src/kete/account-prompt-card.tsx` | read only | pattern for the status resource + event listener |
| `packages/app/src/kete/ide-host.ts` | read only | `currentHost()` `:73` |
| `packages/app/src/kete/panel-state.ts` | change | add `homeLayout()` = `panelState().host === "browser"` |
| `packages/app/src/kete/mode.ts` | change | `next(mode, { plan })`: browser cycle Default → Auto → Ask → Default (Plan → Default); editor hosts keep the 4-way cycle |
| `packages/app/src/kete/mode.test.ts` | change | new cycle cases; existing 4-way case stays for `{ plan: true }` |
| `packages/app/src/kete/composer-controls.tsx` | change | extract the toggle's state/apply into `useKeteMode(model)` (returns `mode`, `set(target)`, `planAvailable`); `KeteModeToggle` gains `placement?: "toolbar" \| "under"` (toolbar instance renders nothing when `homeLayout()` and on a draft route); new `KeteAgentSwitch` (Build \| Plan segmented `role="radiogroup"`, hidden without the `plan` agent; Plan → `set("plan")`, Build → the last non-Plan mode, else `"default"`) |
| `packages/app/src/kete/panel.tsx` | change | `KeteEmptyState`: in `homeLayout()` render the greeting (`Brand.displayName` + "What should we build today?", `<h1>`) instead of the 84px hero; tips/notices/account prompt/local offer unchanged |
| `packages/app/src/kete/panel-layout.tsx` | change | `data-kete-layout="home"` on `panel-column` when `homeLayout()` |
| `packages/app/src/kete/panel-layout.test.ts` | change | keep structural assertions passing; add the `home-controls` / switch placement in `view.tsx` |
| `packages/app/src/kete/panel.css` | change | home layout (centered column, composer card radius 16px, larger spacing), `agent-switch`, `home-controls`; tokens only |
| `packages/app/src/kete/tokens.css` | change | new `--kete-*` tokens: softer neutral surfaces, `--kete-r-card: 16px`, shell type size, selection/primary accents; light + dark + high-contrast fallback |
| `packages/app/src/kete/tokens.test.ts` | read / extend | brand still equals theme value |
| `packages/ui/src/theme/kete/theme.ts` | change | softer neutral `v2-background-*` overrides in `accents`/a `neutrals` table (light + dark), AA contrast comment updated |
| `packages/ui/src/theme/kete/theme.test.ts` | change | assert the new overrides exist for both modes |
| `packages/app/src/kete/shell-defaults.ts` | new | `keteDefaultTabLayout(host = currentHost())` → `host ? "horizontal" : "vertical"` |
| `packages/app/src/kete/shell-defaults.test.ts` | new | AC1 default: no host → vertical; vscode/jetbrains → horizontal |
| `packages/app/src/kete/home.tsx` | new | `KeteHome`: `?view=sessions` → `<Home/>`; else when `tabs.ready()`: reuse the most recent draft tab (`tabs.select`) or `tabs.newDraft({ server, directory })` from `createHomeController().server.focused()` + `newSessionProject()`; no server/project → `<Home/>` (has "add project") |
| `packages/app/src/kete/sidebar/records.ts` | new | pure: `recentSessions(records, limit)`, `projectGroups(records, projects, perProject)` (with counts), `relativeTime(ms, now)` → "Just now" / "N min ago" / "HH:MM" (same day) / "Yesterday" / short date; `accountLabel(status)` → `{ kind: "signed-in", organization, host } \| { kind: "signed-out" } \| { kind: "offline" } \| undefined` (only `organization`/`platform` fields — never key/key id) |
| `packages/app/src/kete/sidebar/records.test.ts` | new | AC2/AC3/AC4 unit tests (fixed `now`, time zone–independent by building dates with local `Date` parts) |
| `packages/app/src/kete/sidebar/sidebar.tsx` | new | `KeteSidebar({ newSession })`: nav (Search → `command.trigger("sessions.search")`, New session → `props.newSession()`, Settings → `settings.open()`); Sessions (count, collapsible `aria-expanded`, first 8, busy via `HomeSessionStatusController`, current via `useCurrentRoute()` `aria-current="page"`, "View more" → `navigate("/?view=sessions")`); Projects (count, collapsible, ≤3 sessions each); open = `global.ensureServerCtx(conn).projects.touch(...)` + `tabs.select(tabs.addSessionTab({ server, sessionId }))` (as `shell.tsx:178-185`) |
| `packages/app/src/kete/sidebar/account.tsx` | new | `KeteSidebarAccount`: status via `fetchStatus(ctx.sdk.api, undefined)` on the focused server, refetch on `fromEvent`; signed in → organization + host; signed out → "Sign in" button → `settings.open(settingsTab)`; notifications icon button (`aria-label`) → `settings.open("notifications")` |
| `packages/app/src/kete/sidebar/sidebar.css` | new | tokens only (`var(--kete-*)` / `--v2-*`), visible `:focus-visible`, larger base type |
| `docs/upstream-patches.md` | change | new "Desktop shell redesign" section listing the three new upstream files + the `view.tsx` block change |

## Steps
1. `kete/shell-defaults.ts` + test; marked edit in `settings/model.tsx:312`. Run the shell-defaults test.
2. `kete/sidebar/records.ts` + `records.test.ts` (recent order newest first, limit + "more" flag, project grouping and counts, relative time buckets, account label never exposes anything but organization/host). Run it.
3. `kete/sidebar/sidebar.tsx`, `account.tsx`, `sidebar.css`. Data: one `useQuery(homeSessionsQuery(conn, ctx))` per focused server, merged exactly as `home/sessions/controller.tsx:55-91` with `projectDirectories: () => undefined` (all projects). No new polling.
4. Marked wrap in `titlebar.tsx` (`:854-887`), import `KeteSidebar` (`// kete_change`). The `vertical-tabs-footer` (plugin titlebar items) stays below it.
5. `kete/home.tsx`; marked edit in `routes.tsx:53`. Guard against loops: only act once per mount, after `tabs.ready()`.
6. `panel-state.ts` `homeLayout()`; `mode.ts` `next(mode, { plan })` + tests; `composer-controls.tsx` `useKeteMode`, `placement`, `KeteAgentSwitch`.
7. `panel.tsx` greeting, `panel-layout.tsx` attribute, `view.tsx` (inside the existing kete block only), `panel-layout.test.ts`.
8. Theme polish: `tokens.css`, `panel.css`, `packages/ui/src/theme/kete/theme.ts` + tests. No hex/rgb outside `tokens.css` and `theme.ts`.
9. Component tests (AC1 sidebar collapse, AC2 selection, AC5 submit): first try mounting with the `test:unit` preloads (`../ui/test/solid-jsx.ts` may have fixed the web-app card's "React is not defined" gotcha — record the result in `handoff.md`); if JSX still can't mount, use `createComponent()` or a Playwright component test under `packages/app/component-tests` (`bun run test:components`), and say which in `handoff.md`.
10. `docs/upstream-patches.md` entry; run every verification row; desktop dev build screenshots (light + dark) for the PR.

## Verification
Run inside `packages/app` unless noted. `T` = `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts`.

| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `T ./src/kete/shell-defaults.test.ts`; then the sidebar component test (step 9) |
| AC2 | `T ./src/kete/sidebar/records.test.ts`; then the selection component test |
| AC3 | `T ./src/kete/sidebar/records.test.ts` |
| AC4 | `T ./src/kete/sidebar/records.test.ts`; `T ./src/kete/account-prompt-state.test.ts` |
| AC5 | the step-9 home/submit test; `T ./src/kete/panel-layout.test.ts` (or `bun test ./src/kete/panel-layout.test.ts` as the card says) |
| AC6 | `T ./src/kete/mode.test.ts`; `T ./src/composer/editor/interaction.test.ts` |
| AC7 | `T ./src/kete/tokens.test.ts`; `bun test ./src/theme/kete/theme.test.ts` in `packages/ui`; `grep -rnE '#[0-9a-fA-F]{3,8}\b\|rgba?\(' packages/app/src/kete/sidebar packages/app/src/kete/home.tsx packages/app/src/kete/composer-controls.tsx` (repo root) returns nothing; screenshots |
| AC8 | `bun run --cwd packages/kete-tools upstream:check` (repo root) |
| AC9 | `bun run typecheck` in `packages/app`, `packages/ui`, `packages/desktop`; `bun run test:unit` in `packages/app`; root `bun run lint`; `bun run --cwd packages/kete-tools verify --base main`; manual `bun run dev` in `packages/desktop` with screenshots |

## Risks
- **Unindented wrap in `titlebar.tsx`.** Keeps the diff to 4 marked lines; a formatter run would re-indent ~35 upstream lines. Don't format the file.
- **Account event scope.** `Rpc.emit` publishes with the emitting location only (account-login card); the sidebar listens on the focused server's event stream without a location. Verify a sign-in updates the footer without reload (AC4); if not, pass the location of the most recent project (as the prompt card does) — note the result in `handoff.md`.
- **Existing users.** Anyone whose `settings.v3` already holds `tabLayout` keeps it; whether upstream's `persisted` writes defaults for users who never chose decides if they switch to vertical. Both satisfy AC1; mention it in the PR.
- **`/` redirect.** `home.toggle` and `DraftRoute`'s `<Navigate href="/" />` now land on a draft; the reuse-latest-draft rule keeps drafts from piling up.
- **Theme neutrals** in `packages/ui/src/theme/kete/theme.ts` also tint the VS Code/JetBrains webviews where their own mapped tokens don't override; check one VS Code screenshot.
- **Spec gaps:** `kete.account.status` has no plan field, so the footer shows organization + platform host; there is no notifications centre, so the bell opens Settings → Notifications. The Build | Plan switch is on the home only (session view out of scope); in a session the picker still shows Plan when the session is in it and its next step is Default.

## Cards to update after the build
- `web-app`: shell map (sidebar swap seam, `KeteSidebar`, `KeteHome`, `?view=sessions`), `useKeteMode`/`KeteAgentSwitch`, browser vs editor-host cycle, `homeLayout()`, test command and JSX-mount gotcha result; add paths.
- `ui-branding`: new tokens and theme neutrals.
- `account-login`: the sidebar footer as a second reader of `kete.account.status`.
- `docs/upstream-patches.md` (done in step 10).
