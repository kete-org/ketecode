# Handoff: WS1 work-orchestrator and Code|Work switch

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 planner
- Done: `plan.md` (about 30 files, 7 to create or change in app, 3 in core, 2 docs). Cards web-app, roles-skills, config-kete current.
- Decisions: the agent is its own plugin `kete.work-agent` (roles skip org users). The switch shows only on a
  draft route (session tabs have no directory) and hands the effective mode to `composer-adapter.ts` through a
  module-level map in `kete/mode-switch/state.ts`, because two `persisted()` instances of one key don't sync.
  Code sessions get no `kete.sessionMode` key, so nothing changes for Code users or older runtimes.
- Docs enough: no — missing: which workspace the global Kete sidebar belongs to, and that the draft tab
  (`shell/tabs/schema.ts:17-25`) is the only tab with a `directory` (session tabs have none).
- Docs enough: no — missing: how `persisted()` / `Persist.serverWorkspace` are used and that two instances of one
  key don't share state (`runtime/persistence/storage.ts:498-600`, `providers/models/selection.tsx:111-115`).
- Docs enough: no — missing: `data.session.create`'s `agent` is optional (`client/src/solid/data.ts:1645`), so a
  Work create can leave it to the runtime.
- Docs enough: no — missing: how Kete UI reads i18n keys (`useLanguage().t(key, {product})`,
  `desktop/src/renderer/kete/sidecar-status.tsx:14-16`); the sidebar view itself uses literal English.
## 2026-11-05 implementer
- Done: all plan steps 1-10 written. NO SHELL was available, so no check was run (typecheck, unit, component tests, lint, upstream:check all unrun).
- Files: core `kete/work-agent.ts`, `plugin/internal.ts` (marked), `kete/modes/work.jsonc` comment, `test/kete/work-agent.test.ts`; app `kete/mode-switch/{state.ts,state.test.ts,view.tsx,mode-switch.tsx}`, `kete/sidebar/{sidebar.tsx,view.tsx,sidebar.css}`, `new-session/composer-adapter.ts` and `runtime/i18n/en.ts` (marked), `kete/shell.stories.tsx`, `component-tests/kete-shell.spec.ts`; docs `upstream-patches.md`, `desktop-enhancement-plan.md`.
- Decisions: connector is `KeteModeSwitchConnector` (namespace `KeteModeSwitch` is the state module); `server` prop typed `string`; hint text is just "Not available yet" per unavailable mode; the Work-click test uses `click({force:true})` since Playwright refuses aria-disabled targets; the signed-in work-agent test only proves the plugin ignores the account (it takes no account option).
- Risks to check first: `createFields` generic vs `selection.agent`'s type; `Persistence.struct`/`optional` initial `{}` for `persisted`; `ctx.sdk.api` satisfying `Pick<OpenCodeClient,"rpc">`; `tab.type !== "draft"` narrowing in sidebar.tsx.
- Cards to update (librarian): roles-skills, web-app (add mode-switch paths), config-kete.
- Open question for the reviewer: the spec's "{{product}}" isn't used; the two new strings ("Mode", "Not
  available yet") don't name the product.
