# Result: Chat panel design: empty state and composer (web app, VS Code host)

## What changed
- Brand: `assets/brand/` (logos; Bricolage Grotesque 600 woff2 with its OFL licence) as the single source; brand colour `#6E47F5` / soft `#A38CFA` in `packages/ui` theme and `packages/app/src/kete/tokens.css`.
- Web app (`packages/app/src/kete/`): `mark.tsx` (the logo, one geometry for every surface), `panel.tsx` (header, hero, tip, notices, CLI hint), `panel-layout.tsx` (scroll area above a pinned composer, 680px column), `composer-controls.tsx` and `mode.ts` (Auto → Ask → Plan: `kete.permissionMode` default/ask; Plan switches to the plan agent), `panel-state.ts`, `vscode-messages.ts`, `fonts.ts`, `panel.css`.
- Extension (`packages/kete-vscode`): `panel.ts` (notices and CLI hint, dismissals in `globalState`), bridge messages `kete.panel` / `kete.dismissNotice` / `kete.dismissCliHint`; the Kete mark on the activity bar, every command button, the status bar (`$(kete-mark)` icon font from `script/icon-font.ts`, fantasticon 4.1.0), terminal tabs and the chat editor tab; banner `#6E47F5`.
- Upstream, marked and recorded in `docs/upstream-patches.md`: `app/src/new-session/view.tsx`, `composer/composer.tsx`, `composer/editor/editor.tsx`, `new-session/composer-adapter.ts`, `settings/about/about.tsx`, `app/index.html`, `client/src/solid/data.ts` (optional `metadata` on session create).
- `assets/brand/` and `docs/jobs.md` Kete-owned for `upstream:check`.

## Checks
| Check | Result |
|---|---|
| app typecheck, `test:unit` | PASS (986) |
| extension typecheck, test, build | PASS (94) |
| client typecheck, new test | PASS (4 pre-existing failures unchanged) |
| `bun run lint`, `upstream:check` | PASS |
| `verify --base main` | PASS (no new failures) |
| Rendered check (browser, dev.22) | header, centered logo, pinned composer confirmed |

Reviews: reviewer — approve; upstream-guard — approve.

## Acceptance criteria
- [x] AC1 — rendered in the browser UI (light); VS Code themes checked by the user in progress.
- [x] AC2 — `panel.css` 300px/380px rules (manual check pending).
- [x] AC3 — aria-labels, focus-visible, Enter/Shift+Enter unchanged.
- [x] AC4 — `panel.test.ts` (globalState persistence).
- [x] AC5 — `mode.test.ts`, `session-create-metadata.test.ts`.
- [x] AC6 — font and assets bundled; no remote URLs (`tokens.test.ts`).
- [x] AC7 — the checks table.

## Known differences from the mockup (follow-up)
- A divider line inside the composer with stray marks at its ends.
- OpenCode's project/branch row under the composer.
- Placeholder text differs from "Ask Kete, or type / for commands".
- In the browser the tip and notices don't show (VS Code only, D4); page background keeps the theme (D2); no voice button (D3); weave-in timing is a judgement (~0.7 s).
- `new-session/wordmark.tsx` is unused (cleanup).

## Cards updated
New `web-app` card (INDEX); vscode-extension, permissions, roles-skills, ui-branding, server-sdk, kete-tools-ci.

## Metrics
- Agents used: scout, planner (×2), implementer (×4), reviewer, upstream-guard, librarian
- Scout lookups: 6, docs enough: 3 (50%)
- Tokens / cost (from /usage): ~1.7M subagent tokens
- Time: ~1 day
