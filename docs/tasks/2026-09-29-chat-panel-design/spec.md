# Spec: Chat panel design: empty state and composer (web app, VS Code host)

- Task: `docs/tasks/2026-09-29-chat-panel-design` · Size: large · Created: 2026-09-29
- Status: approved (user, 2026-09-29; from the user's design brief and four decisions)

## Goal
The chat panel's empty state and composer match the design in `docs/design/kete-code-panel.html`
(v4) with the new brand tokens, in the VS Code sidebar and in the browser UI alike.

## Decisions (user, 2026-09-29)
- **Where:** restyle the web app (`packages/app`) chat; the extension stays a thin iframe host
  (`kete.chat` view, `chat.ts`). The brief's extension-owned webview is replaced by this.
- **Permission-mode toggle:** Auto → Ask → Plan. Auto/Ask are the runtime's `kete.permissionMode`
  `default`/`ask`; Plan switches the session to the plan agent. No runtime change.
- **Keybinding:** keep the existing Alt+K (⌥K on macOS) "add selection to chat" on every platform;
  the tip shows ⌥ K on macOS and Alt K elsewhere.
- **Brand colour:** `#6E47F5` everywhere (replacing `#7C3AED`, e.g. the extension manifest's
  `galleryBanner`).

## Scope
- **Tokens** (from the brief): `--brand #6E47F5`, `--brand-soft #A38CFA` (light `#5A34E6`),
  `--brand-ink #16141D`, `--brand-paper #F1EFF6`; dark bg `#100F15`, surface `#17151E`, surface-2
  `#211E2B`, border `#2A2634`, text `#F1EFF6`/`#A7A3B4`/`#6F6B7D`; light bg `#FBFAFD`, surface
  `#F4F2F8`, surface-2 `#ECE9F3`, border `#E0DCE9`, text `#16141D`/`#55516A`/`#8A8699`. In VS Code
  high-contrast themes, fall back to VS Code theme variables. UI text uses the VS Code / system UI font
  and code the editor font; only the wordmark uses Bricolage Grotesque 600, bundled (woff2, 600 only,
  with its OFL licence), never loaded remotely.
- **Logo:** an inline SVG component (viewBox 0 0 512 512, the brief's bar geometry and radii; purple
  bars `var(--brand)`, ink bars `currentColor`), and a monochrome activity-bar icon from the same
  geometry replacing `media/kete.svg`.
- **Header:** small mark + "Kete Code" wordmark ("Kete" primary, "Code" secondary), centered.
- **Empty state:** 84px hero mark with a one-time weave-in animation (none under
  `prefers-reduced-motion`); the tip line with keycap `kbd`s; dismissible notice cards whose content
  comes from the host (the extension in VS Code; none or server-provided in the browser).
- **Footer:** a dismissible CLI hint; the composer — auto-growing textarea, voice, add-context (+),
  slash commands (/), model pill (name + effort; effort hidden under 380px), the Auto/Ask/Plan toggle,
  send (disabled until input; Enter sends, Shift+Enter newline). Composer border 1px brand with a 3px
  ring at 12% (24% on focus-within); idle send brand at ~38%, active solid. Existing web-app
  behaviour behind these controls is reused (model picker from the web app's own model list, not a
  new Gateway client in the extension).
- **Bridge (VS Code):** new allowlisted messages for notices (host → frame: the notice list;
  frame → host: dismiss) with dismissed IDs persisted in `context.globalState`; the CLI-hint dismissal
  likewise; the platform for the tip. Types shared and validated on both sides (`chat.ts` allowlists,
  `packages/app/src/kete/vscode-messages.ts`).
- **Accessibility:** usable from 300px width; everything keyboard-reachable with visible focus rings;
  icon buttons have aria-labels.
- **CSP:** the extension wrapper keeps a strict nonce CSP; the web app loads no remote resources.

## Out of scope
- The active conversation view (timeline, tool calls), except where it shares the composer.
- A runtime Plan permission mode; Ctrl+K bindings; a Gateway model client in the extension.
- Runtime, CLI and server code.

## Acceptance criteria
- [ ] AC1: The empty state and composer render per the mockup in Dark+, Light+ and a high-contrast
  theme (VS Code), and in the browser UI (light/dark).
- [ ] AC2: 300px width is usable; under 380px the effort label is hidden.
- [ ] AC3: Keyboard: every control reachable, visible focus rings, aria-labels on icon buttons;
  Enter sends, Shift+Enter newlines; send disabled when empty.
- [ ] AC4: Dismissed notices and the CLI hint stay dismissed after a VS Code reload (globalState).
- [ ] AC5: The mode toggle cycles Auto → Ask → Plan and sets the session's permission mode or agent.
- [ ] AC6: No CSP violations; no remote requests (fonts bundled).
- [ ] AC7: Tests for the bridge message handling and notice persistence; app `typecheck` and
  `test:unit`; extension `typecheck` and `test`; `bun run lint`; `upstream:check`.

## Risks and constraints
- `packages/app` is largely upstream: restyling it must stay within Kete-owned components/CSS
  (`src/kete/`) or minimal marked edits (upstream-guard reviews).
- The web app is shared with the browser UI; the design must work without the VS Code host.
- Commits in small steps as the brief asks (tokens and logo; UI; bridge and persistence; keybinding
  and manifest).
