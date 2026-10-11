# Plan: Terminal UX parity with Codex CLI

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Size: Large.** This plan edits upstream files (`tui/src/config/index.tsx`, `tui/src/component/prompt/index.tsx`,
> `tui/src/plugin/builtins.ts`) and adds a user-facing config key (`statusline`, a contract). The approval this
> needs is **already given**: on 2026-10-10 the maintainer approved the spec (all six phases; D1 (a), D3 (a)) and
> authorised building Milestone A end to end, merging when green.
>
> **Differs from the spec (reviewer, please confirm):** the spec says P1 renders through the
> `prompt.footer.status` slot "so the prompt component itself is not edited". That doesn't work, for two reasons.
> (1) Content added to that slot sits beside the prompt's own `flexGrow` location box
> (`component/prompt/index.tsx:1847-1911`, `plugin/render.tsx:85-135`). So the status line can't remove the
> existing `directory:branch` label, which would show twice next to the `directory`/`branch` items and break AC1/AC2
> ordering. It also can't get a stable width to drop items without wrapping (AC2). (2) The slot input
> (`plugin/src/tui/context.ts:159-163`) doesn't include the prompt-local state the label uses: pending directory,
> worktree move, idle/running. So P1 makes **one small marked edit** to the prompt (CLAUDE.md §4 step 5): the status
> line's row is rendered where the location label is today, and after the running spinner. All the logic stays in
> Kete-owned `tui/src/kete/statusline*.ts(x)`. The `/statusline` command is a builtin plugin, so `app.tsx` isn't
> edited.

## Scope of this revision: P1 only (plan item A1)

This revision covers **P1, the configurable status line**: AC1, AC2, AC3, and the parts of AC13 that apply to
P1. **P2–P6 each get their own plan revision** once P1 is merged, so later phases start from cards that reflect P1.

## Cards read
- docs/context/modules/ui-branding.md (verified-at 006573bd58, stale: no)
- docs/context/modules/config-kete.md (verified-at current, stale: no)
- docs/context/modules/permissions.md (verified-at 006573bd58, stale: no)
- docs/context/modules/sandbox.md (stale: no)
- docs/context/modules/todo.md (stale: no)
- docs/context/modules/local-models.md (stale: no)
- docs/context/modules/gateway.md (stale: no)
- docs/context/modules/web-app.md (stale: no; P1 only reuses the mode labels)
- docs/context/pitfalls.md, decisions.md, commands.md

## Design (fixed by this plan)
- **Where the setting lives (D1 a):** the TUI config schema `Info` (`tui/src/config/index.tsx:66`), key `statusline`:
  `{ items?: string[], colors?: boolean }`. On disk this is the CLI's **`cli.json`** in the global config directory
  (`packages/cli/src/config/config.ts:31`; `cli/src/config/schema.ts` spreads `Config.Info.fields`). The spec calls
  it `tui.json`, but that is the legacy name and gets migrated into `cli.json`. The schema itself lives in Kete
  code (`tui/src/kete/statusline-config.ts`); `index.tsx` gets one import line and one field, both marked.
- **`items` is `Schema.Array(Schema.String)`, not a literal union, on purpose.** The CLI loader decodes the whole
  file with `decodeUnknownOption` (`cli/src/config/config.ts:22,65`). One invalid value therefore silently throws
  away **every** setting in `cli.json`. Unknown IDs are found by `KeteStatusLineConfig.parse` and reported as a
  warning toast. They are never dropped silently (AC2).
- **Item IDs** (`ITEMS`, in order): `directory`, `branch`, `mode`, `context`, `model`, `sandbox`, `balance`, `todo`,
  `local-model`, `cost`. `cost` = the session's spend so far, from the same source as upstream's prompt footer
  (`props.context.data.session.cost(sessionID)`, `feature-plugins/prompt/footer.tsx:43-46`, formatted the same way;
  hidden when 0); added by the maintainer's parity plan item A1 (2026-10-10). **Default** `["directory", "branch", "mode", "context"]`. `colors` defaults to `true`.
  Duplicates are removed (the first one wins).
- **What each item shows** (it hides when its value is unknown):
  - `directory`: home-abbreviated path, with the click menu the location label has today (copy, open, workspaces).
  - `branch`: `data.location.vcs.info(location)?.branch.current`.
  - Both `directory` and `branch` hide while the session isn't idle, as upstream's label does today.
  - `mode`: `KetePermissionModes.label[current ?? "default"]`, from `useKetePermissionMode()`.
  - `context`: `${100 - percent}% left`, where `percent` comes from `contextUsage(...)`, using the same inputs as
    `feature-plugins/prompt/footer.tsx:36-41`.
  - `model`: model plus variant, from `useLocal()`.
  - `sandbox`: today's `label(status)`.
  - `balance`: the credit text from `balance.tsx`'s `account()`.
  - `todo`: `footerLabel(todos)`.
  - `local-model`: "Offline", via `offlineFrom`.
- **Security pin:** the `sandbox` warning ("Unsandboxed …") **always shows** when it applies, even if `sandbox` isn't
  in the list (it isn't in the default list). If listed, it appears at the listed position; otherwise it goes last.
  It is never dropped for width while any other item is left. Hiding it by default would quietly weaken a security
  signal (CLAUDE.md §9).
- **Fitting:** items are joined with `" · "` and drop from the end until `stringWidth` fits the row's measured
  width, with `wrapMode="none"`. The row is a `flexGrow={1} flexShrink={1} minWidth={0}` box that measures itself
  with `onSizeChange`. Its width doesn't depend on its content, so the measurement can't oscillate.
- **Colours** (`colors: true`):
  - `mode` uses the warning colour for Plan and Ask and the accent colour for Auto.
  - `context` uses the warning colour at ≤ 20 % left and the error colour at ≤ 5 %.
  - `branch` uses the accent colour.
  - Everything else is `text.muted`.
  - With `colors: false` everything is muted, except the sandbox glyph, which keeps the warning colour.
- **Slots after P1:** `sandbox-status.tsx` and `local-status.tsx` keep their `home.footer.status` claims (the home
  footer row is unchanged). Their `prompt.footer.status` claims, and `todo.tsx`'s, are removed, because those are
  now status line items. Behaviour change: todo progress and "Offline" no longer show by default; users add `todo`
  or `local-model`. Record this in the user doc.
- **Kept as is (noted, not changed in P1):**
  - The prompt's metadata row still shows a non-default permission mode next to the agent (`metadata.tsx`, an
    existing marked edit). D3 keeps the agent there.
  - Upstream's `prompt.footer` plugin still shows `tokens (n%) · $cost` on the right.
  - Both overlap with `mode`/`context`; the real-terminal check decides whether a follow-up should remove one.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/tui/src/kete/statusline-config.ts` | create | Effect schema `KeteStatusLineConfig` (`items`, `colors`), `ITEMS`, `DEFAULT_ITEMS`, labels/descriptions, `parse(config) → { items, unknown, colors }`, pure picker helpers `toggle`, `move`, `reset`, and `save(items, colors) → (draft) => void` (keeps unknown IDs, writes only `statusline`). No Solid imports. |
| `packages/tui/src/kete/statusline.tsx` | create | `fit(items, width)` (pure; sandbox pinned), `StatusLineView` (pure render from `{id, text, tone}[]`), `KeteStatusLineRow` (collects items through app hooks and measures its width), and the default-exported builtin plugin `kete.statusline`: the `/statusline` command (palette "Configure status line", group "System"), the picker dialog, and the unknown-ID warning toast. |
| `packages/tui/src/config/index.tsx` | change (upstream, marked) | Import `KeteStatusLineConfig` and add `statusline: Schema.optional(KeteStatusLineConfig)` to `Info` (`:66`). `resolve` passes it through with `...input`; no `Resolved` change. |
| `packages/tui/src/component/prompt/index.tsx` | change (upstream, marked) | The `kete_change start/end` block in the idle `Match` (`:1892-1909`) renders `<KeteStatusLineRow>` in place of the location `<text>`; `props.hint` keeps priority. One marked line puts the row after `<PromptInterruptStatus/>` in the running `Match` (`:1858-1872`). Read `:1600-1625` (`footerLocation`, `pendingDirectory`, `locationActions`) to pass `location` and `actions`. Nothing else in the file changes. |
| `packages/tui/src/plugin/builtins.ts` | change (upstream, marked) | Import and list `KeteStatusLine` next to the other Kete entries. |
| `packages/tui/src/kete/sandbox-status.tsx` | change | Remove the `prompt.footer.status` claim (`:56`); keep `home.footer.status`. Export what the item needs (`fetchSandboxStatus` and `label` already are). |
| `packages/tui/src/kete/local-status.tsx` | change | Remove the `prompt.footer.status` claim; keep `home.footer.status`. |
| `packages/tui/src/kete/todo.tsx` | change | Remove the `prompt.footer.status` claim (`:134-137`). Narrow `useTodos`'s parameter to `Pick<Plugin.Context, "client" \| "data" \| "location">` so the row can call it with `useClient().api`, `useData()` and `useLocation().ref`; these are what the plugin context is built from (`plugin/api.tsx:136-142`). |
| `packages/tui/src/kete/balance.tsx` | change | Export a `balanceText(metadata)` formatter that `KeteBalance` also uses, so the sidebar and the item agree. |
| `packages/tui/src/kete/permission-mode.tsx` | read | `useKetePermissionMode()`, `KetePermissionModes` labels. |
| `packages/tui/src/kete/local-models.ts` | read | `offlineFrom`, `KeteLocalPicker.offlineLabel`. |
| `packages/tui/src/util/session.ts` | read | `contextUsage` (`:58`). |
| `packages/tui/src/feature-plugins/prompt/footer.tsx` | read | How `contextUsage` gets its inputs (`:36-41`); `stringWidth` import. |
| `packages/tui/src/feature-plugins/sidebar/footer.tsx` | read | The pattern for `useWorkingDirectoryActions` and the `directory:branch` lookup from a plugin (`:79-92`). |
| `packages/tui/src/ui/working-directory-actions.tsx` | read | The `actions` object the prompt passes (hover, mouse handlers). |
| `packages/tui/src/feature-plugins/system/stats.tsx` | read | How a builtin plugin registers a slash and palette command (`:184-212`, `append: "app"` + `context.keymap.layer`). |
| `packages/tui/src/component/dialog-config.tsx` | read | The `DialogSelect` and `config.update` pattern for a settings picker that stays open (`:355-385`). |
| `packages/tui/src/config/index.tsx` `useConfig` (`:337-371`) | read | `data.statusline` and `update`; the file watcher reapplies config edited outside the TUI. |
| `packages/plugin/src/tui/context.ts` | read | `Dialog`/`DialogSelectOptions` (`:327-381`), toast, `Plugin.Context`. |
| `packages/plugin/src/tui/context.ts` slot docs (`:185-215`) | read | Background only; no change (the slot API stays as it is). |
| `packages/cli/src/config/config.ts`, `packages/cli/src/config/schema.ts` | read | How `cli.json` is loaded and updated, and why the schema stays lenient. |
| `packages/tui/test/kete/statusline.test.tsx` | create | AC1, AC2, AC3 (tui side): see Verification. Render pattern from `test/kete/balance.test.tsx`. |
| `packages/tui/test/kete/balance.test.tsx` | read | `testRender` and fake-context pattern. |
| `packages/tui/test/kete/todo.test.tsx`, `sandbox-status.test.ts`, `local-models.test.tsx` | read / change if needed | Remove any assertion that relies on the removed `prompt.footer.status` claims. |
| `packages/cli/test/kete/statusline-config.test.ts` | create | AC3 store side: round trip through the real `Config.layer` (pattern: `packages/cli/test/config.test.ts:1-60`, `run()` helper, `./fixture/tmpdir` → `../fixture/tmpdir`). |
| `packages/cli/test/config.test.ts` | read | The test harness above. |
| `docs/upstream-patches.md` | change | New section "Status line (feature/status-line)": the three upstream files with the reason for each, the spec deviation, and the sync checklist (the prompt's idle/running `Match` blocks, `Info`). |
| `docs/statusline.md` | create | Short user guide: items, default, `cli.json` example, `/statusline`, `colors`, the sandbox pin, and that todo/Offline must now be added. There is no root CHANGELOG; this doc and the PR body carry the change note. |

## Steps
1. **Config schema.** Create `tui/src/kete/statusline-config.ts`:
   - `ITEMS`, `DEFAULT_ITEMS`, labels.
   - `KeteStatusLineConfig = Schema.Struct({ items: optional(Array(String)), colors: optional(Boolean) })`, with
     `annotate` descriptions in the style of `Info`.
   - `parse(value)` returns known IDs in order (deduped), the `unknown` list and `colors`. It falls back to
     `DEFAULT_ITEMS` only when `items` is absent; `[]` means no items.
   - The pure picker helpers and `save(...)`.

   Then add the two marked lines to `tui/src/config/index.tsx`.
2. **Row.** Create `tui/src/kete/statusline.tsx`:
   - `fit` and `StatusLineView` (pure).
   - `KeteStatusLineRow(props: { sessionID?: string; location?: LocationRef; actions?: ReturnType<typeof
     useWorkingDirectoryActions>; running?: boolean })`. It collects each listed item through `useConfig`,
     `useData`, `useClient`, `useLocation`, `useLocal`, `useTheme`, `useTuiPaths` and `useKetePermissionMode`.
     Sandbox status is fetched once per location, as `sandbox-status.tsx` does. Each item recomputes only from its
     own inputs: memos, no polling (spec Performance).
   - `directory` gets the hover and mouse handlers from `actions`.
3. **Plugin.** In the same file, `export default Plugin.define({ id: "kete.statusline" })`:
   - An `append: "app"` claim registers the `statusline.configure` command (`slash: { name: "statusline" }`,
     palette) through `context.keymap.layer`.
   - A `createEffect` on `parse(config.data.statusline).unknown` shows one warning toast per distinct unknown list,
     naming the IDs and the valid ones.
   - The picker (a `DialogSelect` that stays open, as in dialog-config):
     - one row per item, marked on or off;
     - choosing an off item appends it;
     - choosing an on item opens Hide / Move earlier / Move later;
     - plus "Colours: on/off" and "Reset to default".
   - Each change calls `config.update(save(...))`. Errors go to `toast.error` and are never swallowed. Register the
     plugin in `builtins.ts` with a marked line.
4. **Prompt hook.** In `component/prompt/index.tsx`, inside the idle `Match`, replace the location `<Show>` body
   with a `kete_change start/end` block. It renders `props.hint` when set, otherwise `<KeteStatusLineRow
   sessionID={props.sessionID} location={…same location as locationLabel()…} actions={locationActions} />`. Add one
   marked `<KeteStatusLineRow running sessionID={props.sessionID} />` after `<PromptInterruptStatus/>`. Add the
   import line, marked. Keep `locationLabel`/`locationLabelDisplay` only if other code still uses them; if they
   become unused, delete them inside the marked block rather than leaving dead code, and say so in
   `upstream-patches.md`. Don't reformat anything else.
5. **Move the old indicators.** Remove the `prompt.footer.status` claims from `sandbox-status.tsx`,
   `local-status.tsx` and `todo.tsx`. Narrow `useTodos`'s parameter. Add `balanceText` to `balance.tsx`.
6. **Tests.**
   - Create `tui/test/kete/statusline.test.tsx`.
   - Create `cli/test/kete/statusline-config.test.ts`.
   - Adjust any existing Kete TUI test that relied on the removed claims.
7. **Docs.** Add the `docs/upstream-patches.md` section and `docs/statusline.md`.
8. **Checks.** Run the Verification table top to bottom, then build the binary and check it in a real terminal:
   - default row at 100, 60 and 40 columns;
   - `/statusline` toggles and reorders, and `cli.json` changes;
   - an unknown ID shows the warning toast;
   - Unsandboxed still shows with `kete.sandbox` off;
   - the running state shows the spinner, the interrupt hint and the items;
   - clicking the directory opens the working-directory menu.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1: default row shows directory, branch, mode and context at 100 columns; context % matches `contextUsage` for a fixture session | `cd packages/tui && bun test ./test/kete/statusline.test.tsx -t "default"`. Tests: (a) `parse(undefined)` gives `DEFAULT_ITEMS`; (b) the context item for fixture messages and models equals `100 - contextUsage(...).percent`; (c) a `testRender` of `StatusLineView` at width 100 with items from fixture inputs contains, in order, the directory, the branch, `Default` and `NN% left`. |
| AC2: configured order; unknown IDs reported; drop from the end at 60 and 40 columns, no wrap | `cd packages/tui && bun test ./test/kete/statusline.test.tsx -t "order\|unknown\|narrow"`. Tests: `parse({ items: ["context", "mode", "nope"] })` gives `["context", "mode"]` with unknown `["nope"]`; the plugin's warning text names `nope`; `fit` at 60 and 40 keeps a prefix, keeps the sandbox warning while it applies, and each rendered frame has the row on one line. |
| AC3: `/statusline` changes and persists the list | `cd packages/tui && bun test ./test/kete/statusline.test.tsx -t "picker"` (toggle, move and reset, then `save` applied to a draft with immer `produce`, as the store does), then `cd packages/cli && bun test ./test/kete/statusline-config.test.ts`. The CLI test uses the real `Config.layer` in a tmpdir: an update with a `statusline` draft is written to `cli.json`, read back by `get`, and leaves other keys and JSONC comments alone; a `cli.json` with an unknown item ID still decodes, and its other settings survive. |
| Regressions in the moved indicators | `cd packages/tui && bun test ./test/kete/todo.test.tsx ./test/kete/sandbox-status.test.ts ./test/kete/local-models.test.tsx ./test/kete/balance.test.tsx ./test/kete/permission-mode.test.tsx`; `cd packages/cli && bun test ./test/config.test.ts` |
| AC13 (P1): typecheck and tests | `cd packages/tui && bun run typecheck && bun test` (known: 2 `dialog-shell-output` timeouts that `main` has too); `cd packages/cli && bun run typecheck && bun test ./test/kete` |
| AC13 (P1): lint | `bun run lint` (root) |
| AC13 (P1): upstream hygiene; every upstream edit in `docs/upstream-patches.md` | `bun run --cwd packages/kete-tools upstream:check`; `git grep -n kete_change -- packages/tui/src/config/index.tsx packages/tui/src/component/prompt/index.tsx packages/tui/src/plugin/builtins.ts` |
| AC13 (P1): before the PR | `bun run --cwd packages/kete-tools verify --base main` |
| AC13 (P1): built binary in a real terminal | `cd packages/cli && bun run build --single --skip-install --skip-web-ui`, then run `dist/cli-<os>-<arch>/bin/kete` through the checklist in step 8. |

No protocol or client regeneration: the TUI config isn't part of the server schema (config-kete card).

## Cards to update after the build
- `ui-branding`:
  - Quick answers on footer slots: `prompt.footer.status` no longer gets the sandbox, Offline or todo claims, and the status line is rendered by the prompt's marked hook.
  - The TUI config file is `cli.json`, and an invalid file is dropped whole.
  - Add the `tui/src/kete/statusline*` paths.
- `config-kete`: the `statusline` TUI key, with the lenient-schema reason.
- `permissions`: the TUI mode is now also shown by the status line's `mode` item.
- `sandbox`: the TUI warning on the prompt row comes from the status line (pinned); the home footer is unchanged.
- `todo` and `local-models`: footer progress and Offline are now the opt-in status line items `todo` and `local-model`.
- `gateway`: the `balance` item and `balanceText`.
- New Quick answers for every "Docs enough: no" gap in `handoff.md`.
