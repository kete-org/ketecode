# Plan: Chat panel design: empty state and composer (web app, VS Code host)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large — needs the user's approval before building.** It edits upstream files in `packages/app`
> and, since revision 2, one in `packages/client` (`src/solid/data.ts`)
> (listed below, each with a `kete_change` marker and why no seam works), adds bridge messages (a
> shared contract between `packages/kete-vscode` and `packages/app`), and adds a web-app control that
> writes the session's `kete.permissionMode` (permission behaviour; it can only narrow). No runtime,
> server, config-schema or protocol change, so no `generate` step.
>
> The user asked to **see the file list before any code**: show them "Files per commit" and
> "Decisions for the user" first; build only after they approve.

## Cards read
- docs/context/modules/vscode-extension.md (verified-at bfd6c66, stale: no)
- docs/context/modules/ui-branding.md (verified-at bfd6c66, stale: no)
- docs/context/modules/permissions.md (verified-at d5cd08f36b, stale: no)
- docs/context/modules/roles-skills.md (stale: no; doesn't cover the upstream `plan` agent, see handoff)
- docs/context/pitfalls.md, docs/context/commands.md, CLAUDE.md §4, §9, §12

## How the web app works today (findings the steps rely on)
- **Empty state:** `packages/app/src/new-session/view.tsx` `NewSessionView` (`:37-110`): wordmark
  (`NewSessionWordmark`, which renders `kete/wordmark.tsx`) and the `Composer` in one absolutely
  positioned column at 25% height, project/workspace selectors under it, `NewSessionTips` at the
  bottom. No slot or extension point.
- **Composer:** `composer/composer.tsx` wraps `composer/editor/editor.tsx` `ComposerEditor`
  (`<form data-component="composer">`, `:156`). The editor is a contenteditable
  (`data-component="composer-editor"`, grows by itself); Enter sends and Shift+Enter is a newline
  already (`editor/interaction.ts:201`); send is `data-action="composer-submit"`, disabled via
  `controller.canSubmit()` (`editor.tsx:~935`). Toolbar (`editor.tsx:270-360`): the `+` menu
  (attach / commands / context / shell, `ComposerEditorAddMenu`, `:630-690`), then
  `data-slot="composer-controls"` with the agent select (`view.agent`), the model control
  (`data-action="composer-model"`, `composer.tsx:55-134`, the web app's own model list and
  `ModelSelectorPopover`) and the effort select (`view.variant`, `ComposerEditorConfiguredSelect`),
  then `data-slot="composer-actions"` with the submit button. No voice input exists anywhere in the app.
- **Agent / effort:** `composer/model.ts:347-363` `view.agent` (`options/current/onSelect` →
  `adapter.controls().agents.select(name)`, type in `composer/adapter.ts:9-16`) and `view.variant`.
  The Plan agent is upstream's `plan` (`packages/core/src/plugin/plan.ts:13`, name "Plan", primary).
- **Permission mode:** the runtime reads session metadata `kete.permissionMode` (`"default"|"ask"`,
  `core/src/kete/permission-mode.ts:14`), env fallback `KETE_PERMISSION_MODE`. Today only the extension
  writes it (`kete-vscode/src/extension.ts:1205-1276`: GET the session, PATCH the merged metadata,
  since metadata is replaced whole) and it re-reads on `session.metadata.updated` (`extension.ts:490`).
  The web app's client has `sdk.api.session.update({ sessionID, metadata })`
  (`client/src/promise/generated/types.ts:3976`; used for titles in `shell/titlebar/tab-strip.tsx:119`)
  and the generated `session.create` accepts `metadata` (`types.ts:2891`). New sessions are created
  in `new-session/composer-adapter.ts:87` through the hand-written reactive wrapper
  `packages/client/src/solid/data.ts:1447-1481` (`Data["session"].create`), whose input type lacks
  `metadata`; its body spreads the rest of the input into `api().session.create({ ...payload, id,
  location })`, so only the type blocks it (revision 2, below).
- **VS Code host:** `kete/vscode-host.tsx` `embedded()` = `window.name === "kete-vscode"` inside a
  parent; `KeteVSCodeShell.applyTheme` sets `data-kete-host="vscode"` and the mapped `--v2-*` tokens
  (`kete/vscode-theme.ts` `MAPPING`); the relay in `kete-vscode/src/chat.ts:56-71` forwards only the
  `fromFrame`/`toFrame` allowlists.
- **Theme:** browser colours come from `packages/ui/src/theme/kete/theme.ts` (`brand`, `accents`,
  keeps id `oc-2`); light/dark is `[data-color-scheme]` on the root (see `editor/editor.css:35`).
  Unlayered CSS beats the Tailwind utilities, which live in layers.
- **Fonts:** upstream fonts are `@font-face` in `app/src/index.css:6-26`. The wordmark font is in the
  repo: `assets/brand/fonts/bricolage-grotesque-latin-600-normal.woff2` + `OFL.txt` + `README.md`
  (commit 86def2722f; `assets/brand/` is Kete-owned). **One source of truth: reference it in place,
  never copy it.** A Kete CSS file's `url("../../../../assets/brand/fonts/…woff2")` is resolved and
  hashed into `dist/_assets` by Vite at build time (dev: Vite's default `server.fs.allow` is the
  workspace root, which contains `assets/`). The OFL text must ship with it: import it with `?url`
  from a Kete module so Vite emits it too, and link it from the About credits. The extension needs
  neither file (the font renders inside the framed web UI).
- **Tests:** `bun run test:unit` in `packages/app` (`--conditions=solid --preload ./happydom.ts ./src`);
  one file: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/<file>.test.ts`.

## Files per commit

"Upstream" = needs `kete_change` markers and a `docs/upstream-patches.md` entry. Paths with `kete` in
them need no markers. Read-only files are listed under the commit that needs them.

### Commit 1 — `feat(app): Kete brand tokens, logo mark and wordmark font`
| File | Read / change | Upstream? | Why |
|---|---|---|---|
| `docs/design/kete-code-panel.html` | read | — | v4 mockup: tokens (`:24-78`), mark geometry (`:280-289`), everything visual |
| `assets/brand/fonts/README.md` | read | — | font provenance; bundle, never load remotely |
| `packages/app/src/kete/tokens.css` | **create** | no | `--kete-*` tokens from the spec (brand, brand-soft light/dark, ink, paper; dark/light bg, surface, surface-2, border, border-strong, text 1-3; radii; `--kete-ui-font` system UI stack, `var(--font-family-sans)` under `[data-kete-host="vscode"]`; `--kete-mono`); light/dark keyed on `[data-color-scheme]`; high contrast (`[data-kete-contrast="high"]`) maps surfaces/borders/text to the VS Code-mapped `--v2-*` tokens; `@font-face "Kete Wordmark"` weight 600, `font-display: swap`, `url()` to `assets/brand/fonts/…woff2` |
| `packages/app/src/kete/mark.tsx` | **create** | no | `MARK_RECTS` (the eight rects, viewBox 0 0 512 512, radii 10/12) as the single geometry source; `KeteMark` inline SVG (brand rects `var(--kete-brand)`, ink rects `currentColor`, `role="img"` + `aria-label` from `Brand.displayName`, or `aria-hidden` when decorative) |
| `packages/app/src/kete/wordmark.tsx` | change | no | real wordmark: "Kete" primary, "Code" secondary, Bricolage 600 via tokens.css, names from `@opencode/util/kete/brand`; keeps the 720×129 box its callers (`new-session/wordmark.tsx`, `servers/connect/screen.tsx`) rely on; drop the "placeholder" header |
| `packages/app/src/kete/fonts.ts` | **create** | no | `import licence from "../../../../assets/brand/fonts/OFL.txt?url"`; exports `wordmarkFont = { name, licenceUrl }` so Vite emits the OFL with the font |
| `packages/app/src/kete/assets.d.ts` | **create** | no | `declare module "*?url"` (the app's `env.d.ts` has no `vite/client` types) |
| `packages/app/src/settings/about/about.tsx` | change (1-3 lines) | **yes** | a "Bricolage Grotesque — SIL OFL 1.1" credit linking `wordmarkFont.licenceUrl`, beside upstream's credits; About renders the credits inline, no seam (skip if the user picks D5-b) |
| `packages/app/src/kete/vscode-host.tsx` | change | no | `applyTheme` also sets `root.dataset.keteContrast = "high"` for `high-contrast*` kinds (removed otherwise); imports `./tokens.css` so tokens load app-wide (the shell mounts it in `app.tsx`) |
| `packages/app/src/kete/tokens.test.ts` | **create** | no | tokens.css brand equals `@opencode/ui/theme/kete/theme` `brand`; the font `url()` is relative (no `http`, no `fonts.googleapis`); `MARK_RECTS` has 8 rects inside 512 |
| `packages/ui/src/theme/kete/theme.ts` | change | no | `brand = { light: "#6E47F5", dark: "#A38CFA" }`, the `accents` ramp (light hover `#5A34E6`; dark text `#A38CFA`, hover a lighter tint; bg-accent/focus `#6E47F5`), comment's contrast figures recomputed (white on #6E47F5 ≈ 5.4:1) |
| `packages/ui/src/theme/kete/theme.test.ts` | change | no | expectations for the new values |
| `packages/app/index.html` | change (inside the existing marked favicon line) | **yes** (already marked) | favicon = the mark as a data-URI SVG instead of the "k" placeholder |

### Commit 2 — `feat(app): chat panel header, empty state and composer`
| File | Read / change | Upstream? | Why |
|---|---|---|---|
| `packages/app/src/new-session/view.tsx` | read, change (~5 marked lines) | **yes** | render `<KetePanelHeader/>` at the top of `data-component="new-session"`, `<KeteEmptyState/>` in place of `<NewSessionWordmark />`, `<KeteCliHint/>` above `<Composer>`, and `data-kete="panel-stack"` / `data-kete="panel-footer"` on the two existing containers so `panel.css` can lay out hero (scrolls) above a bottom footer (CLI hint, composer, project/workspace row). The view builds its layout inline: no slot. Don't restructure or reformat the rest |
| `packages/app/src/composer/composer.tsx` | read, change (~3 marked lines) | **yes** | pass `kete={{ start: <KeteCommandsButton/>, end: <KeteModeToggle/> }}` to `ComposerEditor` |
| `packages/app/src/composer/editor/editor.tsx` | read `:60-80`, `:270-360`, `:630-700`, `:915-950`; change (~5 marked lines) | **yes** | an optional `kete?: { start?: JSX.Element; end?: JSX.Element }` prop rendered after the `+` menu and before the submit button; add class `kete-effort` to the variant `ComposerEditorConfiguredSelect` so CSS can hide effort under 380px. The toolbar has no extension point |
| `packages/client/src/solid/data.ts` | read `:1-40`, `:1440-1500`; change (2 marked lines) | **yes** | hand-written (not generated: generated code is only `src/promise/generated`, `src/effect/generated`, `src/effect/api`, per `package.json` `check:generated`). Add `metadata?: SessionCreateInput["metadata"]` to `create()`'s input type (import `SessionCreateInput` in the existing `../promise` type import, same marker). No body change: `...payload` already forwards it to `api().session.create`. The optimistic local record needn't carry it; the `session.created` echo re-syncs the durable one |
| `packages/client/test/kete/session-create-metadata.test.ts` | **create** | no | following `test/solid-data.test.ts:801-825` (fake `fetch` on `/api/session`): `data.session.create({ …, metadata: { "kete.permissionMode": "ask" } })` sends that metadata in the request body; without it, no `metadata` key is sent |
| `packages/client/test/solid-data.test.ts` | read `:1-10`, `:801-830` | — | the test setup to copy |
| `packages/app/src/new-session/composer-adapter.ts` | read `:40-175`, change (1-2 marked lines) | **yes** | `data.session.create({ …, metadata: KeteModeDraft.metadata(draftID) })` (undefined when the draft's mode is the default, so nothing changes for other users) so "Ask" is stored atomically with the session, before any prompt. The create call is inline; no seam. Clear the draft entry after creation |
| `packages/app/src/composer/model.ts` | read `:340-365` | — | `view.agent` / `view.variant` shapes |
| `packages/app/src/composer/adapter.ts` | read `:1-40` | — | `ComposerControls.agents` |
| `packages/app/src/session/composer/region.tsx` | read `:40-70` | — | where the session's `info` (metadata, agent) is available in the session composer tree |
| `packages/app/src/shell/titlebar/tab-strip.tsx` | read `:100-125` | — | how a component gets `ctx.sdk.api.session.update` |
| `packages/app/src/composer/editor/editor.css` | read | — | existing composer selectors to override (never edit) |
| `packages/app/src/kete/panel.css` | **create** | no | header, empty state (84px hero, weave-in once — no source mockup has the keyframes: stagger the eight rects fading in from a small offset, ~0.7s total, ease-out, none under `prefers-reduced-motion`), tip + `kbd` keycaps, notice cards, CLI hint, footer layout via `[data-kete=…]`; composer overrides on `[data-component="composer"]` (1px brand border, 3px ring at 12%, 24% on `:focus-within`), send idle (~38% brand) / active (solid brand), model + effort as one pill, `@media (max-width: 379px) .kete-effort {display:none}`, 300px rules, `:focus-visible` rings in brand |
| `packages/app/src/kete/panel.tsx` | **create** | no | `KetePanelHeader` (small mark + wordmark, centred), `KeteEmptyState` (hero mark, tip, notices), `KeteCliHint`; every icon button has an `aria-label`; notices rendered as text (backtick spans → `<code>`, never `innerHTML`); reads panel state from `panel-state.ts` |
| `packages/app/src/kete/panel-state.ts` | **create** | no | pure: `tipKeys(platform)` (`["⌥","K"]` on mac, `["Alt","K"]` elsewhere), `segments(text)` (backtick split), a per-page store (solid signal) for `{ host, platform, notices, cliHint, defaultMode }` with browser defaults (no notices, no CLI hint, no tip) |
| `packages/app/src/kete/composer-controls.tsx` | **create** | no | `KeteCommandsButton` ("/" → `controller.openCommands`, `aria-label`); `KeteModeToggle` (button, label Auto/Ask/Plan, `aria-label="Permission mode: …"`, icon) using `mode.ts` |
| `packages/app/src/kete/mode.ts` | **create** | no | pure + thin effect: `derive({ agent, metadata, fallback })` → Auto/Ask/Plan (agent `plan` ⇒ Plan; else metadata `ask` ⇒ Ask; else Auto); `next(mode, planAvailable)` cycles Auto→Ask→Plan→Auto (skips Plan when the `plan` agent is absent/disabled); `withMode(metadata, mode)` merges, never drops other keys; `KeteModeDraft` (draft ID → mode, for new sessions); `apply()` = for a session: GET-merge-PATCH `kete.permissionMode` via the SDK; Plan ⇒ `agents.select("plan")` remembering the previous agent, leaving Plan restores it (default agent if none) |
| `packages/app/src/kete/mode.test.ts` | **create** | no | cycle order, Plan skipped when unavailable, derive from agent/metadata, merge keeps other metadata keys, `ask`/`default` only (nothing else written) |
| `packages/app/src/kete/panel-state.test.ts` | **create** | no | tip keys per platform, backtick segmentation with unbalanced/HTML-looking input rendered as text |

### Commit 3 — `feat(vscode): panel notices and CLI hint over the bridge, kept dismissed`
| File | Read / change | Upstream? | Why |
|---|---|---|---|
| `packages/app/src/kete/vscode-messages.ts` | change | no | `panelMessage(data)` for `kete.panel`: `platform` `"mac"\|"other"`, `defaultMode` `"default"\|"ask"`, `cliHint` boolean, `notices` ≤ 10 of `{ id: /^[a-z0-9-]{1,64}$/, title ≤ 120, body ≤ 600, isNew?: boolean }`; anything else ⇒ undefined |
| `packages/app/src/kete/vscode-messages.test.ts` | change | no | valid/invalid `kete.panel` cases (bad ids, oversize, wrong types, extra fields ignored) |
| `packages/app/src/kete/vscode-host.tsx` | change | no | `KeteVSCodeShell` listener: `panelMessage` → panel store; export `dismissNotice(id)` / `dismissCliHint()` posting `kete.dismissNotice` / `kete.dismissCliHint` to the parent (only when `embedded()`) |
| `packages/app/src/kete/panel.tsx` | change | no | dismiss buttons call those (and hide optimistically; the host's next `kete.panel` is authoritative) |
| `packages/kete-vscode/src/chat.ts` | change | no | `fromFrame += "kete.dismissNotice", "kete.dismissCliHint"`; `toFrame += "kete.panel"` |
| `packages/kete-vscode/src/panel.ts` | **create** (no `vscode` import) | no | `NOTICES` (the notice list, per D5), `panelState({ dismissed, cliHintDismissed, platform, defaultMode })`, `dismiss(dismissed, id)` (only known ids, dedupe, bounded), keys `kete.panel.dismissedNotices` / `kete.panel.cliHintDismissed`, a `Store` interface (`get`/`update`) that `context.globalState` satisfies |
| `packages/kete-vscode/src/extension.ts` | read `:109-170`, `:560-625`, `:1205-1276`; change | no | on `kete.hello` post `kete.panel` (platform from `process.platform === "darwin"`, `defaultMode` = `state.serverMode`); on the two dismiss messages update `context.globalState` and re-post `kete.panel` to every ready webview |
| `packages/kete-vscode/test/panel.test.ts` | **create** | no | a fake `Store`: dismissal persists across a "reload" (new state from the same store), unknown ids ignored, CLI hint, platform/defaultMode mapping |
| `packages/kete-vscode/test/chat.test.ts` | change | no | the relay forwards the new types and still drops unknown ones |

### Commit 4 — `chore(vscode): brand colour, activity-bar mark, keybinding tip`
| File | Read / change | Upstream? | Why |
|---|---|---|---|
| `packages/kete-vscode/package.json` | change | no | `galleryBanner.color` `#6E47F5`; keybinding `kete.addToChat` stays `alt+k` / mac `alt+k` (`when: editorTextFocus`) — verify only; activity bar/view icons keep pointing at `media/kete.svg` |
| `packages/kete-vscode/media/kete.svg` | replace | no | monochrome mark from `MARK_RECTS` (all rects `currentColor`, no `var()`: VS Code masks activity-bar icons) |
| `packages/kete-vscode/media/icon.png` | replace | no | copy of `assets/brand/kete-logo-512.png` (Marketplace icon; D6) |
| `packages/kete-vscode/media/icon.svg` | delete | no | unused old source art still in `#7C3AED` (nothing references it) |
| `packages/kete-vscode/test/brand.test.ts` | **create** | no | lockstep, so the assets have one source of truth: `media/kete.svg`'s rects equal `packages/app/src/kete/mark.tsx`'s `MARK_RECTS`; `media/icon.png` bytes equal `assets/brand/kete-logo-512.png`; manifest banner is `#6E47F5` |
| `packages/kete-vscode/README.md`, `CHANGELOG.md` | change | no | note the redesigned panel and the Auto/Ask/Plan toggle |

### After the build (every commit's docs, or with commit 4)
| File | Change |
|---|---|
| `docs/upstream-patches.md` | new section "Chat panel design": `new-session/view.tsx`, `composer/composer.tsx`, `composer/editor/editor.tsx`, `new-session/composer-adapter.ts`, `client/src/solid/data.ts`, `settings/about/about.tsx`, `index.html` (favicon) — one line each |

## Upstream edits (summary)
1. `packages/app/src/new-session/view.tsx` — empty state, header, CLI hint and two layout attributes; the view has no slots.
2. `packages/app/src/composer/editor/editor.tsx` — a `kete` start/end slot in the toolbar and an `kete-effort` class; no toolbar extension point.
3. `packages/app/src/composer/composer.tsx` — passes the Kete controls into that slot.
4. `packages/app/src/new-session/composer-adapter.ts` — the chosen mode goes into `session.create`'s metadata; the only race-free place.
5. `packages/client/src/solid/data.ts` — one optional `metadata` field on the reactive `session.create` wrapper's input type (+ its type import); the wrapper already forwards it. Needed by 4; see revision 2 under Decisions.
6. `packages/app/src/settings/about/about.tsx` — the font's OFL credit (D5). Done in d8db0ac466.
7. `packages/app/index.html` — favicon, inside the existing marked line. Done in d8db0ac466.
Everything else (tokens, CSS overrides, components, logic, bridge) is Kete-owned. CSS overrides the
upstream composer from `kete/panel.css`; `editor.css` and `index.css` are not edited.

## Steps
1. Confirm D1-D9 with the user (below). Then work on this branch, one commit per section above, staging only the listed files (pitfalls: never `git add -A` across `docs/`).
2. Commit 1: write `tokens.css`, `mark.tsx`, `fonts.ts`, `assets.d.ts`; rewrite `wordmark.tsx`; update the ui theme + test; add `data-kete-contrast` and the tokens import in `vscode-host.tsx`; favicon; About credit. Run the commit-1 checks.
3. Commit 2: `mode.ts` + test first (pure), then `panel-state.ts` + test, then `panel.tsx`, `composer-controls.tsx`, `panel.css`; then the upstream edits: `packages/client/src/solid/data.ts` + its Kete test first (run `bun test ./test/kete/session-create-metadata.test.ts` in `packages/client`), then the four in `packages/app`. Find the session ID/metadata and the SDK inside the composer tree with existing hooks (see `region.tsx`, `tab-strip.tsx`); if that needs any upstream edit not listed here, stop and return to the planner. Leave `NewSessionTips` in place; position it with `panel.css` so it doesn't overlap the footer.
4. Commit 3: app validator + test, host wiring, then the extension's `panel.ts` + test, `chat.ts` + test, `extension.ts`.
5. Commit 4: manifest, `media/*`, `brand.test.ts`, README/CHANGELOG.
6. `docs/upstream-patches.md` entry; full checks; `upstream:check`; manual passes for AC1-AC3 and AC6 (Dark+, Light+, a high-contrast theme, browser light/dark, 300px and 379px widths, keyboard only), recorded in `result.md`.

Rules while building: no `any`/unsafe casts; validate every postMessage both sides; the toggle only
writes `"default"`/`"ask"` and never touches the session's `permissions`; the frame never trusts
notice text as HTML; no remote URL anywhere (fonts, icons: Tabler icons are inlined as SVG paths,
or use `@opencode/ui/icon` names); `prefers-reduced-motion` disables the weave.

## Verification
| Criterion | Command (narrowest first; inside the package) |
|---|---|
| AC1 render per mockup | `packages/app`: `bun run typecheck`; `bun run build`; manual in the browser (`bun run dev` at the root, light/dark) and in VS Code (`packages/kete-vscode`: `bun run build`, then `bun run e2e <path/to/.vsix>` or the Extension Development Host) in Dark+, Light+, High Contrast |
| AC2 300px, effort hidden < 380px | manual at 300px and 379px (VS Code sidebar and browser devtools); `bun test --conditions=solid --preload ./happydom.ts ./src/kete/panel-state.test.ts` |
| AC3 keyboard, focus, aria, Enter/Shift+Enter, send disabled | `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/composer/editor/interaction.test.ts` (upstream Enter behaviour unchanged); manual keyboard-only pass |
| AC4 dismissals survive reload | `packages/kete-vscode`: `bun test ./test/panel.test.ts`; manual: dismiss, "Developer: Reload Window" |
| AC5 Auto → Ask → Plan | `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/mode.test.ts`; `packages/client`: `bun test ./test/kete/session-create-metadata.test.ts`, then `bun run test` and `bun run typecheck`; manual: set Ask on a new chat, send a prompt that edits a file, and the first edit asks; manual: toggle, then `GET /api/session/:id` shows `kete.permissionMode`; the extension's title-bar shield follows |
| AC6 no CSP violations, no remote requests | `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/tokens.test.ts`; after `bun run build`: `grep -rE "fonts\.(googleapis\|gstatic)\|https?://[^\"')]*\.woff2" dist` finds nothing and `ls dist/_assets \| grep -i bricolage` finds the font; `packages/kete-vscode`: `bun test ./test/chat.test.ts`; manual: webview devtools console shows no CSP errors, network shows only the local server |
| AC7 tests and checks | `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/vscode-messages.test.ts`, then `bun run typecheck`, `bun run test:unit`; `packages/ui`: `bun test ./src/theme/kete/theme.test.ts`, `bun run typecheck`; `packages/client`: `bun run typecheck`, `bun run test`; `packages/kete-vscode`: `bun test ./test/brand.test.ts`, `bun run typecheck`, `bun run test`; root: `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; before the PR `bun run --cwd packages/kete-tools verify --base main` |

## Decisions for the user
- **D1 Spec vs v4 mockup.** The spec came from the older mockup; v4 differs. The plan follows the approved spec where they disagree: header with wordmark on the empty state (v4 has none), 84px hero with weave-in (v4: 64px, static), no starter prompts (v4 has three), composer border 1px brand + 3px ring (v4: neutral border, brand on focus), tip "Alt K" off macOS (v4 shows "Ctrl", which doesn't match the Alt+K binding). Confirm, or name the v4 items to take instead.
- **D2 Page background.** Recommended: Kete tokens on the panel's own parts (header, hero, notices, CLI hint, composer) while the page background stays the theme's (VS Code's sidebar colour in VS Code, the web theme in the browser), so the session view doesn't jump colour. Alternative: repaint the whole web UI with the Kete bg/surface palette (#100F15 …), which restyles the conversation view too (out of the spec's scope).
- **D3 Voice button.** No voice input exists; the browser's speech API sends audio to a remote service and VS Code webviews don't grant the microphone. Recommended: leave it out until there's a local or configured speech path (no fake button, CLAUDE.md §10). Alternative: a disabled button with "coming soon".
- **D4 Browser.** Recommended: in the browser no Alt+K tip (it's an editor binding), no CLI hint (the browser UI is served by the CLI) and no notices (no server source yet).
- **D5 Content.** The notice list and CLI-hint wording (suggested: v4's "Agents from your portal" and "Kete reads your AGENTS.md"; hint "Kete Code also runs in your terminal: `kete`"). And where the font's OFL is credited: (a) a line in About's credits (one marked upstream edit, recommended) or (b) only in the release artifacts (needs release-script work instead).
- **D6 Marketplace icon.** Replace `media/icon.png` with `assets/brand/kete-logo-512.png` (with a lockstep test) and delete the unused `media/icon.svg`?
- **D7 Duplicate mode control in VS Code.** The extension's title-bar "Ask before edits" buttons stay and follow the toggle through `session.metadata.updated`; remove them now that the composer has the toggle?
- **D8 Agent dropdown.** Kept (the starter roles need it); Plan is selectable there too and the toggle derives its state from the agent. OK?
- **Revision 2 (planner, after the implementer's stop): how a new chat starts in Ask.** The reactive
  `data.session.create` wrapper (`packages/client/src/solid/data.ts`, hand-written upstream code) has
  no `metadata` in its input type. Options: (a) widen that type by one optional field (its body
  already forwards it) and pass the mode at creation — atomic, no extra request; (b) PATCH metadata
  in `composer-adapter.ts` after creation, folded into the `creation` promise the first prompt is
  gated on (`afterCreation`, `:109-113`, `:160-162`) — ordered correctly, but a second request, a
  window where the session exists without its mode, and a new failure path (created but mode not
  set) that must block the prompt; (c) the `KETE_PERMISSION_MODE` env default — server-wide, can't
  follow a per-chat toggle. **Chosen: (a)**, the smallest correct change: two marked lines in
  `data.ts`, no behaviour change for other callers, and the mode is part of the create request. It
  adds a seventh upstream file (in `packages/client`); tell the user when showing the revised plan.
- **D9 Other #7C3AED uses** — TUI theme (`tui/src/kete/theme.*`), sign-in pages (`core/src/oauth/page.ts`, `cli/src/kete/cli-login.ts`) — are runtime/CLI code, out of this spec's scope. Recommended: a small follow-up PR. Kete panel strings are English-only for now (no locale-file edits).

## Risks
- The four `packages/app` upstream edits sit in files upstream changes often (`view.tsx`, `editor.tsx`); keep them to marked lines so syncs conflict only there. Layout depends on two `data-kete` attributes, not upstream Tailwind classes.
- CSS overrides of the upstream composer can break on an upstream class/attribute rename; they key on `data-component`/`data-action`/`data-slot` attributes only.
- `data.ts` is shared by every `data.session.create` caller; the change is an optional field only, so existing callers are unaffected (the client's own tests cover that).
- `bun test` loading a CSS file whose `url()` points outside the package: keep CSS imports in the `.tsx` components and the tested logic in `.ts` files that import no CSS.

## Cards to update after the build
- vscode-extension: new bridge messages (`kete.panel`, `kete.dismissNotice`, `kete.dismissCliHint`), `panel.ts`, globalState keys, `brand.test.ts` lockstep, the web toggle as a second writer of `kete.permissionMode`.
- ui-branding: brand `#6E47F5`/`#A38CFA`, tokens.css, mark.tsx (geometry source), the real wordmark + font from `assets/brand/fonts` (referenced, not copied), OFL credit, panel.css composer overrides, the new upstream edits.
- permissions: the web app's mode toggle writes `kete.permissionMode` (merged metadata; at create for new sessions); Plan = the `plan` agent, not a mode.
- roles-skills (or a new line in ui-branding): upstream's `plan` agent (`core/src/plugin/plan.ts`) and how the toggle selects it.
- docs/upstream-patches.md section "Chat panel design".
