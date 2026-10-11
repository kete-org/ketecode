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

## 2026-10-11 planner (P3, blocked on a stale card)
- Done: read INDEX, spec and handoff. Ran `node scripts/agent/stale-cards.mjs ui-branding config-kete web-app vscode-extension sync`. ui-branding, config-kete, web-app and sync are current. **`vscode-extension` is STALE** (verified-at `f85913ed4a`): `packages/kete-vscode/CHANGELOG.md` and `packages/kete-vscode/README.md` changed in `525f2ddbde` (0.2.6 changelog) and `1c8aa676b9` (task list docs). No source file under `packages/kete-vscode/src` changed since the card was verified.
- plan.md has NOT been revised for P3 (it still holds the P2 plan).
- Blocked: **the librarian must refresh `vscode-extension` first.** P3 needs it: the shared notice list moves out of (or is checked against) `packages/kete-vscode/src/panel.ts` `NOTICES`, so the card's account of the panel notices, dismissal storage (`kete.panel.dismissedNotices`) and how the extension bundles its sources is load-bearing. The change looks docs-only, so the refresh is likely a review plus a `verified-at` bump. While refreshing, please add to the card: how `panel.ts` decides each notice's condition (portal-synced agents, AGENTS.md present), and whether the extension's bundler (`packages/kete-vscode` build) can import a module from another workspace package (e.g. `@opencode/util` or a `packages/kete-*` package), which decides whether P3 shares one module or asserts equality in a test.
- Next: librarian refreshes `vscode-extension`, then re-run `/task-plan` for P3.

## 2026-10-11 planner (P3 plan written)
- Done: re-ran `stale-cards.mjs`. vscode-extension, ui-branding, config-kete, web-app and sync are current. `account-login` is stale (`cli-login.ts`, `commands.ts`); P3 doesn't rely on it, because "signed in" comes from the sync cache. `todo`, `local-models` and `gateway` are stale only because of P1's TUI edits (card updates owed); P3 doesn't rely on them. Rewrote `plan.md` for P3 only (A7; AC6, AC7, the P3 part of AC13). P1 and P2 are kept as Done notes.
- Decisions (plan.md "Design"):
  - The shared `packages/util/src/kete/notices.ts` (`KeteNotices.list`, `dismiss`, `segments`) is imported by `kete-vscode/src/panel.ts` (still unconditional) and the TUI.
  - portal-agents: a new `kete.sync` `status` RPC, registered in the sync plugin, returns `managedAgents` and `offline`.
  - agents-md: the existing `fs.list` endpoint at the location root.
  - Dismissals are in TUI storage `kete-notices`.
  - Tip: from `tui/src/kete/home-tips.ts`, picked once per launch, shown only when no notice is visible. Off with `tips: false` in `cli.json`; hidden under 12 rows (notices too).
  - Upstream edits: `routes/home.tsx` (there is no slot under the logo), `config/index.tsx` (`tips`), and the test fixture `tui-client.ts` (it throws on unknown requests).
- **Open question Q2 (blocks merge, not build):** the panel text says "Pick one with `/agent`" (web slash `app/src/kete/composer/commands.tsx:86`), but the TUI command is `/agents` (`tui/src/app.tsx:909`).
  - Plan builds with (a): one shared template, the agent command as its only parameter.
  - Alternatives: (b) show `/agent` in the TUI anyway; (c) reword the shared text.
  - The maintainer must confirm before merge.
- Docs enough: no — missing:
  - There is no slot under the home logo; `SlotMap` is at `plugin/src/tui/context.ts:191-202`, and `home.tsx` places `UpdateNotification` after the logo.
  - How a client could tell managed agents apart: nothing marks them on `Agent.Info` except the description suffix "Managed by <org>" (`core/src/kete/sync/plugin.ts` `apply`, ~`:480`), and no RPC exposed the sync cache.
  - Whether the runtime exposes AGENTS.md presence: only through `InstructionDiscovery` (`core/src/instruction-discovery.ts`, `config/plugin/instruction.ts`), not over HTTP. `fs.list` (`protocol/src/groups/fs.ts:47`) is the client-side route.
  - The TUI test fixture throws on unexpected requests (`tui/test/fixture/tui-client.ts:170`).
  - Plugin RPC registration pattern: `core/src/kete/sandbox.ts:327-330`.
  - Component-level keymap layers: `Keymap.createLayer` (`tui/src/context/keymap.tsx:402`).
  - TUI slash names differ from the web's: `/agents` vs `/agent`.
- Open: after `kete logout` the running server's sync cache may still report managed agents until the next sync or a restart; the builder checks this and adds `signedIn` if needed (plan Risks).

## 2026-10-11 main session
P3 Q2 resolved by checking the code: the web UI's agent command is `/agent` (`app/src/composer/commands.tsx:86`), the TUI's is `/agents` (`tui/src/app.tsx:909`). The shared template with the command as its one parameter is right; each surface passes its own.

## 2026-10-11 implementer (P3 built and checked)
- Done: P3 (A7) per plan.md, with Q2 (a) as resolved (panel `/agent`, TUI `/agents`).
  - Created: `util/src/kete/notices.ts` (`KeteNotices.list/IDS/dismiss/segments`) + `util/test/kete/notices.test.ts`; `schema/src/kete/sync.ts` (`KeteSyncRpc`); `tui/src/kete/home-notices.tsx` (`KeteHomeNotices`, `visibleNotices`, `fetchNoticeConditions`, `fitSegments`, `fitCount`); `tui/src/kete/home-tips.ts` (`TIPS`, `pickTip`); `tui/test/kete/home-notices.test.tsx`; `cli/test/kete/home-tips-config.test.ts`; `docs/home-notices.md`.
  - Changed (Kete): `kete-vscode/src/panel.ts` (`NOTICES = KeteNotices.list({ agentCommand: "/agent" })`, `Notice` re-exported, `dismiss = KeteNotices.dismiss`; panel still unconditional) + `test/panel.test.ts`; `core/src/kete/sync/plugin.ts` (registers `kete.sync` `status`); `core/test/kete/sync-fixture.ts` (new `rpc()` stub) and the four sync plugin tests that build a host (`agent-sync`, `agent-errors`, `policy-sync`, `skill-mcp-sync`: they now pass `rpc: rpc().host`, since the plugin registers an RPC and the default test host dies on `rpc.register`); `kete-tools/src/lib.ts` + `test/lib.test.ts` (`docs/home-notices.md`); `docs/upstream-patches.md` (new "Home notices and tips" section after "Prompt history search").
  - Changed (upstream, marked): `tui/src/routes/home.tsx` (import + `kete_change start/end` block on their own lines), `tui/src/config/index.tsx` (`tips`), `tui/test/fixture/tui-client.ts` (one line).
- **Logout question (plan Risks): the cache does survive a sign-out.** `KeteSync.sync` returns `signed-out` without touching anything, and the plugin's tick only calls `refresh` on `updated`/skills changes, so `state.cached` stays loaded in a running server after `kete logout` (until restart); `state.account` only updates on the next tick, which offline mode skips. So `status` also returns `signedIn`, read fresh from the account file on every call (`readAccount`; a file read, no OS key store), and the TUI requires `signedIn && !offline && managedAgents > 0`. Core test: deleting the account file flips `signedIn` to false at once while `managedAgents` stays 2. (Managed agents themselves also keep applying after logout until restart; that's existing sync behaviour, not changed here; worth a separate look.)
- Departures from the plan:
  - The fixture already answered `/api/fs/list` (upstream line ~108), so only the `kete.sync/status` line was added.
  - `KeteHomeNotices` takes no `width` prop: notices are truncated to `min(100, terminal width - 4)`, not the logo width. At the logo width (~57) the portal body (90 chars) lost its `/agents`; the block is one centered column with ✕ right after the title.
  - Short terminals: the column has `flexShrink` and measures its own height (`onSizeChange`); each notice has a fixed slot and only whole notices render (`fitCount`: 2 rows for the first, 3 after). Without this, a 20-row terminal showed a title with no body, and at exactly 12 rows notices pushed the prompt down. The first notice has no blank line above it (the home's 1-row gap is there already). Tip: 1 row.
  - `Status` has a third field, `signedIn` (above).
  - The palette command is enabled only while a notice is on screen, and dismisses exactly the notices on screen.
- Checks (all run): util typecheck PASS, `bun test ./test/kete` 291 pass; schema typecheck PASS; core typecheck PASS, `bun run test ./test/kete` 1438 pass / 12 skip / 0 fail; cli typecheck PASS, `bun test ./test/kete` 308 pass / 1 skip; tui typecheck PASS, full `bun run test` 1472 pass / 2 skip / 0 fail (no `dialog-shell-output` timeouts this run); home-notices 15 pass; regression set 73 pass; kete-vscode typecheck PASS, `bun run test` 114 pass, `bun run build` OK (bundle contains the shared text); app typecheck PASS, `test:unit` 1010 pass; kete-tools typecheck PASS, test 59 pass; root lint 0/0; `upstream:check` passed; `verify --base main` PASS, 0 new failures (core 30 known machine-dependent failures, same as main).
- Real terminal (built `dist/cli-darwin-arm64/bin/kete`, pty + pyte, xterm-256color; every run used a scratch `XDG_STATE_HOME`, so the user's real TUI storage was never written; the user's real config/account was used except where noted):
  - folder with `AGENTS.md`, 110x30: both notices showed (this account is signed in with synced agents, so the portal notice was checked live);
  - ✕ click (SGR mouse) dismissed the AGENTS.md notice; Ctrl+P "Dismiss home notices" dismissed the portal one; a tip appeared; `kete-notices.json` = `{"dismissed":["agents-md","portal-agents"]}`; after a restart on the same state, neither showed and a (different) tip did;
  - folder without `AGENTS.md`, fresh state: only the portal notice; with `KETE_OFFLINE=1`: no portal notice, a tip;
  - 110x11: nothing; 110x12: neither notice fits, so none shows and the prompt is unaffected (upstream's home already clips the prompt's bottom row at 12 rows, with or without this change);
  - temporary `XDG_CONFIG_HOME` (no account) via `kete --standalone`: a tip by default; none with `{"tips": false}` in its `cli.json`; with `AGENTS.md`, only the AGENTS.md notice (no account, no portal notice).
- Not checked live: `kete logout` while running (would sign the user out; covered by the core test). VS Code panel in VS Code (bundle and panel tests only).
- Note: SIGKILLing the TUI during server start left extra `kete serve --service` processes; cleaned up with the pkill and `rm ~/.config/kete/service-feature-home-notices.json` as instructed.
- Cards to update (librarian): as listed in plan.md, plus `sync`: `status` includes `signedIn` (fresh account read) and the cache-survives-logout finding; `ui-branding`: the whole-notice fitting rule.
- Docs enough: no — missing: the TUI test fixture already answers `/api/fs/list` (`tui/test/fixture/tui-client.ts` ~108); every test that builds the sync plugin through `test/plugin/host.ts` needs an `rpc` override now (`sync-fixture.ts` `rpc()`); `kete --standalone` runs the server in-process (no background service file), useful for pty checks with a temporary `XDG_CONFIG_HOME`.
