# Handoff: Terminal UX parity with Codex CLI

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-10 planner (P1 only)
- Done: read INDEX, spec, and the `ui-branding`, `config-kete`, `todo` cards. Ran `stale-cards.mjs` on every card P1 relies on: `ui-branding`, `config-kete`, `todo`, `web-app`, `local-models` and `gateway` are current. **`permissions` and `sandbox` are STALE.** plan.md has NOT been written (it is still the template).
- Blocked: **the librarian must refresh `permissions` and `sandbox` first.** P1 needs both:
  - `permissions`: the `mode` item (D3) shows the permission mode. The card points at the TUI's existing mode status row in `tui/src/kete/permission-mode.tsx`, which P1 has to take over or reuse. Stale since `ad8739fb7a` (`core/src/kete/permission-mode.ts`, `core/src/permission.ts`, `core/src/plugin/internal.ts`; commits 3ccf873486, 0f5cf9baaa, e81d6b17f0).
  - `sandbox`: the `sandbox` item replaces the slot registrations in `tui/src/kete/sandbox-status.tsx`. Stale since `62cd364869` (12 files under `core/src/kete/sandbox*`, `cli/src/kete/sandbox.ts` and `schema/src/kete/sandbox.ts`; commits 8346d6e478, c984aedd29, 99eb663e49, 857306dda8, 7660d8ff94).
- Note for the refresh: the `permissions` card should also say where the TUI's mode status row registers (which slot, and from which `builtins.ts` line), so that P1 can fold it into the status line the same way as sandbox, local model and todo.
- Next: librarian refreshes both cards, then re-run `/task-plan` for P1.

## 2026-10-10 planner (P1 plan written)
- Done:
  - Re-ran `stale-cards.mjs` on ui-branding, config-kete, todo, web-app, local-models, gateway, permissions and sandbox. All are current.
  - Wrote `plan.md` for P1 only (A1; AC1–AC3 and the P1 part of AC13). The Large approval is recorded as given (maintainer, 2026-10-10).
- Decisions (in plan.md "Design"; the reviewer should confirm the first one):
  - **Departs from the spec: one marked edit to `component/prompt/index.tsx`.** The status line row replaces the location label in the idle branch and follows the spinner in the running branch. A `prompt.footer.status` claim can't hide upstream's `directory:branch` label or get a stable width, and the slot input lacks pending-directory, move and idle state.
  - `statusline.items` is `Array(String)` with Kete-side validation, because an invalid `cli.json` is dropped whole.
  - The sandbox warning is pinned and always shows. Todo progress and Offline become opt-in items.
  - The `/statusline` command is a builtin plugin, so `app.tsx` isn't edited.
- Docs enough: no — missing:
  - The TUI config file is `cli.json` (`packages/cli/src/config/config.ts:31`), not `tui.json`. The loader decodes it with `decodeUnknownOption`, so one invalid value drops every setting (`:22,65`).
  - How `Slot` places `append` claims beside the host's children (`tui/src/plugin/render.tsx:85-135`). Why a claim can't replace or resize the prompt's location box (`component/prompt/index.tsx:1847-1911`). Where the location label comes from (`:1600-1625`).
  - How a builtin plugin registers a slash command (`feature-plugins/system/stats.tsx:184-212`).
  - The plugin context's `data` and `client` are `useData()` and `useClient().api` (`tui/src/plugin/api.tsx:136-142`).
  - The settings picker pattern (`component/dialog-config.tsx:355-385`).
  - Upstream's `prompt.footer` plugin already shows context and cost (`feature-plugins/prompt/footer.tsx:36-45`).
  - There is no root CHANGELOG.
- Open questions (planner, continued below):
  - The parity plan's A1 also lists a `cost` item. The spec doesn't, so it is not planned.
  - The metadata row's mode label and upstream's context/cost footer overlap the new items. They are left as they are; the real-terminal check decides whether to follow up.

## 2026-10-10 implementer (P1, code written; NOT verified)
- Environment: this agent had no shell tool, so NO check was run (typecheck, tests, lint, upstream:check, binary build). Everything below is unverified.
- **Data loss to fix first:** I overwrote `docs/upstream-patches.md` with Write after reading only its tail, so it now holds only the new Status line section (22 lines). Restore with `git checkout -- docs/upstream-patches.md`, then append `/private/tmp/claude-501/-Users-magbotta-Development-kete-code/c8fae860-0ce2-4056-8c27-b3615be991e7/scratchpad/statusline-upstream-patches-section.md` to it.
- Files: created `tui/src/kete/statusline-config.ts`, `tui/src/kete/statusline.tsx`, `tui/test/kete/statusline.test.tsx`, `cli/test/kete/statusline-config.test.ts`, `docs/statusline.md`. Changed (upstream, marked) `tui/src/config/index.tsx`, `tui/src/component/prompt/index.tsx`, `tui/src/plugin/builtins.ts`. Changed (Kete) `sandbox-status.tsx`, `local-status.tsx`, `todo.tsx` (claims removed, `useTodos` narrowed), `balance.tsx` (`balanceText`).
- Decisions: the cli test imports `../../../tui/src/kete/statusline-config` relatively because `@opencode/tui` has no `./kete/*` export. The picker is plain `DialogSelect` via `useDialog().replace`; item menu (Hide/Earlier/Later) reopens the picker after each change. Prompt: removed `locationLabel`, `locationLabelDisplay`, `locationWidth` and the `abbreviateHome`/`truncateFilePath` imports as unused. `todo` item only loads todos when `todo` is listed.
- Not done: step 8 real-terminal checklist; card updates (librarian).
- Open: the types in `statusline.tsx` (`useTodos` argument, `Picker` option unions, `onSizeChange` this-type) are unchecked and may need small fixes.
