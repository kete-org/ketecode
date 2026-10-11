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

## 2026-10-11 planner (P2 plan written)
- Done: re-ran `stale-cards.mjs` on ui-branding and config-kete (current). Rewrote `plan.md` for P2 only (A6; AC4, AC5, the P2 part of AC13). P1 is kept as a "Done" note (PR #37); its full plan is in git history. The build agent is a general-purpose agent with a shell.
- Decisions (plan.md "Design"):
  - Ctrl+R is a new keybind `prompt.history.search`. It lives in a prompt layer targeted at the textarea, so it applies only when the prompt has focus.
  - The search bar is inline, above the textarea, with its own input. The textarea is never changed while searching, so Esc restores the draft exactly.
  - A user's explicit `session.rename` key removes the same key from history search's default in `resolve()`, so the override wins even inside the focused prompt.
  - A marked `entries()` accessor is added to the history provider.
- **Open question Q1 (blocks merge, not build): `<leader>r` is `session.redo`'s default** (`tui/src/config/keybind.ts:191`, upstream since v1), bound in the same session layer as rename (`routes/session/index.tsx:876,987,1282`). D2's `<leader>r` would collide.
  - Plan builds with (a) rename → `<leader>shift+r`, redo unchanged.
  - Alternatives: (b) swap, so redo moves to `<leader>shift+r`; (c) no rename key.
  - The maintainer must confirm before merge.
- Docs enough: no — missing:
  - TUI keybind defaults are `Definitions` in `tui/src/config/keybind.ts` (`session.rename` `:122`, `session.redo` `:191`, `prompt.history.*` `:241-242`). Overrides are merged in `config/index.tsx` `resolve` (`:283-292`).
  - A keymap layer command's `id` takes its configured keys from `config.keybinds.get(id)` (`tui/src/context/keymap.tsx:260-266`).
  - The prompt's history ↑/↓ are targeted layers at `component/prompt/index.tsx:1011-1081`. `usePromptHistory()` exposes only `move`/`append` (`prompt/history.tsx:73-112`), and history is capped at 50 entries.
  - Session commands (rename, redo) and their layers: `routes/session/index.tsx:874-887,985-1000,1255-1285`. The session list dialog reuses `session.rename` (`component/dialog-session-list.tsx:281`).
  - App-level TUI test harness: `test/fixture/app.ts` `createAppFixture` (`mockInput`, kitty keyboard).
- Open: whether v1 keybind migration copies v1 defaults (`config/v1/keybind.ts:99,304`). The builder checks this (plan Files).

## 2026-10-11 maintainer decision (relayed by the main session)
P2 Q1: rename's new default is `<leader>shift+r` (option a); redo keeps `<leader>r`.

## 2026-10-11 implementer (P2 built and checked)
- Done: P2 (A6) per plan.md, with Q1 (a): `session.rename` default `<leader>shift+r`, `session.redo` keeps `<leader>r`.
  - Created: `tui/src/kete/history-search.ts` (pure `find`/`excerpt`/`keteHistorySearchKeys`, `RENAME_DEFAULT`, `SEARCH_DEFAULT`), `tui/src/kete/history-search-bar.tsx` (controller + bar), `tui/test/kete/history-search.test.ts`, `tui/test/kete/history-search-prompt.test.tsx`, `cli/test/kete/history-search-migrate.test.ts`, `docs/history-search.md`.
  - Changed (upstream, marked): `tui/src/config/keybind.ts`, `tui/src/config/index.tsx`, `tui/src/prompt/history.tsx`, `tui/src/component/prompt/index.tsx`. Changed (Kete): `docs/upstream-patches.md` (new section after "Status line"), `kete-tools/src/lib.ts` + `test/lib.test.ts` (`docs/history-search.md` is Kete-owned).
- Decisions / departures from the plan:
  - The bar file is `history-search-bar.tsx`, not `history-search.tsx`: a `.ts` and `.tsx` with the same base name make `import "./history-search"` ambiguous (TypeScript resolves `.ts` first, Bun `.tsx`).
  - Duplicate id settled from `context/keymap.tsx` and `@opentui/keymap` (`collectActiveCommands`): the same command name in two layers is allowed (a chain; the first active layer is reachable). The bar's layer (targeted at its own input, priority 2) reuses `prompt.history.search`, so the configured keys walk older; while the bar has focus the prompt's textarea-targeted layer is inactive.
  - `find(entries, query, before?, skip?)`: `skip` is the set of texts already shown in this search (the dedupe).
  - Prompt test sessions use a random ID per test: the prompt's draft stash (`component/prompt/draft-stash`) is per session ID and module-global, so a fixed ID leaked one test's prompt into the next.
- v1 migration question (planner's open item): `cli/src/config/migrate.ts` `migrateV1` copies only the keybinds present in the user's v1 `tui.json` (`TuiKeybind.KeybindOverrides` fields are all `optional`, no defaults applied), and the in-place rename path rewrites only existing properties. So a migrated config never pins rename to v1's `ctrl+r` default; only a user who wrote `session_rename` in v1 gets an explicit override, which then (by design) takes Ctrl+R from search. Covered by `cli/test/kete/history-search-migrate.test.ts`.
- Checks (all run): tui `bun run typecheck` PASS; tui `bun run test` 1457 pass / 0 fail (1459 tests; the 2 `dialog-shell-output` timeouts did not appear this run); plan's narrow tests and regression set (68 pass); cli `bun run typecheck` PASS, `bun test test/kete` 306 pass / 1 skip / 0 fail; kete-tools typecheck PASS, `bun run test` 59 pass; root `bun run lint` 0 warnings/errors; `upstream:check` passed (first run flagged two JSX lines; fixed with `{/* kete_change start/end */}` on their own lines). `kete-tools verify --base main` NOT run.
- Real terminal (built `dist/cli-darwin-arm64/bin/kete`, pty + pyte, 110x30, xterm-256color; the user's existing history only, nothing submitted): Ctrl+R opened the bar; typing `audit` showed the newest match; Ctrl+R again showed `(no older match)` (only duplicates older); Esc closed it with the draft `hello draft` unchanged; a second run: `resume` matched, Enter put `RESUME_READY` in the prompt without sending; Ctrl+C in the bar closed it, prompt kept, app didn't exit. The session list dialog's footer shows `rename ctrl+x shift+r`. A legacy `R` parses as `shift+r` (`parseKeypress`), so `ctrl+x` then `R` works without the kitty protocol.
- Not checked in a real terminal: rename via `<leader>shift+r` in a session and in the session list (this channel has no sessions; creating one means submitting a prompt) — covered by the app-fixture test; the `cli.json` `"session.rename": "ctrl+r"` override (would mean editing `~/.config/kete/cli.json`) — covered by unit and app-fixture tests; `<leader>r` redo after undo (unchanged binding); iTerm2, macOS Terminal and Windows Terminal specifically (pty emulation only).
- Open: upstream's keybind docs (`packages/web/src/content/docs/*/keybinds.mdx`, `services/www/src/docs/content/cli/keybinds.mdx`) still list rename as `ctrl+r`; left unchanged as upstream's site (noted in upstream-patches).
- Docs enough: no — missing: `@opentui/keymap` allows the same command name in several layers (chains; first active layer wins), `node_modules/.bun/@opentui+keymap@*/src/index.js` `collectActiveCommands`; the prompt draft stash is module-global per session ID, so app-fixture tests sharing a session ID leak drafts.
