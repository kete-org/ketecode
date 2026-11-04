---
module: web-app
paths: [packages/app/src/kete/panel.tsx, packages/app/src/kete/panel.css, packages/app/src/kete/panel-layout.tsx, packages/app/src/kete/panel-state.ts, packages/app/src/kete/mode.ts, packages/app/src/kete/composer-controls.tsx, packages/app/src/new-session/view.tsx, packages/app/src/composer/composer.tsx, packages/app/src/composer/editor/editor.tsx, packages/app/src/new-session/composer-adapter.ts, packages/app/src/kete/home.tsx, packages/app/src/kete/home-action.ts, packages/app/src/kete/shell-defaults.ts, packages/app/src/kete/agent-switch.tsx, packages/app/src/kete/sidebar/**, packages/app/src/shell/titlebar/titlebar.tsx, packages/app/src/shell/routes/routes.tsx, packages/app/src/settings/model.tsx, packages/app/component-tests/kete-shell.spec.ts]
verified-at: 94eab8d8fd
---

## Quick answers
- How does `checkServerHealth` work and how is it tested? `health.ts:99-145`: `attempt` calls `server.info`, then the handshake, retrying on errors; `health.test.ts` fakes every path with a `reply` helper that also answers the handshake path, so a new probe request must be added there. The e2e mock's `rpcCall` refuses unknown RPCs, and answers `kete.handshake.get` (`e2e/utils/mock-server.ts:1136`) or every scenario shows the incompatible panel.
- Where can an app-wide panel mount, and is `ServerUnavailablePanel` story-safe? Inside `<main>` at `shell/shell.tsx:303-311`, around `PluginServerCover`'s children; route types are `LayoutRoute` (`shell/state/layout.tsx:55`). Stories alias `@/runtime/server/current` to a mock without `conn`/`health` (`packages/stories/vite.config.ts:61`), so the panel itself is not story-safe; the gate has a pure `incompatible-gate-view.tsx` and an `IncompatibleGate` story (`kete/shell.stories.tsx`).
- How is user-facing copy rebranded? Through `app/src/kete/brand-text.ts` (`overrides` at `:21` for whole strings, e.g. `session.error.incompatible.description`), not by editing locale files; it applies to all locales.
- Where does the app render `ServerUnavailablePanel` and how is `incompatible` set? The panel (`session/server-unavailable-panel.tsx:8`, `reason: "incompatible" | "unreachable"`) renders in `session/route.tsx:151` (incompatible, when `server.health?.incompatible` at `:148`) and `:164` (unreachable, `:143`), `session/route-error.tsx:31` (incompatible) and `new-session/route.tsx:61` (incompatible, guard `:57`). `incompatible` is a field of `ServerHealth` (`runtime/server/health.ts:14`); `checkServerHealth` (`health.ts:99`) sets it: after `server.info` answers it calls `KeteHandshake.check` (`app/src/kete/handshake.ts:15`, the `kete.handshake` RPC; protocol mismatch, undecodable reply, or `rpc.unavailable`/`rpc.method_not_found` give `"incompatible"`; other errors rethrow into the retry path), and a non-compatible result returns `{ healthy: false, incompatible: true }` (`health.ts:131-139`); the contributed-server stage mapping still sets it too (stage `"incompatible"`). The app-wide gate is `KeteIncompatibleGate` (`app/src/kete/incompatible-gate.tsx:11`) mounted in `shell/shell.tsx:305` inside `<main>` around `PluginServerCover`; `coveredServer` (`incompatible-gate-state.ts:6,12`) skips session, draft and settings routes (session/draft keep their own panel; Settings stays reachable). Also read at `home/projects/view.tsx:380`, `runtime/plugin/host-apis.tsx:545`, `runtime/plugin/mounted-session.ts:86`.
- Where is the app shell and how do tab layouts work? `app/src/shell/shell.tsx` mounts `Titlebar` (`shell/titlebar/titlebar.tsx:68`), the sidebar and the peek (`shell/sidebar-peek.ts`). `appearance.tabLayout` is `horizontal | vertical | inbox` (`settings/model.tsx:149`); anything but horizontal (and not mobile) turns on `verticalTabs` (`shell.tsx:62`), and the titlebar then renders the sidebar body through a `Portal`. The default is `keteDefaultTabLayout()` (`kete/shell-defaults.ts:4`, `settings/model.tsx:313`): `vertical` outside an editor host, `horizontal` inside VS Code/JetBrains; defaults go through `withFallback` (`settings/model.tsx:460`), so a saved value wins.
- Where is the Kete sidebar and what is the swap seam? `titlebar.tsx:855-897`: a marked `<Show when={tabLayout() !== "vertical"} fallback={<KeteSidebar newSession={openNewTab} />}>` wraps upstream's nav buttons + tab strip (unindented on purpose, `inbox` keeps upstream's body); the `vertical-tabs-footer` slot (plugin titlebar items) stays outside the wrap. `KeteSidebar` (`kete/sidebar/sidebar.tsx:29`) is the connector (Sessions 8 newest `SESSIONS_SHOWN`, Projects 3 per project `PER_PROJECT`, 60 s ticking clock); it reuses `createHomeController` (`home/model.ts:11`) and the Home pipeline (`homeSessionsQuery`, `home/sessions/controller.tsx:59`) but not `createHomeSessionsController` (it registers the palette command). Pure logic is `sidebar/records.ts` (`recentSessions`, `projectGroups`, `relativeTime`, `accountLabel`); markup is `sidebar/view.tsx` (`KeteSidebarView`, plain props so a story can render it); footer is `sidebar/account.tsx` (organization + host only, bell opens Settings > Notifications `:58`); styles `sidebar/sidebar.css`.
- What does `/` show now, and where is the old Home? `KeteHome` (`kete/home.tsx:15`, routed at `shell/routes/routes.tsx:53`) acts once per mount on `homeAction` (`kete/home-action.ts:13`): reuse the newest draft tab of the focused server (`tabs.select`), else `tabs.newDraft` (`shell/tabs/tabs.tsx:267`; `openNewTab`'s "home" case in `titlebar.tsx:347` is the model), else upstream's `Home` when `?view=sessions` (the sidebar's "View more") or there is no server/project. The route type stays `home`: `currentRoute` throws on unknown paths (`shell/state/layout.tsx:64`), so a new top-level route needs a layout edit; use a query param. Session adding is `tabs.addSessionTab` (`tabs.tsx:233`), busy status comes from `HomeSessionStatusController` (`home/sessions/controller.tsx:449`).
- How do the Build | Plan switch, `useKeteMode` and the browser-vs-editor cycle work? `useKeteMode(model)` (`kete/composer-controls.tsx:61`) holds mode/set/planAvailable for both `KeteModeToggle` (`:125`, `placement` `"toolbar"` or `"under"` the card) and `KeteAgentSwitch` (`:164`, connects the pure `KeteAgentSwitchView`, `kete/agent-switch.tsx:7`). The switch is mounted once in the shared `composer/composer.tsx:60` (so new sessions and existing ones; hidden when `readOnly`). `homeLayout()` (`kete/panel-state.ts:66`, true when `panelState().host === "browser"`) gates everything desktop-only: greeting, the switch, the "under" toggle, `data-kete-layout="home"` in `panel-layout.tsx:14`. Cycle: `next(mode, {plan})` (`mode.ts:28`) is Default > Auto > Ask > Plan in editor hosts; in the browser Plan is dropped from the cycle (`composer-controls.tsx:139`) and lives on the switch (`switchTarget`, `mode.ts:43`, remembers the mode Plan left; `agentSwitchVisible` `:35`). Editor hosts are unchanged.
- Why did the Build | Plan switch not show, and how are agents read? Upstream hides the composer's agent picker unless custom agents exist (`providers/models/selection.tsx:109` `agentsVisible`), so `model.view.agent` is undefined. `useKeteMode`'s `applyAgent` falls back to `useLocal().agent` (`composer-controls.tsx:81-103`); `useLocal` throws outside `LocalProvider`, so it is read through `optionalLocal()` (`:117`). Side effect: Plan in the toolbar toggle also selects the plan agent when the picker is hidden.
- Can I mount a JSX component in a bun test in `packages/app`? No: `solid-js/h` runtime gives `jsxs_… is not defined`, also with `--conditions=browser`. Use story-based Playwright component tests: a `*.stories.tsx` (`kete/shell.stories.tsx`) plus `component-tests/*.spec.ts` (`kete-shell.spec.ts`), run with `bun run test:components -- component-tests/kete-shell.spec.ts` (`package.json:29`); install the browser once with `node_modules/.bin/playwright install chromium-headless-shell`. Keep components story-safe by splitting a plain-props view from the connector (`KeteSidebarView`/`KeteSidebar`).
- Is `component-tests/composer.spec.ts` green? No: 28 failures (blank `#story-root`) on main as of 2026-11-04, pre-existing and not caused by Kete edits.
- How do GUI plugin slots and built-ins work, and how does desktop get the app? Built-in GUI plugins live in `packages/gui-plugins/src/main.ts` (`compose({...})`, ids stay reserved; Kete adds `"kete-account"` with a `kete_change` marker) and `renderer.ts` (renderer entries); the app imports them in `app/src/runtime/plugin/builtins.ts:1` and checks ids in `extension-plugins.tsx:61`. Plugins register contributions (commands, panels, `SettingsPage`, servers, links) through the types in `packages/plugin/src/gui/registries.ts`. Kete-owned plugin code goes in `gui-plugins/src/kete/` (`contract.ts` for host events such as `kete:open-diff`). Desktop (`packages/desktop`) depends on `@opencode/app` (`desktop/package.json:35`) and mounts it from `renderer/desktop-app.tsx` via `@opencode/app/desktop`; it has no UI of its own. No separate gui-plugins card exists; see `account-login`.
- Where are the composer agent, model and variant pickers and the Kete mode toggle? Agent picker `ComposerEditorConfiguredSelect` (keybind Mod+.) at `composer/editor/editor.tsx:426-433`, then `props.modelControl` and the variant select (`:435-438`); Kete adds `KeteCommandsButton` (start) and `KeteModeToggle` (end, `kete/composer-controls.tsx:125`) through the `kete` slot passed at `composer/composer.tsx:72`, and the Build | Plan switch above the card (`:60`).
- Where are Settings, onboarding and the connect dialog's key method, and how does the app consume `DeepLinksOpened`? Settings: root tabs in `app/src/settings/pages.ts` (`general`, `providers`, `models`, `servers`, ...), routes `settings/route.ts`, opened by the `settings.open` command (`settings/command.tsx:6`, `mod+comma`) through `useSettingsSurface` (`settings/surface.tsx:33`, used by `shell/shell.tsx:40`). Onboarding is desktop-only: `DesktopFirstLaunchOnboarding` (`desktop/src/renderer/onboarding/index.tsx:5`, mounted at `desktop-app.tsx:118`) opens a first draft in the sidecar server; the app has none. Connect dialog: `app/src/providers/connect/dialog.tsx`, `ApiAuthView` (`:1278`, shown for `currentMethod().type === "key"` at `:1913`, submits `controller.auth.connectKey` `:1307`, `connect/controller.ts:556`); a server that cannot describe an integration still gets a key method (`controller.ts:117`), and key methods sort last (`:37-41`). `DeepLinksOpened` is an Electron IPC event (`desktop/src/shared/ipc-rpc/events.ts:6`) emitted by `main/lifecycle/index.ts:70` (routed to the window named in a `kete://console/authorized?window=` URL, else the last focused one; `lifecycle/deep-link.ts`); the renderer (`renderer/api.ts:57`, `startup/deep-links.ts`) appends the URLs to `window.__OPENCODE__.deepLinks` and dispatches a `opencode:deep-link` window event. Nothing in `packages/app` or `packages/ui` listens for either today, so the app does not consume deep links yet (checked by grep on 2026-11-04).
- Where is the session task list (todo) in the web app? `KeteTodoDock` (`app/src/kete/todo-dock.tsx:14`) renders above the composer (`composer/composer.tsx:59`, `kete_change`): the agent's `todowrite` list with a progress count, read via the `kete.todo` RPC and kept current from the `rpc.kete.todo.updated` event; hidden when empty or on the new-session screen. Styled by `panel.css`'s `data-kete="todo-*"` rules.
- Where are the Offline indicator, the first-run local models offer and the no-tools notice? `KeteOfflineIndicator` in the panel header and `KeteLocalOffer` in the empty state (`app/src/kete/panel.tsx:33,43`); the once-per-session no-tools notice via `useKeteNoToolsNotice` in `composer-controls.tsx:51` (the `KeteModeToggle` file). All in `app/src/kete/local-ui.tsx`; see the `local-models` card.

- What is the "Kete panel"? The redesigned empty state + composer of the web app's new-session/
  session view: a header (mark + wordmark), an 84px hero with a one-time weave-in animation, an
  optional tip and "what's new" notices, a dismissible CLI hint, and two composer-toolbar additions
  (a commands button, a Default/Auto/Ask/Plan permission-mode toggle). `docs/tasks/2026-09-29-chat-panel-design/`
  is the task that built it; `spec.md` there is the source of truth for exact visuals, not this card.
- Where does the empty state/composer live upstream, and what's the seam? `new-session/view.tsx`
  `NewSessionView` has no slot — Kete's header/empty-state/CLI-hint replace `<NewSessionWordmark/>`
  and add two layout attributes (`data-kete="panel-stack"`/`"panel-footer"`) at `view.tsx:108-146`
  (`kete_change`, ~5 marked lines). The composer toolbar has no extension point either —
  `composer/editor/editor.tsx:85` adds an optional `kete?: { start?, end? }` prop rendered before/after
  the `+` menu and submit button (`:410`, `:479`); `composer/composer.tsx:15-17,72` passes
  `KeteCommandsButton`/`KeteModeToggle` into it. Don't restructure or reformat the rest of either
  upstream file — CSS overrides key only on `data-component`/`data-action`/`data-slot`/`data-kete`
  attributes, never on upstream's own classes (they can rename on sync).
- How does a **new** session start in Ask (not race a first prompt against a PATCH)? The toggle
  (unauthenticated, no session yet) stores the chosen mode in `mode.ts`'s `KeteModeDraft` map, keyed
  by the new-session draft's ID; `new-session/composer-adapter.ts:106` passes
  `KeteModeDraft.metadata(draftID)` (undefined when nothing was chosen, so nothing changes for other users; Plan included since it's a mode)
  into `data.session.create({ …, metadata })`, then clears the draft (`:99`). That call goes through
  `packages/client/src/solid/data.ts`'s hand-written reactive wrapper, not the generated SDK directly
  — see the `server-sdk` card for why that needed its own small upstream edit.
- How does the toggle change mode on an **existing** session? `mode.ts`'s `apply()`: for every mode,
  GET the session, merge `kete.permissionMode` into its metadata, PATCH (metadata is replaced whole
  server-side — the same pattern the VS Code extension's title-bar toggle uses); then
  `selectAgent()`: Plan also selects the `plan` agent when it's offered, remembering the agent it
  replaced per session so leaving Plan restores it (or the first non-Plan agent offered). The mode is
  written first so Plan's read-only rule is in force before the agent changes. Labels and tooltips
  come from `util/src/kete/permission-mode.ts` (`permissions` card; user guide `docs/permissions.md`).
- Why is `ApplyAgent.current`/`select` typed as plain `string`, not `string | undefined`? The real
  `view.agent` (`composer/model.ts:347-363`) always has a current agent and its `onSelect` only takes
  a `string` — there's no "no agent" state to select back into. A single-agent composer (no switcher)
  never offers Plan (`planAvailable` is false), so the "restore *a* sensible agent" fallback path is
  never actually exercised in that case.
- Does the browser (not VS Code) show the tip, CLI hint, or notices? No, by design (D4,
  `panel-state.ts:70-73`, `tipVisible`) — Alt+K is an editor keybinding, the CLI hint doesn't make
  sense from a browser already served by the CLI, and there's no notice source yet for the browser.
  `panel-state.ts`'s default `PanelState` (`host: "browser"`) has empty notices, no CLI hint, no tip;
  only `vscode-host.tsx`'s `kete.panel` listener sets `host` (`"vscode"` or `"jetbrains"`, from
  `ide-host.ts`'s `currentHost()`) and fills the rest in; `tipVisible` is true in either editor host — see
  the `vscode-extension` and `jetbrains-plugin` cards for that side of the bridge.
- Why does notice/CLI-hint text render through `segments()` instead of `innerHTML`? Extension-sourced
  (eventually server-sourced) text must never become markup. `panel-state.ts`'s `segments()` splits on
  backtick pairs into text/code spans; an odd backtick count (ambiguous) renders the whole string as
  plain text rather than guessing. `panel.tsx`'s `Segments` component renders `code` spans as
  `<code>`, everything else as a text node.
- Is `panel.css`'s "hero scrolls above a pinned footer" layout a strict flex split? **Yes, as of the
  follow-up fix commit `fix(app): chat panel layout — logo, notices below it, composer pinned`** —
  the earlier approximation no longer applies. `new-session/view.tsx` now renders a dedicated
  `KeteNewSessionLayout` component (`panel-layout.tsx`) instead of nesting the footer inside the
  hero's own wrapper: `[data-kete="panel-column"]` (max 680px, centered) contains
  `[data-kete="panel-scroll"]` (the hero mark, tip, notices, CLI hint — genuinely independently
  scrollable) and `[data-kete="panel-footer"]` (composer, project/workspace row) as true siblings, a
  real flex-column split. (Superseded approximation, for history: the upstream DOM used to nest the
  footer *inside* the hero's own wrapper, so `panel.css` made that one wrapper
  (`[data-kete="panel-stack"] > div`) a flex column instead — it didn't independently scroll behind
  a truly pinned footer for very tall content; this is what the fix commit replaced.) `NewSessionTips`
  (the old absolute `bottom-4` popup) no longer renders on this screen at all — with the footer truly
  pinned rather than approximated, it would sit on top of the composer; its definition is kept,
  unused, as a cleanup candidate (same as `new-session/wordmark.tsx`).
- Are the weave-in animation's timing values (320ms fade, 45ms stagger, ~670ms total) from a design
  reference? No — no source mockup specified them (`docs/design/kete-code-panel.html`, v4, has no
  matching keyframes; an earlier plan draft's citation of an older mockup file was wrong — see the
  `ui-branding` card's Gotchas). They're a judgement call on the existing
  `cubic-bezier(.2,.8,.2,1)` ease used elsewhere in the mockups, flagged for a visual check.
- How does the web app expose agent/effort/model selection generally (not just the mode toggle)?
  `composer/model.ts:347-363`'s `view.agent` (`options()`/`current()`/`onSelect()`) and `view.variant`
  are the composer's own agent and effort selectors, typed in `composer/adapter.ts:9-16`'s
  `ComposerControls`; the model control is `composer.tsx:90`'s `ComposerModelControl` popover
  (`data-action="composer-model"`). `mode.ts`'s `ApplyAgent` wraps `view.agent` for the toggle; it
  doesn't touch `view.variant` or the model control at all.
- Is `new-session/wordmark.tsx` (the shimmer wrapper) still used? No — `KeteEmptyState` replaced its
  only call site in `view.tsx`. It's dead code, deliberately left in place (not in the approved plan's
  file list) rather than deleted in this task; a cleanup candidate.

- Where is the sign-in prompt in the web app? `KeteAccountPrompt` (`app/src/kete/account-prompt-card.tsx`) is mounted in the panel empty state (`panel.tsx:25,45`), styled with the local-offer rules in `panel.css`; data and RPC decoding in `account-prompt-state.ts`. It only opens Settings > Account (a GUI plugin page, see `account-login`); "Not now" is not persisted.

## Purpose

The web app's Kete-branded chat panel: the empty state and header shown before a session has
messages, two composer-toolbar additions, and the client-side wiring that lets a user set a session's
permission mode (`kete.permissionMode`) from the composer instead of only from the VS Code
extension's title bar. Reuses `ui-branding`'s mark/wordmark/tokens; the `vscode-extension` card covers
the bridge messages this reads; the `permissions` card covers what `kete.permissionMode` does at
evaluation time.

## Entry points

- `packages/app/src/new-session/view.tsx:62-69` — `<KetePanelHeader/>`, `<KeteNewSessionLayout/>`
  (`panel-layout.tsx`) wrapping `<KeteEmptyState/>` (replacing `<NewSessionWordmark/>`) and
  `<KeteCliHint/>` as scroll-area children, with the composer/project row as its `footer` prop
  (`kete_change`).
- `packages/app/src/composer/composer.tsx:15-17,58-59,71` — imports and renders `<KeteGlobalFormDock/>` and `<KeteTodoDock/>` above the editor (`:58-59`) and passes `kete={{ start, end }}` into `ComposerEditor` (`:71`) (`kete_change`).
- `packages/app/src/composer/editor/editor.tsx:85,410,479` — the `kete` slot itself (`kete_change`).
- `packages/app/src/new-session/composer-adapter.ts:106,108` — `KeteModeDraft.metadata(draftID)` on
  `session.create`, cleared after (`kete_change`).

## Key files

| File | Lines | Role |
| --- | --- | --- |
| `packages/app/src/kete/panel.tsx` | 117 | `KetePanelHeader`, `KeteEmptyState`, `KeteCliHint`; renders notice/hint text via `segments()`, never `innerHTML`; every icon button has an `aria-label` |
| `packages/app/src/kete/panel.css` | ~523 | Header/empty-state/CLI-hint/notice styling, the weave-in keyframes, composer border/ring/send-button overrides on `[data-component="composer"]`, the 300px/379px responsive rules, `prefers-reduced-motion` disabling the weave, the `panel-column`/`panel-scroll`/`panel-footer` layout split (below), and the task-list dock's `[data-kete="todo-*"]` styles (`:387` on) |
| `packages/app/src/kete/panel-layout.tsx` | 19 | `KeteNewSessionLayout({children, footer})` — the scroll-area-above-pinned-footer wrapper `new-session/view.tsx` renders in place of nesting the footer inside the hero's own wrapper; no `vscode` import, styled entirely by `panel.css`'s `data-kete` attributes |
| `packages/app/src/kete/panel-state.ts` | 87 | `PanelState` signal (`host`, `platform`, `notices`, `cliHint`, `defaultMode`), `tipKeys()`, `segments()`, `tipVisible()`, `homeLayout()`, `updatePanelState()`, local optimistic `dismiss*Locally()` |
| `packages/app/src/kete/mode.ts` | 138 | `derive`/`next`/`withMode` (pure), `KeteModeDraft` (new-session mode staging), `apply()` (GET-merge-PATCH metadata, or select the `plan` agent), `ApplyAgent`/`ModeSDK` types |
| `packages/app/src/kete/composer-controls.tsx` | 179 | `KeteCommandsButton` (opens `/` commands), `useKeteMode`, `KeteAgentSwitch`, `KeteModeToggle` (cycles `mode.ts`'s state, resolves the session ID from the route or the new-session draft ID from `?draftId=`) |

## Data flow

**Empty state / notices / CLI hint:** `panel-state.ts`'s module-level `panelState` signal starts with
browser defaults → in an editor host (VS Code or JetBrains), `vscode-host.tsx`'s message listener calls
`updatePanelState({host: currentHost(), ...panelMessage(data)})` on every `kete.panel` message →
`panel.tsx` reads `panelState()` reactively. Dismissing a notice/hint calls both a local optimistic
hide (`dismiss*Locally()`, so the UI updates immediately) and, when embedded, posts
`kete.dismissNotice`/`kete.dismissCliHint` to the editor (`vscode-host.tsx`'s exported
`dismissNotice`/`dismissCliHint`) — the extension's next `kete.panel` broadcast is authoritative.

**Permission mode toggle:** `composer-controls.tsx`'s `KeteModeToggle` derives its displayed state
from `mode.ts`'s `derive({agent: view.agent?.current(), metadata: session?.metadata})`, reading the
session's cached metadata via `useData()` (a draft shows the mode chosen for it). Clicking cycles with
`next()` (Default → Auto → Ask → Plan; Plan is offered even without the `plan` agent, as a mode) then:
existing session → `mode.apply({sdk, sessionID, mode, agent})`; no session yet (new-session route) →
the mode is staged in `KeteModeDraft` for `composer-adapter.ts`'s `session.create` call, and Plan's
agent choice applies to the draft's selection right away.

## Data and APIs used

- `@opencode/client/promise`'s `SessionMetadata` type (`mode.ts:7`).
- `sdk.api.session.get`/`session.update` (via `useServer().ctx.sdk.api`, `mode.ts`'s `ModeSDK`
  structural type) for the GET-merge-PATCH on an existing session.
- `data.session.create({..., metadata})` (via `useData()`/`packages/client/src/solid/data.ts`) for a
  new session's atomic mode — see the `server-sdk` card for the wrapper's own `kete_change`.
- `composer/model.ts`'s `view.agent` (`options()`/`current()`/`onSelect()`) as the agent switcher
  `mode.ts`'s `ApplyAgent` wraps.
- Reuses `ui-branding`'s `KeteMark`/`KeteWordmark`/`tokens.css` and `Brand` (`@opencode/util/kete/brand`).
- VS Code bridge: `kete.panel` (in), `kete.dismissNotice`/`kete.dismissCliHint` (out) — validated by
  `vscode-messages.ts`, detailed in the `vscode-extension` card.

## Rules that must not break

- The toggle only ever writes `"default"`/`"ask"` via `withMode()`, which spreads `...metadata` first
  so it never drops other metadata keys, and never writes `permissions` directly (CLAUDE.md §9,
  `permissions` card's "only ever tighten" invariant applies to how the runtime *uses* this value, not
  this card, but this card must not defeat it by writing something the runtime doesn't expect).
- Notice/CLI-hint text renders only through `segments()` → text nodes / `<code>`, never `innerHTML` —
  extension-sourced text is not trusted as markup (`panel.tsx`, `panel-state.ts`).
- No remote URLs anywhere in this feature (icons are `@opencode/ui/icon` names or inlined SVG paths,
  fonts come from `assets/brand/` — `ui-branding` card); `prefers-reduced-motion` must disable the
  weave-in (`panel.css`).
- The four `packages/app` upstream edits and `packages/client/src/solid/data.ts` must keep their
  `kete_change` markers — `view.tsx` and `editor.tsx` are files upstream changes often; keeping edits
  to the marked lines limits sync conflicts to those lines (docs/upstream-patches.md "Chat panel
  design").
- `mode.ts`'s `apply()` always GETs the session before merging — metadata is replaced whole
  server-side, so a blind PATCH would drop concurrently-set keys (same constraint as the extension's
  own toggle, `permissions` card).

## Testing

- `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/kete/mode.test.ts` — cycle order, Plan
  skipped when unavailable, `derive()` from agent/metadata, metadata merge keeps other keys.
- `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/kete/panel-state.test.ts` — tip keys per
  platform, backtick segmentation including unbalanced/HTML-looking input.
- `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/kete/vscode-messages.test.ts` — valid/
  invalid `kete.panel` payloads.
- `bun test ./src/kete/panel-layout.test.ts` (plain `bun test`, no `--conditions=solid`/happydom) —
  structural, source-text assertions (same technique as `kete-vscode/test/brand.test.ts`'s
  `markRects()`): `panel-scroll` (children) comes before `panel-footer` (footer) inside
  `panel-column`, each slot renders the right prop, and `view.tsx`'s actual usage puts the empty
  state before the CLI hint in the scroll slot and the composer in the footer slot. Not a mounted
  Solid tree — see Gotchas.
- Desktop shell: `kete/shell-defaults.test.ts`, `home-action.test.ts`, `sidebar/records.test.ts`, `mode.test.ts` (`switchTarget`, `agentSwitchVisible`) under `bun run test:unit`; rendering via `bun run test:components -- component-tests/kete-shell.spec.ts` (see Quick answers).
- `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/composer/editor/interaction.test.ts` —
  upstream Enter/Shift+Enter/send-disabled behavior is unchanged by the `kete` slot.
- `bun test ./test/kete/session-create-metadata.test.ts` inside `packages/client` — the atomic-mode
  path (`server-sdk` card).
- Package-wide: `packages/app`'s `bun run typecheck`, `bun run test:unit`; root `bun run lint`;
  `bun run --cwd packages/kete-tools upstream:check` (every `kete_change` line, including plain
  attribute additions like `data-kete="panel-stack"`, needs its own marker or a
  `{/* kete_change */}` comment line above it — a plain-attribute addition without one fails the
  checker).
- Not verified by any automated test as of `verified-at` (manual-check list in
  `docs/tasks/2026-09-29-chat-panel-design/handoff.md`): AC1 rendering in Dark+/Light+/High Contrast/
  browser light-dark, AC2 at exactly 300px/379px, the weave-in's feel and `prefers-reduced-motion` in
  a real browser, the pinned-footer approximation's overlap with `NewSessionTips`, CSP/no-remote-
  request checks in the built `dist`, the Auto/Ask/Plan toggle end-to-end against a running server, a
  full keyboard-only pass.

## Changes

- Adding a new panel-toolbar control: extend `composer-controls.tsx` and pass it through
  `composer.tsx`'s `kete={{start, end}}` prop — don't add a second slot to `editor.tsx` without reason.
- Adding a new panel-state field the VS Code host can set: extend `PanelState` in `panel-state.ts`,
  `PanelMessage`/`panelMessage()` in `vscode-messages.ts`, and the extension's `kete.panel` payload
  (`panel.ts`/`extension.ts` in `packages/kete-vscode` — `vscode-extension` card).
- Widening what a new session's draft can carry into `session.create`: extend `KeteModeDraft`'s value
  type and `metadata()`'s mapping in `mode.ts`; the `data.ts` wrapper already forwards any `metadata`
  key given to it (`server-sdk` card).
- Adding content to the new-session panel: put scrollable content (hero, tips, notices) inside
  `KeteNewSessionLayout`'s `children`, pinned-to-bottom content (composer, selectors) in its
  `footer` prop — don't reintroduce a nested-wrapper approximation in `view.tsx` itself.

## Gotchas

- `useComposerSessionKey()` (`composer-controls.tsx:36-43`) parses the session ID out of the route
  pathname with a regex (`/\/session\/([^/]+)$/`) rather than a route param — a route restructuring
  that changes this URL shape silently breaks the toggle's session lookup without a type error.
- `mode.ts`'s `rememberedAgent` is a module-level `Map` keyed by session ID, not per-component state
  — it survives navigating away and back, but also means two concurrent tabs on the same session
  share one "agent to restore" memory.
- `panel.css`'s composer overrides key only on `data-component="composer"` and friends; they do not
  and must not depend on upstream's own Tailwind utility classes, which can be renamed by an upstream
  merge without notice.
- `composer-controls.tsx`'s `KeteModeToggle` reads `data.session.get(id)?.metadata` reactively — if a
  session isn't yet in the client's cache (e.g. right after `session.create`, before the
  `session.created` echo), `metadata` is `undefined` and `derive()` falls back to its `fallback`
  argument (defaulting to `"auto"`), not to whatever `KeteModeDraft` staged — the draft only affects
  the *server* payload, not this read.
- **`packages/app`'s `bun test` can't mount a JSX-authored Solid component** (now `jsxs_… is not defined`, see Quick answers). Historically: any file containing a
  JSX literal (`<Component/>` syntax, not `createComponent()`/plain calls) hits `ReferenceError:
  React is not defined` — Bun's JSX transform here falls back to a classic React pragma, regardless
  of test file location or `--conditions`. Confirmed against both `panel-layout.tsx` and the
  pre-existing `mark.tsx`. Every existing live-Solid-tree test avoids this by using non-JSX
  `createComponent()`; `panel-layout.test.ts` instead does source-text structural assertions (see
  Testing). This is a real infra gap, not fixed in this task — flagged in
  `docs/tasks/2026-09-29-chat-panel-design/handoff.md` for whoever picks it up.
