# Handoff: One first-run setup flow (A15)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-18 planner
Done: plan.md written (Large: five upstream edits — three runtime, two test). Cards read were current
(ui-branding refreshed to 41ddef7737 first).

Decisions (in plan.md "Decisions"): sign-in via a child `kete login` + `location.reload()`; mirrored
`selfCommand`; setup trigger inside `useKeteLocalModels()` so `app.tsx` is untouched; a failed
`kete.sync` status hides the screen; Esc counts as Skip; gateway default = first tool-capable `kete`
model; CLI hint matched on `provider.no-route` + message prefix, pinned by a core test.

Open questions for the user:
- "The local-model offer doesn't run when the setup screen has shown" vs "still runs when someone has
  set up but later gains a local model": planned as "skipped in the launch where setup showed; later
  launches follow its own `kete-local-offer` flag". Confirm.
- "Shows once": planned with Esc = Skip (records done). Confirm, or Esc leaves it to show next launch.
- A TUI attached to a remote server (`--server`): the child signs in on this machine, not the remote
  runtime. Planned: no special case (sign-in row still shown). Should it be hidden when not local?
- "Selects the default one": the gateway has no default-model notion in the cards; planned as the first
  tool-capable `kete` model in catalog order.

## 2026-10-18 implementer
Done: steps 1-8 written. NOT RUN: every check (this agent had no shell tool: no tests, typecheck, lint,
build, `upstream:check`, or AC7 binary run). All of it needs a run before review.

Files: util `kete/setup.ts` (+test), `kete/local-picker.ts` (`pick` takes string); tui `kete/setup.tsx`,
`kete/setup-login.ts`, `kete/local-offer.tsx`, `kete/local-models.ts` (`rediscover`); upstream edits in
`sidebar/footer.tsx`, `component/prompt/index.tsx`, `cli/src/run/noninteractive.ts`,
`test/feature-plugins/sidebar-footer.test.tsx`, `test/fixture/app.ts`; new tests `tui/test/kete/setup.test.tsx`,
`setup-login.test.ts`, `core/test/kete/setup-hint.test.ts`; docs README, CHANGELOG, local-models.md,
upstream-patches.md.

Decisions / deviations:
- `parseLoginURL` accepts only a line that is just a URL: `kete login` also prints "Signing in … at <platform URL>".
- Offline for hiding the sign-in row uses only `offlineFrom(flag, config)`, no extra `kete.sync` status call in the dialog (same source the runtime uses).
- Fixture: always uses `Global.layerWith({ state })`, with a temp state dir when the test gives none (removed on dispose); removed the unused `AppNodeBuilder` import. Plan said "seed with opt-out"; the temp dir was needed to have a place to seed.
- The line numbers in the plan for footer.tsx (:64) were :68 in the file; prompt edit matched.
- Child env: `KeteEnv.bridge` keeps inherited OPENCODE_* when the marker is set, so inheriting `process.env` is fine.
- Risk to check when running: import cycle local-offer -> setup -> dialog-model -> local-offer (only used lazily); `mockInput.pressArrow/pressEscape` names in setup.test.tsx; whole-app tests that relied on no explicit state dir.

Docs enough: no — missing: where `kete run` prints session errors (`cli/src/run/noninteractive.ts:482,491`) and that `ModelNotSelectedError` reaches clients as `provider.no-route` with its message only (`core/src/session/to-session-error.ts:56-64`) → cli card.
Docs enough: no — missing: the sidebar "Getting started" card dispatches `provider.connect` (`tui/src/feature-plugins/sidebar/footer.tsx:64`); the no-provider prompt toast opens `DialogIntegration` (`tui/src/component/prompt/index.tsx:320-328`); `provider.connect` is `/connect` (`tui/src/app.tsx:968-980`) → ui-branding or local-models card.
Docs enough: no — missing: how an app-shell hook registers a slash/palette command (`Keymap.createLayer`, `tui/src/kete/permission-mode.tsx:102-116`) vs a builtin plugin (`tui/src/kete/doctor.tsx:206-219`) → ui-branding card.
Docs enough: no — missing: the TUI test fixture answers no providers/models (`tui/test/fixture/tui-client.ts:150`), so any on-start dialog appears in every whole-app test → pitfalls.md.
Docs enough: no — missing: the TUI can't import the CLI's `selfCommand` (`cli/src/util/process.ts:5`); TUI model fallback is the first catalog model (`tui/src/context/local.tsx:181-206`); `/reload` is `location.reload` (`tui/src/app.tsx:1043`) → cli / local-models cards.

## Main session, 2026-10-18 (checks and fixes after the build)
- The implementer had no shell; the main session ran every check.
- Views were one component with an internal `view` signal; selecting a row recreated the dialog and reset it to the rows. Each view is now its own dialog component opened with `dialog.replace` (as upstream's dialogs do); the sign-in view starts `kete login` on mount and kills it on cleanup.
- Test fixture: instead of seeding `kete-setup` in `test/fixture/app.ts` (which missed tests that build the app themselves, 50 failures), the default `kete.sync/status` answer in `test/fixture/tui-client.ts` is signed in. Fewer upstream lines; `app.ts` is unchanged.
