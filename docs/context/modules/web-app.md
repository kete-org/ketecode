---
module: web-app
paths: [packages/app/src/kete/panel.tsx, packages/app/src/kete/panel.css, packages/app/src/kete/panel-layout.tsx, packages/app/src/kete/panel-state.ts, packages/app/src/kete/mode.ts, packages/app/src/kete/composer-controls.tsx, packages/app/src/new-session/view.tsx, packages/app/src/composer/composer.tsx, packages/app/src/composer/editor/editor.tsx, packages/app/src/new-session/composer-adapter.ts]
verified-at: 604889ab32
---

## Quick answers
- Where are the Offline indicator, the first-run local models offer and the no-tools notice? `KeteOfflineIndicator` in the panel header and `KeteLocalOffer` in the empty state (`app/src/kete/panel.tsx:33,43`); the once-per-session no-tools notice via `useKeteNoToolsNotice` in `composer-controls.tsx:51` (the `KeteModeToggle` file). All in `app/src/kete/local-ui.tsx`; see the `local-models` card.

- What is the "Kete panel"? The redesigned empty state + composer of the web app's new-session/
  session view: a header (mark + wordmark), an 84px hero with a one-time weave-in animation, an
  optional tip and "what's new" notices, a dismissible CLI hint, and two composer-toolbar additions
  (a commands button, an Auto/Ask/Plan permission-mode toggle). `docs/tasks/2026-09-29-chat-panel-design/`
  is the task that built it; `spec.md` there is the source of truth for exact visuals, not this card.
- Where does the empty state/composer live upstream, and what's the seam? `new-session/view.tsx`
  `NewSessionView` has no slot — Kete's header/empty-state/CLI-hint replace `<NewSessionWordmark/>`
  and add two layout attributes (`data-kete="panel-stack"`/`"panel-footer"`) at `view.tsx:62-69`
  (`kete_change`, ~5 marked lines). The composer toolbar has no extension point either —
  `composer/editor/editor.tsx:75` adds an optional `kete?: { start?, end? }` prop rendered before/after
  the `+` menu and submit button (`:292`, `:357`); `composer/composer.tsx:14,38` passes
  `KeteCommandsButton`/`KeteModeToggle` into it. Don't restructure or reformat the rest of either
  upstream file — CSS overrides key only on `data-component`/`data-action`/`data-slot`/`data-kete`
  attributes, never on upstream's own classes (they can rename on sync).
- How does a **new** session start in Ask (not race a first prompt against a PATCH)? The toggle
  (unauthenticated, no session yet) stores the chosen mode in `mode.ts`'s `KeteModeDraft` map, keyed
  by the new-session draft's ID; `new-session/composer-adapter.ts:97` passes
  `KeteModeDraft.metadata(draftID)` (undefined for Plan/default, so nothing changes for other users)
  into `data.session.create({ …, metadata })`, then clears the draft (`:99`). That call goes through
  `packages/client/src/solid/data.ts`'s hand-written reactive wrapper, not the generated SDK directly
  — see the `server-sdk` card for why that needed its own small upstream edit.
- How does the toggle change mode on an **existing** session? `mode.ts`'s `apply()`: for Auto/Ask,
  GET the session, merge `kete.permissionMode` into its metadata, PATCH (metadata is replaced whole
  server-side — the same pattern the VS Code extension's title-bar toggle uses,
  `kete-vscode/src/extension.ts:1205-1276`); for Plan, it calls the composer's agent selector
  (`ApplyAgent.select("plan")`), remembering the agent it replaced per session so leaving Plan
  restores it (or the first non-Plan agent offered, if none was remembered — `mode.ts:98-115`).
- Why is `ApplyAgent.current`/`select` typed as plain `string`, not `string | undefined`? The real
  `view.agent` (`composer/model.ts:347-363`) always has a current agent and its `onSelect` only takes
  a `string` — there's no "no agent" state to select back into. A single-agent composer (no switcher)
  never offers Plan (`planAvailable` is false), so the "restore *a* sensible agent" fallback path is
  never actually exercised in that case.
- Does the browser (not VS Code) show the tip, CLI hint, or notices? No, by design (D4,
  `panel-state.ts:70-73`, `tipVisible`) — Alt+K is an editor keybinding, the CLI hint doesn't make
  sense from a browser already served by the CLI, and there's no notice source yet for the browser.
  `panel-state.ts`'s default `PanelState` (`host: "browser"`) has empty notices, no CLI hint, no tip;
  only `vscode-host.tsx`'s `kete.panel` listener sets `host: "vscode"` and fills the rest in — see the
  `vscode-extension` card for that side of the bridge.
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
  `ComposerControls`; the model control is `composer.tsx:55-134`'s own popover
  (`data-action="composer-model"`). `mode.ts`'s `ApplyAgent` wraps `view.agent` for the toggle; it
  doesn't touch `view.variant` or the model control at all.
- Is `new-session/wordmark.tsx` (the shimmer wrapper) still used? No — `KeteEmptyState` replaced its
  only call site in `view.tsx`. It's dead code, deliberately left in place (not in the approved plan's
  file list) rather than deleted in this task; a cleanup candidate.

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
- `packages/app/src/composer/composer.tsx:38` — passes `kete={{ start, end }}` into `ComposerEditor`
  (`kete_change`).
- `packages/app/src/composer/editor/editor.tsx:75,292,357` — the `kete` slot itself (`kete_change`).
- `packages/app/src/new-session/composer-adapter.ts:97,99` — `KeteModeDraft.metadata(draftID)` on
  `session.create`, cleared after (`kete_change`).

## Key files

| File | Lines | Role |
| --- | --- | --- |
| `packages/app/src/kete/panel.tsx` | 117 | `KetePanelHeader`, `KeteEmptyState`, `KeteCliHint`; renders notice/hint text via `segments()`, never `innerHTML`; every icon button has an `aria-label` |
| `packages/app/src/kete/panel.css` | ~318 | Header/empty-state/CLI-hint/notice styling, the weave-in keyframes, composer border/ring/send-button overrides on `[data-component="composer"]`, the 300px/379px responsive rules, `prefers-reduced-motion` disabling the weave, and the `panel-column`/`panel-scroll`/`panel-footer` layout split (below) |
| `packages/app/src/kete/panel-layout.tsx` | 17 | `KeteNewSessionLayout({children, footer})` — the scroll-area-above-pinned-footer wrapper `new-session/view.tsx` renders in place of nesting the footer inside the hero's own wrapper; no `vscode` import, styled entirely by `panel.css`'s `data-kete` attributes |
| `packages/app/src/kete/panel-state.ts` | 81 | `PanelState` signal (`host`, `platform`, `notices`, `cliHint`, `defaultMode`), `tipKeys()`, `segments()`, `tipVisible()`, `updatePanelState()`, local optimistic `dismiss*Locally()` |
| `packages/app/src/kete/mode.ts` | 117 | `derive`/`next`/`withMode` (pure), `KeteModeDraft` (new-session mode staging), `apply()` (GET-merge-PATCH metadata, or select the `plan` agent), `ApplyAgent`/`ModeSDK` types |
| `packages/app/src/kete/composer-controls.tsx` | 98 | `KeteCommandsButton` (opens `/` commands), `KeteModeToggle` (cycles `mode.ts`'s state, resolves the session ID from the route or the new-session draft ID from `?draftId=`) |

## Data flow

**Empty state / notices / CLI hint:** `panel-state.ts`'s module-level `panelState` signal starts with
browser defaults → in the VS Code host, `vscode-host.tsx`'s message listener calls
`updatePanelState({host: "vscode", ...panelMessage(event.data)})` on every `kete.panel` message →
`panel.tsx` reads `panelState()` reactively. Dismissing a notice/hint calls both a local optimistic
hide (`dismiss*Locally()`, so the UI updates immediately) and, when embedded, posts
`kete.dismissNotice`/`kete.dismissCliHint` to the extension (`vscode-host.tsx`'s exported
`dismissNotice`/`dismissCliHint`) — the extension's next `kete.panel` broadcast is authoritative.

**Permission mode toggle:** `composer-controls.tsx`'s `KeteModeToggle` derives its displayed state
from `mode.ts`'s `derive({agent: view.agent?.current(), metadata: session?.metadata})`, reading the
session's cached metadata via `useData()`. Clicking cycles with `next()` (skips Plan when the `plan`
agent isn't offered) then: existing session → `mode.apply({sdk, sessionID, mode, agent})`; no session
yet (new-session route) → Plan selects the agent immediately via the composer's `ApplyAgent`, Auto/Ask
is staged in `KeteModeDraft` for `composer-adapter.ts`'s `session.create` call to pick up.

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

- `bun test --conditions=solid --preload ./happydom.ts ./src/kete/mode.test.ts` — cycle order, Plan
  skipped when unavailable, `derive()` from agent/metadata, metadata merge keeps other keys.
- `bun test --conditions=solid --preload ./happydom.ts ./src/kete/panel-state.test.ts` — tip keys per
  platform, backtick segmentation including unbalanced/HTML-looking input.
- `bun test --conditions=solid --preload ./happydom.ts ./src/kete/vscode-messages.test.ts` — valid/
  invalid `kete.panel` payloads.
- `bun test ./src/kete/panel-layout.test.ts` (plain `bun test`, no `--conditions=solid`/happydom) —
  structural, source-text assertions (same technique as `kete-vscode/test/brand.test.ts`'s
  `markRects()`): `panel-scroll` (children) comes before `panel-footer` (footer) inside
  `panel-column`, each slot renders the right prop, and `view.tsx`'s actual usage puts the empty
  state before the CLI hint in the scroll slot and the composer in the footer slot. Not a mounted
  Solid tree — see Gotchas.
- `bun test --conditions=solid --preload ./happydom.ts ./src/composer/editor/interaction.test.ts` —
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
- **`packages/app`'s `bun test` can't mount a JSX-authored Solid component.** Any file containing a
  JSX literal (`<Component/>` syntax, not `createComponent()`/plain calls) hits `ReferenceError:
  React is not defined` — Bun's JSX transform here falls back to a classic React pragma, regardless
  of test file location or `--conditions`. Confirmed against both `panel-layout.tsx` and the
  pre-existing `mark.tsx`. Every existing live-Solid-tree test avoids this by using non-JSX
  `createComponent()`; `panel-layout.test.ts` instead does source-text structural assertions (see
  Testing). This is a real infra gap, not fixed in this task — flagged in
  `docs/tasks/2026-09-29-chat-panel-design/handoff.md` for whoever picks it up.
