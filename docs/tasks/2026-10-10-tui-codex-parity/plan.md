# Plan: Terminal UX parity with Codex CLI

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Size: Large.** P3 edits two upstream files (`tui/src/routes/home.tsx`, `tui/src/config/index.tsx`) and one
> upstream test fixture (`tui/test/fixture/tui-client.ts`). It adds a TUI config key (`tips`, a user-facing
> contract) and a new plugin RPC (`kete.sync` `status`) on the existing `POST /api/rpc/:rpcID/:method` route, so
> no protocol or client regeneration. The approval is **already given**: the maintainer approved the spec on
> 2026-10-10 (all six phases) and authorised building Milestone A end to end, merging when green.
>
> **Build agent:** a general-purpose agent with a shell. It runs every Verification command itself and reports
> real output. Nothing may be marked done unrun.
>
> **Open question Q2 (blocks only the merge, not the build): the portal-agents notice names a command that
> differs by client.** The panel's approved text says "Pick one with `/agent`" (the web UI's slash command,
> `app/src/kete/composer/commands.tsx:86`), but the TUI's command is `/agents` (`tui/src/app.tsx:909`). Showing
> `/agent` in the TUI would point at a command that doesn't exist. Options:
> - (a) **recommended, built:** the shared module builds the list from one template, with the agent command as
>   the only parameter (`/agent` in the panel, `/agents` in the TUI). Every other character is shared, and a test
>   asserts it;
> - (b) both show `/agent` verbatim. The TUI text is then wrong;
> - (c) reword the shared body so it names no command (changes the panel's approved D5 text).
>
> The parameter is one argument at each call site, so a different answer is a one-line change. **Do not merge
> until the maintainer answers Q2.**

## Done: P1, configurable status line (plan item A1)
Built and merged in PR #37 (`f8030fdfb6`, review fixes `6414bbc386`): AC1–AC3 and the P1 part of AC13. The full P1
plan is in this file's git history (`git log -p -- docs/tasks/2026-10-10-tui-codex-parity/plan.md`). Upstream
edits: `docs/upstream-patches.md` "Status line (feature/status-line)". User guide: `docs/statusline.md`. P1 card
updates (ui-branding, config-kete, permissions, sandbox, todo, local-models, gateway) are still owed by the
librarian at task close. `todo`, `local-models` and `gateway` show as stale for that reason; P3 doesn't rely on
them.

## Done: P2, prompt history search (plan item A6)
Built and merged in PR #38 (`46c6831f58`): AC4, AC5 and the P2 part of AC13. Q1 was answered (rename's default
is `<leader>shift+r`; redo keeps `<leader>r`). The P2 plan is in git history. Upstream edits: `docs/upstream-patches.md`
"Prompt history search". User guide: `docs/history-search.md`. P2 card updates are owed at task close (see
`handoff.md`).

## Scope of this revision: P3 only (plan item A7)
**P3, new-session notices and tips**: AC6, AC7 and the parts of AC13 that apply to P3 (`packages/tui` and
`packages/kete-vscode`, plus `util`, `schema`, `core` and `cli`, which P3 also touches). P4–P6 get their own
revisions.

## Cards read
- docs/context/modules/vscode-extension.md (verified-at a6f140247e, stale: no). It says panel `NOTICES` is a
  fixed, unconditional list (`kete-vscode/src/panel.ts:19-30`). The extension already imports
  `@opencode/util/kete/brand` and bundles everything except `vscode`, so a shared module in
  `packages/util/src/kete/` works.
- docs/context/modules/ui-branding.md (stale: no). It covers the home screen layout (`routes/home.tsx`, the logo,
  the prompt at the bottom), the slot list (there is no slot under the logo) and the TUI storage used by
  `kete-local-offer`.
- docs/context/modules/sync.md (stale: no). The managed-agent cache is `state.cached`, and it loads only with a
  signed-in account outside job mode. Offline is `KeteOffline.active` (`core/src/kete/sync/plugin.ts:146`).
- docs/context/modules/config-kete.md (stale: no). The TUI config (`cli.json`) is not part of the server schema,
  so no regeneration.
- docs/context/modules/web-app.md (stale: no). The web UI renders backtick spans in notice text; P3 doesn't change
  the web UI.
- Not relied on: `account-login` (stale). "Signed in" comes from the sync cache instead: the cache loads only
  with an account.
- docs/context/pitfalls.md (JSX `kete_change` comments must sit on their own lines, `pitfalls.md:30-34`),
  decisions.md, commands.md.

## Design (fixed by this plan)
**Shared notice module** `packages/util/src/kete/notices.ts`, imported as `@opencode/util/kete/notices` and
exported as `KeteNotices`:
- `type NoticeID = "portal-agents" | "agents-md"` and `type Notice = { id, title, body, isNew? }`. The shape is
  the panel's current `Notice`.
- `list(input: { agentCommand: string }): readonly Notice[]` returns exactly today's panel text, with the
  portal-agents body built as `` `Agents you set up in the Kete Code Portal sync here automatically. Pick one
  with \`${agentCommand}\`.` `` (Q2 (a)).
- `IDS`: the notice ids.
- `dismiss(dismissed, id)` moves here unchanged from `panel.ts:44-48`: known ids only, deduped, capped at 50.
- `segments(body)` splits backtick spans into `{ type: "text" | "code", value }` for the TUI.
- No runtime-only `require` and no Node imports, so the extension bundle stays clean (vscode-extension card).
- Product names come from `Brand` where the text names the product. Keep the literal string identical to
  today's either way; the panel test checks it.

**Panel (no behaviour change).** In `kete-vscode/src/panel.ts`, `NOTICES` becomes
`KeteNotices.list({ agentCommand: "/agent" })`, and `Notice` and `dismiss` are re-exported from the shared
module. `panelState` and `loadPanelState` still show every notice not dismissed (no conditions; spec "Out of
scope"). `extension.ts` and `test/panel.test.ts` keep importing from `./panel`.

**Conditions (TUI only).**
- *portal-agents*: shown when the runtime has managed agents and isn't offline. The existing sync plugin
  (`core/src/kete/sync/plugin.ts`, Kete-owned) registers a new RPC `kete.sync` with method `status`, defined in
  the new `schema/src/kete/sync.ts` (`KeteSyncRpc`, modelled on `schema/src/kete/sandbox.ts`). It returns
  `{ managedAgents: number, offline: boolean }`, where `managedAgents` is `state.cached?.response.agents.length
  ?? 0` and `offline` comes from the plugin's existing `offline()`. Register it like `core/src/kete/sandbox.ts:327-330`.
  The cache loads only with a signed-in account (job mode is not interactive), so `managedAgents > 0` means
  "signed in with synced agents". No new HTTP endpoint and no protocol regeneration (same as `kete.todo` and
  `kete.sandbox`).
- *agents-md*: shown when the location's directory has a file named `AGENTS.md`. The TUI calls the existing
  `fs.list` endpoint (`protocol/src/groups/fs.ts:47`, promise client `client/src/promise/generated/client.ts:1562`)
  with no `path` (it defaults to the location directory) and looks for an entry `{ type: "file", path: "AGENTS.md" }`.
  This also works with `kete attach` to a remote server, because the TUI never reads the disk itself.
- Both are asked once per home mount and location, with a 15 s timeout like `fetchSandboxStatus`
  (`tui/src/kete/sandbox-status.tsx:16-25`). On error the notice is hidden and the error is logged at debug
  level; nothing is shown as success.
- Pure `visibleNotices({ notices, portalAgents, agentsMd, offline, dismissed })` decides what shows, so the
  conditions are unit-testable without a client.

**TUI component** `packages/tui/src/kete/home-notices.tsx`, `KeteHomeNotices`, rendered in `routes/home.tsx`
between `<UpdateNotification …/>` and the bottom spacer (one marked import, one marked JSX block):
- It renders the notices from `KeteNotices.list({ agentCommand: "/agents" })`, filtered by the conditions and
  dismissals. Each notice is at most two lines: the title in `theme.text.base` bold (with a "New" tag when
  `isNew`), then the body in `theme.text.muted` with code spans in the command colour that `home.tsx` already
  uses for `/update`. Each line is truncated to the logo width (no wrap) and ends with a clickable `✕` to dismiss.
- **Dismissal**: TUI storage `useStorage().store<{ dismissed: string[] }>("kete-notices", { initial: { dismissed: [] } })`,
  the same pattern as `kete-local-offer` (`tui/src/kete/local-offer.tsx:32`), updated through `KeteNotices.dismiss`.
  It persists in `<state>/<channel>/tui/kete-notices.json` across restarts.
- **Keyboard**: while the component is mounted it registers a global keymap layer through `Keymap.createLayer`
  (`context/keymap.tsx:402`; the same pattern as `history-search-bar.tsx`) with the command `kete.notices.dismiss`,
  "Dismiss home notices", `palette: true`, no default key. It dismisses every notice currently visible. So
  keyboard-only users can dismiss without a new binding.
- **Tip**: one line, `Tip: …`, below the notices, shown only when no notice is visible (one line of guidance at
  a time). It comes from `TIPS`, a short Kete-owned list in `tui/src/kete/home-tips.ts` (`/statusline`, `/mode`,
  `!` for a shell command, `@` to attach a file, Ctrl+R history search, `<leader>` keys via `/help`). Each tip
  names only commands that exist (`app.tsx:864,909,1099`, `permission-mode.tsx:111`, `statusline.tsx:410`).
  - Picked once per process with `useStorage().memory("kete-home-tip", { initial: { index: <random> } })`, so it
    stays the same across Home remounts in one launch and changes the next launch. No module-level mutable state.
  - Pure `pickTip(index, tips)`.
  - Off when TUI config `tips` is `false`. Hidden when terminal height is under 12 rows. Never more than one line
    (truncated to width).
- **Small terminals**: notices are also hidden under 12 rows, so the prompt keeps its space.
- **Config key** `tips: Schema.optional(Schema.Boolean)` ("Show a tip on the home screen", default on), one
  marked line next to `statusline` in `tui/src/config/index.tsx:244`. Old configs are unaffected.

**Upstream edits and why no seam works:**
1. `tui/src/routes/home.tsx`: the spec places the notices under the logo, and `SlotMap`
   (`plugin/src/tui/context.ts:191-202`) has no slot there (`home.footer` is the bottom row). Adding a slot path
   would change the plugin API contract, which is a bigger change than one marked JSX block in a file already
   carrying Kete edits.
2. `tui/src/config/index.tsx`: the TUI config schema is upstream's. The `tips` flag is a display setting like
   `animations` (the same reasoning as spec D1). One marked line.
3. `tui/test/fixture/tui-client.ts`: the fixture throws on any unexpected request (`:170`), so the home screen's
   two new requests need answers: `kete.sync/status` returns `{ managedAgents: 0, offline: false }`, and
   `/api/fs/list` returns an empty list in the location response shape. So existing home tests show no notices.
   Two marked lines, beside the existing `kete.*` lines `:167-169`.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/kete-vscode/src/panel.ts` | change (Kete) | `NOTICES` from the shared module; re-export `Notice` and `dismiss`; nothing else changes |
| `packages/kete-vscode/test/panel.test.ts` | change (Kete) | add: `NOTICES` deep-equals `KeteNotices.list({ agentCommand: "/agent" })` and still equals today's literal text |
| `packages/kete-vscode/src/extension.ts` | read `:52`, `:411-427`, `:604-612` | confirm that only `./panel` imports change nothing |
| `packages/util/src/kete/notices.ts` | create | the shared module (Design) |
| `packages/util/src/kete/brand.ts` | read | product name constant, if the text uses it |
| `packages/util/test/kete/notices.test.ts` | create | `list`, `dismiss` (moved cases), `segments`, the Q2 one-parameter difference |
| `packages/schema/src/kete/sandbox.ts` | read | RPC definition pattern |
| `packages/schema/src/kete/sync.ts` | create | `KeteSyncRpc`: `ID = "kete.sync"`, `Status` schema (`managedAgents` non-negative int, `offline` boolean), `Definition` with `status` |
| `packages/core/src/kete/sync/plugin.ts` | change (Kete) | register `KeteSyncRpc.Definition` next to the transforms (after `refresh` exists, `:186-215`) |
| `packages/core/src/kete/sandbox.ts` | read `:327-330` | `ctx.rpc.register(...).pipe(Effect.orDie)` pattern |
| `packages/core/test/kete/agent-sync.test.ts`, `packages/core/test/kete/sync-fixture.ts` | read; change the test | add: `status` reports the cached agent count, 0 with no cache, `offline: true` when offline |
| `packages/tui/src/kete/home-notices.tsx` | create | `KeteHomeNotices`, `visibleNotices`, `fetchNoticeConditions(client, location)` |
| `packages/tui/src/kete/home-tips.ts` | create | `TIPS`, `pickTip` |
| `packages/tui/src/kete/sandbox-status.tsx` | read `:1-40` | RPC call + decode + `createResource` pattern |
| `packages/tui/src/kete/local-offer.tsx` | read `:17-40` | `useStorage().store` / `.memory` usage |
| `packages/tui/src/kete/history-search-bar.tsx` | read | `Keymap.createLayer` from a component |
| `packages/tui/src/context/storage.tsx` | read `:1-80`, `:137-150` | storage API and file location |
| `packages/tui/src/context/keymap.tsx` | read `:168-275`, `:402-415` | layer shape (`commands`, `mode`, `palette`) |
| `packages/tui/src/routes/home.tsx` | change (upstream, marked) | import and render `KeteHomeNotices` under `UpdateNotification`; pass `logoWidth()` |
| `packages/tui/src/config/index.tsx` | change (upstream, marked) | `tips` key at `:244` |
| `packages/tui/test/fixture/tui-client.ts` | change (upstream, marked) | answer `kete.sync/status` and `/api/fs/list` (`:167-170`) |
| `packages/tui/test/kete/statusline.test.tsx`, `packages/tui/test/kete/logo.test.tsx` | read | render-test harness at fixed sizes |
| `packages/tui/test/session-home.test.tsx` | read | existing home test: must keep passing unchanged |
| `packages/tui/test/kete/home-notices.test.tsx` | create | AC6 and AC7 TUI tests (Verification) |
| `packages/cli/src/config/config.ts` | read `:22-65` | `cli.json` decode: confirm `tips` survives |
| `packages/cli/test/kete/statusline-config.test.ts` | read; add a case or a sibling `home-tips-config.test.ts` | `{"tips": false}` in `cli.json` loads as `tips: false`, and the other keys survive |
| `packages/client/src/promise/generated/client.ts` | read `:1555-1570` | exact `fs.list` call shape |
| `packages/plugin/src/tui/context.ts` | read `:191-202` | confirms there is no slot under the logo (no change) |
| `docs/upstream-patches.md` | change | append a "Home notices and tips (feature/home-notices)" section listing the three upstream files (read only its tail; append with Edit, never Write) |
| `docs/home-notices.md` | create | user guide: what shows when, dismissing (✕ or "Dismiss home notices"), `"tips": false` |
| `packages/kete-tools/src/lib.ts` `:100-105`, `packages/kete-tools/test/lib.test.ts` `:36-37` | change | mark `docs/home-notices.md` Kete-owned (the P2 precedent) |

## Steps
1. **Shared module.** Create `util/src/kete/notices.ts` and its test. Copy the panel text exactly; run the util
   test.
2. **Panel.** Switch `panel.ts` to the shared module; add the equality test; run the extension's `panel`,
   `bundle` and `fork` tests. `fork.test.ts` greps `src/` for "VS Code" literals, so keep the shared text free of
   them, as today.
3. **RPC.** Create `schema/src/kete/sync.ts`; register `status` in the sync plugin; add the core tests. Use
   `bun run test` in core (HOME/XDG isolation, CLAUDE.md §8).
4. **Config.** Add the marked `tips` line; add the cli config test.
5. **TUI component.** Create `home-tips.ts` and `home-notices.tsx`. Read `client.api` on each call (the API
   object is replaced on reconnect, `permission-mode.tsx:67`). Never use a JSX `kete_change` comment on the same
   line as an element.
6. **Home hook.** Add the marked import and JSX block to `routes/home.tsx`:
   `{/* kete_change start */}` and `{/* kete_change end */}` on their own lines. Don't reformat anything else.
7. **Fixture.** Add the two marked fixture lines.
8. **Tests.** Write `tui/test/kete/home-notices.test.tsx` (Verification rows AC6 and AC7).
9. **Docs.** Append to `docs/upstream-patches.md` with Edit, create `docs/home-notices.md`, and update kete-tools
   `lib.ts` and its test.
10. **Checks.** Run the Verification table top to bottom. Then build the binary and check it in a real terminal
    (pty is acceptable; say which):
    - in a folder with `AGENTS.md` the notice shows, and in one without it doesn't;
    - ✕ (mouse) and "Dismiss home notices" (Ctrl+P) each dismiss it, and it stays dismissed after a restart;
    - with no account or no synced agents, the portal notice doesn't show. If an account with synced agents is
      available, it shows, and with `--offline` it doesn't. Otherwise say this wasn't checked live;
    - a tip shows at 110×30 when no notice is visible; none at 110×11; none with `"tips": false` in `cli.json`
      (use a temporary `XDG_CONFIG_HOME`, never the user's own config);
    - the panel in VS Code is not required. The bundle test covers it; don't run `e2e` unless it's cheap.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC6 text: shared list equals the panel's approved text; the TUI and panel lists differ only in the agent command (Q2 (a)); `dismiss` keeps known ids only, deduped, capped at 50 | `cd packages/util && bun test ./test/kete/notices.test.ts` |
| AC6 text, panel side: `NOTICES` comes from the shared module and its text is unchanged; panel behaviour is unchanged (unconditional) | `cd packages/kete-vscode && bun test ./test/panel.test.ts ./test/bundle.test.ts ./test/fork.test.ts` |
| AC6 condition source: `kete.sync` `status` gives the cached managed-agent count, 0 without a cache, and `offline` | `cd packages/core && bun run test ./test/kete/agent-sync.test.ts` |
| AC6 conditions and persistence in the TUI | `cd packages/tui && bun test ./test/kete/home-notices.test.tsx -t "notice"`:<br>(a) `visibleNotices` table: portal-agents only with `managedAgents > 0` and not offline; agents-md only with `AGENTS.md`; a dismissed id never shows;<br>(b) home render (100×30) with a client answering `managedAgents: 2` and an `AGENTS.md` entry: both titles are on screen; with `0` and no entry, neither is;<br>(c) dismiss through the ✕ and through the `kete.notices.dismiss` command: the notice disappears, `kete-notices.json` holds the id, and a fresh storage instance on the same directory (a restart) still hides it;<br>(d) an RPC error hides the notice and doesn't throw. |
| AC7: one tip at most, none when disabled or under 12 rows | `cd packages/tui && bun test ./test/kete/home-notices.test.tsx -t "tip"`: at 100×30 with no notices, exactly one line starts with `Tip:`; with a notice visible, none; with `tips: false`, none; at 100×11, none; `pickTip` is stable for an index and wraps. |
| `tips` config loads from `cli.json` | `cd packages/cli && bun test ./test/kete/statusline-config.test.ts` (or the new `home-tips-config.test.ts`) |
| Regressions (home, config, fixture users) | `cd packages/tui && bun test ./test/session-home.test.tsx ./test/kete/logo.test.tsx ./test/kete/statusline.test.tsx ./test/config.test.tsx ./test/config-v2.test.tsx ./test/kete/sandbox-status.test.ts` |
| AC13 (P3): typecheck and tests, every touched package | `cd packages/tui && bun run typecheck && bun run test`; `cd packages/kete-vscode && bun run typecheck && bun run test`; `cd packages/util && bun run typecheck && bun test ./test/kete`; `cd packages/schema && bun run typecheck`; `cd packages/core && bun run typecheck && bun run test ./test/kete`; `cd packages/cli && bun run typecheck && bun test ./test/kete`; `cd packages/kete-tools && bun run typecheck && bun run test`. (Known: 2 `dialog-shell-output` timeouts in tui that `main` also has; report anything else.) |
| AC13 (P3): lint | `bun run lint` (root) |
| AC13 (P3): upstream hygiene; every upstream edit listed in `docs/upstream-patches.md` | `bun run --cwd packages/kete-tools upstream:check`; `git grep -n kete_change -- packages/tui/src/routes/home.tsx packages/tui/src/config/index.tsx packages/tui/test/fixture/tui-client.ts` |
| AC13 (P3): before the PR | `bun run --cwd packages/kete-tools verify --base main` (P2 skipped it; run it this time) |
| AC13 (P3): built binary in a real terminal | `cd packages/cli && bun run build --single --skip-install --skip-web-ui`, then run `dist/cli-<os>-<arch>/bin/kete` through the step 10 checklist |

No protocol or client regeneration: the RPC uses the existing `/api/rpc/:rpcID/:method` route, and the TUI
config isn't part of the server schema.

## Risks
- **Stale portal state after logout.** `state.cached` is loaded at startup and refreshed by the 5-minute sync.
  After `kete logout` the portal notice may linger until the next sync or a restart, depending on how
  `KeteSync.sync` handles `signed-out`. Check `util/src/kete/sync/sync.ts:67` and the plugin tick. If the cache
  survives a sign-out, also return `signedIn: state.account !== undefined` from `status` and require it; note the
  outcome in `handoff.md`.
- **The `fs.list` response** is a `Location.response` envelope (`{ location, data }`). Decode it with the
  client's types, not by assumption.
- **Upstream merge:** `routes/home.tsx` is already Kete-edited and small. The insert sits next to upstream's
  `UpdateNotification`, so a conflict there is likely but easy to resolve.

## Cards to update after the build
- `ui-branding` Quick answers: home notices and tips (`tui/src/kete/home-notices.tsx`, `home-tips.ts`, the
  `home.tsx` hook, storage key `kete-notices`, config `tips`, the 12-row rule, "Dismiss home notices").
- `vscode-extension`: `NOTICES` now comes from `@opencode/util/kete/notices` (`dismiss` too); the panel stays
  unconditional; the agent-command parameter (Q2).
- `sync`: the `kete.sync` `status` RPC (`schema/src/kete/sync.ts`, registered in `core/src/kete/sync/plugin.ts`)
  and what `managedAgents` means.
- `config-kete`: the TUI `tips` key in `cli.json`.
- Every "Docs enough: no" gap in `handoff.md` becomes a Quick answers line.
- Still owed from P1 and P2: the card updates listed in their "Done" notes and in `handoff.md`.
