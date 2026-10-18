# Result: One first-run setup flow (A15)

## What changed
- `util/src/kete/setup.ts` (+ test): when to show, the rows, the sign-in URL parser, the `kete run` hint.
- `util/src/kete/local-picker.ts`: `pick` takes any provider ID (used for the gateway default).
- `tui/src/kete/setup.tsx`: `useKeteSetup()` (decision, `/setup`), the setup screen; each view (rows, sign-in, local) is its own dialog.
- `tui/src/kete/setup-login.ts` (+ test): `kete login` as a child; only the URL and a sanitised, bounded last stderr line are shown; 6-minute timeout; cancel kills it.
- `tui/src/kete/local-offer.tsx`, `local-models.ts`: the offer waits for the setup decision; `rediscover`.
- Upstream (marked, in docs/upstream-patches.md): `tui/src/feature-plugins/sidebar/footer.tsx`, `tui/src/component/prompt/index.tsx`, `cli/src/run/noninteractive.ts`, `tui/test/feature-plugins/sidebar-footer.test.tsx`, `tui/test/fixture/tui-client.ts`.
- `core/test/kete/setup-hint.test.ts`: pins the no-model error the hint matches.
- Docs: `.github/README.md`, `CHANGELOG.md`, `docs/local-models.md`, `docs/upstream-patches.md`, `docs/context/pitfalls.md`.

## Checks
| Check | Result |
|---|---|
| tui `bun run typecheck`, `bun run test` | pass; 1505 pass, 0 fail |
| util `bun test ./test/kete` | 417 pass, 0 fail |
| cli `bun test ./test/kete` | 412 pass, 0 fail |
| core `bun run test ./test/kete` | 1581 pass, 0 fail |
| root `bun run lint`, `upstream:check`, card-check | pass |
| AC7 binary: `kete run hi` with an empty HOME | prints the hint, exit 1 |
| `verify --base main` | see PR |

## Acceptance criteria
- [x] AC1 — `tui/test/kete/setup.test.tsx` (shows once; not when signed in or status unreadable).
- [x] AC2 — `ownKey` → `DialogIntegration` `onConnected` records done (code path; covered by review, no whole-app test of a real connection).
- [x] AC3 — `setup.test.tsx` "the local row lists the reachable server with its model count".
- [x] AC4 — `setup-login.test.ts` (URL only, cancel, timeout, failure line); row hidden offline (`KeteSetup.rows` test).
- [x] AC5 — `setup.test.tsx` Esc records done; `/setup` command registered.
- [x] AC6 — local offer waits for the decision; sidebar test expects `kete.setup`.
- [x] AC7 — binary run above; `setup-hint.test.ts`.
- [x] AC8 — checks above.

## Deviations (details in handoff.md)
- Views are separate dialogs (one component with a view signal was recreated on selection).
- The test fixture's default sync status is "signed in" instead of seeding `kete-setup` in `app.ts`.
- `parseLoginURL` accepts only a line that is just a URL.

## Review
Spec review: approve (minors fixed: import spacing, cancel after the end does nothing, job-mode guard).
Security review of the sign-in child: no high/medium; fixed: the shown stderr line drops control
characters and is capped at 300 characters. Known, accepted: a TUI killed by SIGTERM/SIGKILL leaves the
`kete login` child until its own approval timeout; Esc inside the API-key dialog leaves setup unmarked
(it shows again next launch).

## Cards updated
local-models, account-login, cli, ui-branding; pitfalls.md (TUI fixture with no providers).
