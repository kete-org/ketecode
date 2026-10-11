# Plan: Terminal UX parity with Codex CLI

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Size: Large.** P2 edits four upstream files (`tui/src/config/keybind.ts`, `tui/src/config/index.tsx`,
> `tui/src/prompt/history.tsx`, `tui/src/component/prompt/index.tsx`) and changes a keybind default
> (`session.rename`), which is a user-facing contract. The approval this needs is **already given**: on 2026-10-10
> the maintainer approved the spec (all six phases; D1 (a), D2 (a), D3 (a)) and authorised building Milestone A end
> to end, merging when green.
>
> **Build agent:** a general-purpose agent with a shell. It runs every Verification command itself and reports
> real output; nothing here may be marked done unrun (the P1 implementer had no shell, see `handoff.md`).
>
> **Open question Q1 (blocks only the merge, not the build): `<leader>r` is already taken.** D2 says rename's
> default moves to `<leader>r`, but `session.redo` has defaulted to `<leader>r` since upstream v1
> (`tui/src/config/keybind.ts:191`). Both commands are bound in the **same** session layer
> (`routes/session/index.tsx:876,987,1282`), so the key would be ambiguous. Options:
> - (a) **recommended:** rename moves to `<leader>shift+r`, redo is unchanged (one contract change, upstream users
>   keep their redo key);
> - (b) rename takes `<leader>r` and redo moves to `<leader>shift+r` (two default changes);
> - (c) rename has no default key, only the palette and `/rename` (fails AC5 as written).
>
> Build with (a). The key is one constant (step 1), so a different answer is a one-line change. **Do not merge
> until the maintainer answers Q1.**

## Done: P1, configurable status line (plan item A1)
Built and merged in PR #37 (`f8030fdfb6`, review fixes `6414bbc386`): AC1–AC3 and the P1 part of AC13. The full P1
plan is in this file's git history (`git log -p -- docs/tasks/2026-10-10-tui-codex-parity/plan.md`). The upstream
edits are recorded in `docs/upstream-patches.md` ("Status line (feature/status-line)"); the user guide is
`docs/statusline.md`. P1 card updates (ui-branding, config-kete, permissions, sandbox, todo, local-models, gateway)
are still owed by the librarian at task close.

## Scope of this revision: P2 only (plan item A6)
**P2, prompt history search**: AC4, AC5 and the parts of AC13 that apply to P2. P3–P6 get their own revisions.

## Cards read
- docs/context/modules/ui-branding.md (verified-at 006573bd58, stale: no). It gives only the history file
  location (`prompt/history.tsx:63-71`); keybinds, the keymap layers and the prompt's history commands came from
  code (gaps logged in `handoff.md`).
- docs/context/modules/config-kete.md (stale: no). The TUI config is separate from the `kete` section; no protocol
  or client regeneration.
- docs/context/pitfalls.md, decisions.md, commands.md.

## Design (fixed by this plan)
- **Key.** A new keybind `prompt.history.search`, default `ctrl+r`, description "Search prompt history". Its
  command is registered in a prompt layer targeted at the textarea (`target: inputTarget`, `priority: 1`), like
  `prompt.history.previous` (`component/prompt/index.tsx:1011-1045`). So Ctrl+R searches only when the prompt has
  focus; with focus elsewhere it does whatever else is bound.
- **Rename (D2 + Q1).** `session.rename`'s default changes from `ctrl+r` to `<leader>shift+r` (Q1 (a)). The palette
  entry and `/rename` don't change (`routes/session/index.tsx:874-887`). The session list dialog's rename action
  uses the same binding (`component/dialog-session-list.tsx:281`), so it moves too. Check that in the real
  terminal.
- **A user override for rename still wins.** If the user's config sets `session.rename` and doesn't set
  `prompt.history.search`, `resolve()` removes from history search's default any key the user gave rename. (With
  the defaults, `ctrl+r` → `"none"`.) Without this, the targeted prompt layer would beat the user's Ctrl+R rename
  whenever the prompt has focus. If the user sets both explicitly, both are kept as written. The pure helper
  `keteHistorySearchKeys(overrides)` lives in `tui/src/kete/history-search.ts`; `config/index.tsx` calls it in
  one marked line, next to upstream's own default adjustment for `terminal.suspend` (`:283-292`).
- **Search model** (pure, `history-search.ts`):
  - It searches `usePromptHistory()` entries (capped at `MAX_HISTORY_ENTRIES` = 50, so cost is bounded),
    newest first.
  - Matching is a case-insensitive substring search on `entry.text`. An entry whose text equals one already
    returned in this search is skipped, so repeated Ctrl+R never shows the same text twice.
  - `find(entries, query, before?)` returns `{ index, entry, start, end }` or `undefined`. An empty query matches
    nothing.
  - `excerpt(text, start, end, width)` returns one line around the match (newlines shown as `⏎`) plus highlight
    offsets, measured with `stringWidth`.
- **UI** (`history-search.tsx`, inline, no dialog):
  - Ctrl+R opens a one-line search bar inside the prompt box, above the textarea: label `history search:`, an
    `<input>` for the query, then the match excerpt with the matched span in the accent colour, or
    `no match` (muted).
  - The textarea is **not changed while searching**, so Esc restores the draft exactly (text, parts, mode, cursor).
  - Keys while the bar has focus, in its own layer targeted at the bar's input with priority above the prompt's:
    - Typing refines the query and re-searches from the newest entry.
    - Ctrl+R (the configured `prompt.history.search` keys) finds the next older match. At the oldest match it
      stays put and shows `no older match`.
    - Enter accepts the match. It is applied the way history ↑ applies one: `ref.set(clone)` plus
      `setStore("mode", entry.mode ?? "normal")`, with a cloned entry so the history store isn't aliased. The bar
      closes and the cursor goes to the end. Nothing is submitted.
    - Enter with no match closes the bar like Esc.
    - Esc and Ctrl+C close the bar and leave the draft as it was.
  - The bar closes by itself when the prompt becomes `disabled()` (a permission or question prompt appears) or
    the prompt unmounts.
- **Focus.** While the bar is open, the prompt's focus effect (`component/prompt/index.tsx:729-741`) treats the
  textarea like it does when a dialog is open: blur it and make it non-focusable. When the bar closes, the effect
  runs again and gives focus back to the textarea. This is one marked condition.
- **History access.** `usePromptHistory()` exposes only `move`/`append`, so a marked `entries()` accessor is added
  that returns the store's array (read-only). Nothing else in `history.tsx` changes; `move`'s index isn't touched
  by a search.
- **Mini mode** (`tui/src/mini`) has its own composer and isn't in P2's scope.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/tui/src/kete/history-search.ts` | create | Pure: `find`, `excerpt`, `keteHistorySearchKeys(overrides) → overrides` (normalises string / comma list / array / `{ key }` values; compares lower-cased keys), `RENAME_DEFAULT = "<leader>shift+r"` exported for the keybind definition and tests. No Solid imports. |
| `packages/tui/src/kete/history-search.tsx` | create | `createKeteHistorySearch({ entries, disabled, onAccept })` → `{ active, open, close, query, match, older, accept }` (signals; no global state) and `KeteHistorySearchBar` (the row, its `<input>`, a `Keymap.createLayer` targeted at that input for Esc / Ctrl+C / Enter / older). Uses `useTheme`. |
| `packages/tui/src/config/keybind.ts` | change (upstream, marked) | Add `"prompt.history.search": keybind("ctrl+r", "Search prompt history")` after `prompt.history.next` (`:242`); change `session.rename`'s default (`:122`) to `RENAME_DEFAULT`. Import it, marked. |
| `packages/tui/src/config/index.tsx` | change (upstream, marked) | In `resolve` (`:283`), after the `terminal.suspend` block, one marked line: `Object.assign(keybinds, keteHistorySearchKeys(input.keybinds ?? {}))`; one marked import. |
| `packages/tui/src/prompt/history.tsx` | change (upstream, marked) | Add `entries(): readonly PromptInfo[]` to the returned object (`:73`), marked. |
| `packages/tui/src/component/prompt/index.tsx` | change (upstream, marked) | Marked import. A `kete_change start/end` block after the history layers (`:1011-1081`) creates the controller and a layer (`target: inputTarget`, `priority: 1`, enabled under the same condition as the history layers, with `!auto()?.visible`) with `{ id: "prompt.history.search", title: "Search prompt history", group: "Prompt", run: () => keteSearch.open() }`. One marked condition in the focus effect (`:731`). One marked `<Show when={keteSearch.active()}><KeteHistorySearchBar …/></Show>` inside the padded prompt box, just above the textarea. Nothing else changes. |
| `packages/tui/src/context/keymap.tsx` | read | `:230-270`: how a layer command's `id` picks up configured keys (`config.keybinds.get(id)`) and how `bind: false` and `bindings` work. Decides whether the bar's layer can reuse the id `prompt.history.search`. If keymap rejects or merges the duplicate name, use an internal id `kete.history.search.older` whose `bind` is the configured keys from `useConfig().data.keybinds.get("prompt.history.search")`. |
| `packages/tui/src/routes/session/index.tsx` | read | `:874-887` (rename command, palette), `:985-1000` (redo, Q1), `:1255-1285` (layers). No change. |
| `packages/tui/src/component/dialog-session-list.tsx` | read | `:281`: the rename action follows `session.rename`. No change. |
| `packages/tui/src/config/v1/keybind.ts` | read | `:99,304`: the v1 `session_rename` mapping. Confirm that migration copies only the keys a user set, not v1 defaults (otherwise migrated users would get an explicit `ctrl+r` and lose search). Report what you find in `handoff.md`. |
| `packages/tui/src/context/runtime.tsx` | read | Where `useTuiPaths().state` points in the app fixture, to seed `prompt-history.jsonl`. |
| `packages/tui/test/kete/history-search.test.ts` | create | Pure tests (AC4 logic, AC5 resolve). |
| `packages/tui/test/kete/history-search-prompt.test.tsx` | create | App-fixture tests (AC4 end to end, AC5 palette and keys). |
| `packages/tui/test/fixture/app.ts`, `test/clear-session.test.tsx`, `test/command-selection.test.tsx` | read | `createAppFixture`, `mockInput.typeText`/key presses, a session fixture with fetch handlers. |
| `packages/tui/test/prompt/history-provider.test.tsx` | read / change only if needed | History provider harness; must still pass. |
| `packages/tui/test/config-v2.test.tsx` | read / change only if needed | `decodeInfo` + `resolve` pattern (`:10`, `:200-210`); must still pass. |
| `docs/upstream-patches.md` | change (append a section; **use Edit, never Write**) | New section "Prompt history search (feature/history-search)": the four upstream files, why no seam works for each, and a sync checklist (history layers, focus effect, `resolve` keybind block, `Definitions`). |
| `docs/history-search.md` | create | Short user guide: Ctrl+R, the keys in the bar, that rename moved to `<leader>shift+r`, how to get Ctrl+R rename back (`"keybinds": { "session.rename": "ctrl+r" }` in `cli.json`, which turns history search's Ctrl+R off), and how to rebind search. There is no root CHANGELOG; this doc and the PR body carry the change note. |

Why no seam (for the patches doc):
- Keybind defaults exist only in `Definitions`.
- The override rule has to run where overrides are merged (`resolve`).
- History entries are private to the provider's store.
- The search must be a prompt-focused layer and render inside the prompt box. A slot claim can't target the
  textarea or take focus, and the plugin API has no prompt-history access.

## Steps
1. **Pure module.** Create `tui/src/kete/history-search.ts` (`find`, `excerpt`, `keteHistorySearchKeys`,
   `RENAME_DEFAULT`). Write `test/kete/history-search.test.ts` alongside it.
2. **Keybinds.** In `config/keybind.ts`, add `prompt.history.search` and change `session.rename`'s default to
   `RENAME_DEFAULT`, all marked. In `config/index.tsx`, add the marked import and the marked `resolve` line. Check
   `config/v1/keybind.ts` migration as noted in Files.
3. **History accessor.** Add the marked `entries()` to `prompt/history.tsx`.
4. **Bar.** Create `tui/src/kete/history-search.tsx`:
   - The controller creates signals per prompt instance.
   - A `createEffect` closes the bar when `disabled()` turns true; `onCleanup` closes it.
   - The bar's layer handles typing (via the input's `onInput`), older, accept, Esc and Ctrl+C.
   - Settle the duplicate-id question from `context/keymap.tsx` first.
5. **Prompt hook.** Add the marked import, controller, layer, focus condition and `<Show>` to
   `component/prompt/index.tsx`. `onAccept` = `(entry) => { ref.set(structuredClone(unwrap(entry)));
   setStore("mode", entry.mode ?? "normal") }`. Don't reformat anything else.
6. **Prompt tests.** Create `test/kete/history-search-prompt.test.tsx` with `createAppFixture`, a seeded
   `prompt-history.jsonl` and a session fixture.
7. **Docs.** Append the `docs/upstream-patches.md` section with Edit. Create `docs/history-search.md`.
8. **Checks.** Run the Verification table top to bottom. Then build the binary and check it in a real terminal
   (macOS Terminal and iTerm2; Windows Terminal if available, otherwise say it wasn't checked):
   - Ctrl+R in the prompt opens the bar;
   - typing highlights the match;
   - Ctrl+R walks older matches;
   - Enter fills the prompt without sending;
   - Esc leaves the draft, including an `@file` part, unchanged;
   - `<leader>shift+r` opens rename in a session and in the session list dialog;
   - with `"session.rename": "ctrl+r"` in `cli.json`, Ctrl+R renames and doesn't search;
   - `<leader>r` still redoes after an undo.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC4 logic: newest match first, repeat walks older, dedupe, case-insensitive, empty query and no match | `cd packages/tui && bun test ./test/kete/history-search.test.ts -t "find"` |
| AC4 in the prompt: Ctrl+R finds the newest match; Ctrl+R again is older; Enter puts it in the textarea, not submitted, mode restored for a shell entry; Esc leaves the typed draft unchanged | `cd packages/tui && bun test ./test/kete/history-search-prompt.test.tsx -t "search"`. Seed three entries (`"fix tests"`, `"build"`, `"fix lint"`); type the draft `"draft"`; press Ctrl+R and type `fix`; assert the bar shows `fix lint`; press Ctrl+R and assert `fix tests`; press Enter and assert the textarea text is `fix tests` and no prompt request was sent. Second test: same, then Esc; the textarea is `"draft"`. |
| AC5: rename at its new default, in the palette, and a user override wins | `cd packages/tui && bun test ./test/kete/history-search.test.ts -t "keys"`:<br>(a) `Definitions["session.rename"].default` is `RENAME_DEFAULT` and `prompt.history.search` is `ctrl+r`;<br>(b) `resolve(decodeInfo({ keybinds: { "session.rename": "ctrl+r" } }))` gives rename `ctrl+r` and search `[]`;<br>(c) both set explicitly → both kept;<br>(d) rename set to another key → search keeps `ctrl+r`.<br>Then `bun test ./test/kete/history-search-prompt.test.tsx -t "rename"`: in a session, the leader sequence opens the rename dialog; Ctrl+P, type "Rename", and "Rename session" is listed; with the `ctrl+r` override, Ctrl+R in the focused prompt opens rename and not the bar. |
| Regressions (history, config, keymap) | `cd packages/tui && bun test ./test/prompt/history.test.ts ./test/prompt/history-provider.test.tsx ./test/config-v2.test.tsx ./test/config.test.tsx ./test/keybind.test.ts ./test/keymap.test.tsx ./test/keymap-scope.test.tsx ./test/kete/statusline.test.tsx` |
| AC13 (P2): typecheck and tests | `cd packages/tui && bun run typecheck && bun test` (known: 2 `dialog-shell-output` timeouts that `main` has too; report anything else) |
| AC13 (P2): lint | `bun run lint` (root) |
| AC13 (P2): upstream hygiene; every upstream edit in `docs/upstream-patches.md` | `bun run --cwd packages/kete-tools upstream:check`; `git grep -n kete_change -- packages/tui/src/config/keybind.ts packages/tui/src/config/index.tsx packages/tui/src/prompt/history.tsx packages/tui/src/component/prompt/index.tsx` |
| AC13 (P2): before the PR | `bun run --cwd packages/kete-tools verify --base main` |
| AC13 (P2): built binary in a real terminal | `cd packages/cli && bun run build --single --skip-install --skip-web-ui`, then run `dist/cli-<os>-<arch>/bin/kete` through the step 8 checklist. |

No protocol or client regeneration: the TUI config isn't part of the server schema (config-kete card).

## Cards to update after the build
- `ui-branding` Quick answers:
  - prompt history search (`tui/src/kete/history-search*`, the prompt hook, `entries()` on the history provider);
  - where TUI keybind defaults live (`config/keybind.ts` `Definitions`) and how a layer command's `id` takes its
    configured key (`context/keymap.tsx`);
  - the `resolve` rule that a user's rename key wins over history search;
  - the rename default (`<leader>shift+r`, or whatever Q1 decides) and that `<leader>r` is redo.
- `config-kete`: TUI keybind overrides live in `cli.json` `keybinds`, and `resolve` adjusts defaults.
- Every "Docs enough: no" gap in `handoff.md` becomes a Quick answers line.
- Still owed from P1: the card updates listed in the P1 "Done" note above.
