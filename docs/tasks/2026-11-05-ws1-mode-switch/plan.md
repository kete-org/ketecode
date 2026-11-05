# Plan: WS1 work-orchestrator and Code|Work switch

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large task (spec approved 2026-11-05). Upstream edits: `core/src/plugin/internal.ts` (import + one list
entry), `app/src/new-session/composer-adapter.ts` (import + 3 marked lines), `app/src/runtime/i18n/en.ts`
(2 marked keys).** No shared contract, config schema, server endpoint or security change: `kete.modes`, the
`kete.sessionMode` key and the runtime's refusal of an unavailable mode already exist (1.2/1.3); `work.jsonc`
stays `available: false`. No protocol/client regeneration.

Budget: ~550 changed lines (core ~110, app ~380, docs ~60).

## Cards read
- docs/context/modules/web-app.md (verified-at 78df34621d, stale: no)
- docs/context/modules/roles-skills.md (stale: no)
- docs/context/modules/config-kete.md (stale: no)
- docs/context/pitfalls.md, docs/context/commands.md

## Design decisions (read before building)
1. **Agent** is its own plugin (`kete.work-agent`), not part of `KeteRoles`: roles return early for org users
   (`roles.ts:160-164`), and this agent must exist for everyone. Registered right after `KeteRoles.Plugin` in
   `pre`, so `KeteBudgetRule` still sees it. `item.mode = "primary"`, `item.hidden = true`; permissions untouched
   (the editor's `Info.default`, `core/src/agent.ts:81`); Work's limits come from `KeteWorkMode`. Hidden agents
   are skipped by the default chain (`agent.ts:53-54`) and the app picker (`selection.tsx:95-98`), but
   `Agent.select(id)` still resolves them (`agent.ts:101-104`). A user config agent or org-synced agent with the
   same id wins (it loads later); Work enforcement is unaffected.
2. **Which workspace the switch acts on:** the sidebar has no workspace context. The switch renders only when
   the current route is a draft (`useCurrentRoute()` → `{type: "draft", draftID}`) whose tab (found in
   `tabs.store`; fields `server`, `directory`, `shell/tabs/schema.ts:17-25`) belongs to the focused server.
   Session tabs carry no directory, so on session/home/settings routes the switch is not shown. (`KeteHome`
   opens a draft on `/`, so the new-session screen always has it.)
3. **Remembering and sharing the choice:** the connector is keyed on `server + "\n" + directory`
   (`<Show when={…} keyed>`) and owns `persisted(Persist.serverWorkspace(ctx.sdk.scope, directory, "kete-mode"),
   …)` (pattern: `providers/models/selection.tsx:111-115`). Two `persisted()` instances of one key do not sync
   within a window, so the composer adapter does **not** open its own: the connector writes the *effective* mode
   (after the availability fallback) into a module-level `Map` in `state.ts` (`choose(server, directory, mode)`),
   and the adapter reads `chosen(server.key, location().directory)` at submit. The draft tab's `directory` is the
   adapter's `location().directory` (`new-session/route.tsx:83`). Nothing stored (sidebar not mounted: horizontal
   or inbox tab layout, editor hosts; or `persisted` not ready yet) → Code, the safe default.
4. **Create fields:** Code → `agent` and `metadata` unchanged (no `kete.sessionMode` key, so Code users and older
   runtimes see no change). Work → `agent: undefined` (the runtime fills the profile's agent,
   `core/src/session.ts:316`; `data.session.create`'s `agent` is optional) and
   `metadata: {...draftMetadata, "kete.sessionMode": "work"}` (keeps `kete.permissionMode` from
   `KeteModeDraft.metadata`). Key from `KeteSessionModes.metadataKey` (`@opencode/util/kete/session-mode`).
5. **Mode list:** `kete.modes` `list` via `ctx.sdk.api` `rpc.call` (pattern `kete/todo.ts:18-23`, 15 s timeout),
   decoded with `Schema.decodeUnknownOption(Schema.Array(KeteModesRpc.Summary))`. Any error (missing RPC,
   transport, timeout) or an undecodable reply → Code only (`[{id: "code", name: "Code", description: "",
   agent: "build", available: true}]` or a narrower local type; implementer's choice). A list without an
   available `code` → Code only too. Unavailable modes stay in the list and render disabled.
6. **A11y:** `role="radiogroup"` with `aria-label`; `role="radio"` buttons with `aria-checked`; roving `tabindex`
   (checked = 0, others = -1); Arrow Left/Up and Right/Down move to the previous/next *available* radio, focus it
   and select it. An unavailable radio has `aria-disabled="true"`, `tabindex="-1"`, ignores clicks, and is
   `aria-describedby` a visible hint "Not available yet". The focus ring comes from the existing
   `[data-kete="sidebar"] button:focus-visible` rule (`sidebar.css:36`); the story renders the view inside a
   `data-kete="sidebar"` wrapper so it applies.
7. **i18n:** two keys at the end of `en.ts`, each `// kete_change`: `"kete.mode.label": "Mode"`,
   `"kete.mode.unavailable": "Not available yet"`. Mode names come from the runtime profile (`name`). These strings
   need no product name, so no `{{product}}`. The view takes the strings as props (context-free); the connector
   fills them with `useLanguage().t(...)` (pattern `desktop/src/renderer/kete/sidecar-status.tsx:14-16`).

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/core/src/kete/roles.ts` | read (`:156-180`) | pattern for an `agent.transform` plugin (`define`, `editor.update`) |
| `packages/core/src/kete/work-agent.ts` | **create** (~45) | `KeteWorkAgent.Plugin` (`id: "kete.work-agent"`), `ID = "work-orchestrator"`, name "Work", description, system prompt (plan briefly, work only in the granted folders, write results as new files and never overwrite, explain what it did); header comment cites `modes/work.jsonc` and `work-mode.ts` |
| `packages/core/src/plugin/internal.ts` | change (upstream, marked) | import `KeteWorkAgent` beside the `KeteRoles` import (`:115`, `// kete_change`); `KeteWorkAgent.Plugin` right after `KeteRoles.Plugin` (`:320`) with a `// kete_change: …` comment line above, like its neighbours |
| `packages/core/src/agent.ts` | read (`:40-110`) | `hidden`, default chain, `select` |
| `packages/core/test/kete/roles.test.ts` | read | harness for agent plugins (signed in vs not, via `KeteAccount.save`) |
| `packages/core/test/kete/work-agent.test.ts` | **create** (~60) | AC1 |
| `packages/core/src/kete/modes/work.jsonc` | change (1 comment line) | `:9` says "not available until WS1 1.4 adds the agent"; now: the agent exists (1.4), still unavailable until the openat file-I/O follow-up. `available` stays `false` |
| `packages/schema/src/kete/modes.ts` | read | `KeteModesRpc.ID`, `Summary`, `Id` |
| `packages/util/src/kete/session-mode.ts` | read | `metadataKey`, `Mode`, `parse` |
| `packages/app/src/kete/todo.ts`, `packages/app/src/kete/handshake.ts` | read | raw RPC call + decode pattern; missing-RPC error types |
| `packages/app/src/kete/mode.ts` | read (`:54-90`, `:138`) | `KeteModeDraft.metadata` shape (`SessionMetadata`), `export * as` namespace style |
| `packages/app/src/kete/mode-switch/state.ts` | **create** (~70) | pure, `export * as KeteModeSwitch`: `CODE_ONLY`, `decodeModes(output)`, `fetchModes(client, signal)` (any error → `CODE_ONLY`), `effective(saved, modes)` (saved id if listed and available, else `"code"`), `createFields({agent, metadata, mode})` (decision 4), `step(modes, current, ±1)` for arrow keys (skips unavailable, wraps), `choose`/`chosen` (module `Map` keyed by server key + directory; read once at submit, so no signal) |
| `packages/app/src/kete/mode-switch/state.test.ts` | **create** (~90) | AC2 |
| `packages/app/src/kete/agent-switch.tsx` | read | the existing segmented radiogroup to match |
| `packages/app/src/kete/mode-switch/view.tsx` | **create** (~55) | `KeteModeSwitchView(props: {modes; selected; label; unavailable; onSelect(id)})`, decision 6; no app contexts |
| `packages/app/src/kete/mode-switch/mode-switch.tsx` | **create** (~60) | connector `KeteModeSwitch(props: {ctx: ServerCtx; server: ServerConnection.Key; directory: string})`: `createResource` → `fetchModes(ctx.sdk.api, …)` (pattern `sidebar/account.tsx:15-18`); `persisted(…)` with `Schema.Struct({ mode: Schema.optional(Schema.String) })`; effect: once ready and modes loaded, `choose(server, directory, effective(saved.mode, modes))`; on select: save and `choose` |
| `packages/app/src/runtime/persistence/storage.ts` | read (`:498-535`, `:586-600`) | `Persist.serverWorkspace`, `persisted()` signature and its `ready` accessor |
| `packages/app/src/providers/models/selection.tsx` | read (`:111-115`) | `persisted(Persist.serverWorkspace(scope, dir, key), …)` usage |
| `packages/app/src/kete/sidebar/sidebar.tsx` | change (~12) | decision 2: workspace from `route()`, `tabs.store.find(...)` (not the throwing `tabs.draft()`), `ServerConnection.key(home.server.focused())`; pass `mode={<Show when={…} keyed>{(w) => <KeteModeSwitch …/>}</Show>}` |
| `packages/app/src/kete/sidebar/view.tsx` | change (~3) | optional `mode?: JSX.Element` prop rendered first inside `<nav data-kete="sidebar">`, before `sidebar-nav` |
| `packages/app/src/kete/sidebar/sidebar.css` | change (~30) | `[data-kete="mode-switch"]` segmented control (the look of `panel.css:370-399` `agent-switch`, `--kete-*` tokens only), `aria-disabled` state, `[data-kete="mode-hint"]` |
| `packages/app/src/kete/panel.css` | read (`:370-405`) | agent-switch styles to mirror |
| `packages/app/src/shell/tabs/tabs.tsx` (`:230-300`), `packages/app/src/shell/tabs/schema.ts` | read | tab store and draft fields |
| `packages/app/src/shell/state/layout.tsx` | read (`:55-80`) | `LayoutRoute` draft variant |
| `packages/app/src/new-session/route.tsx` | read (`:80-90`) | the draft's directory is the adapter's location |
| `packages/app/src/new-session/composer-adapter.ts` | change (upstream, marked) | import `KeteModeSwitch` (`// kete_change`); before `data.session.create` (`:97`): `const kete = KeteModeSwitch.createFields({ agent: selection.agent, metadata: KeteModeDraft.metadata(draftID), mode: KeteModeSwitch.chosen(server.key, currentDirectory) }) // kete_change: …`; `agent: kete.agent, // kete_change` and `metadata: kete.metadata, // kete_change: …` replace `:99` and `:106`. `KeteModeDraft.clear` stays. Don't clear the choice: it's the workspace's remembered mode |
| `packages/app/src/runtime/i18n/en.ts` | change (upstream, marked) | 2 keys after `:1325`, decision 7 |
| `packages/app/src/runtime/i18n/language.ts` | read | `useLanguage`, `t` signature |
| `packages/app/src/kete/shell.stories.tsx` | change (~35) | `ModeSwitch` (Work unavailable) and `ModeSwitchWorkAvailable` stories: the view inside `<div data-kete="sidebar">`, a local `selected` signal, `<output data-testid="last">` showing the last `onSelect` id |
| `packages/app/component-tests/kete-shell.spec.ts` | change (~55) | AC3 |
| `docs/upstream-patches.md` | change (after `:1910`) | new "## Code \| Work switch (WS1 1.4)" section: table rows for `internal.ts`, `composer-adapter.ts`, `en.ts`, each with why no seam; sync checklist |
| `docs/desktop-enhancement-plan.md` | change (`:241-244`) | mark 1.4 done; the switch shows on the new-session screen; Work stays unavailable |

## Steps
1. Core agent: create `kete/work-agent.ts` (decision 1) with `define` + `ctx.agent.transform` as `roles.ts:156-178`
   does, without the account read. Set `name`, `description`, `mode`, `hidden`, `system`; leave `permissions`.
2. Register it in `plugin/internal.ts` (import + list entry after `KeteRoles.Plugin`, both marked). Not in
   `guarded`: removing it only leaves Work sessions without their agent, and Work is refused while unavailable.
3. `work-agent.test.ts` (the `roles.test.ts` harness; run `AgentPlugin.Plugin` then `KeteWorkAgent.Plugin`):
   (a) signed out: `agents.get(ID)` exists, `hidden === true`, `mode === "primary"`; (b) with a saved account:
   same; (c) `agents.select()` returns `build`, not the work agent; (d) `agents.select(Agent.ID.make(
   "work-orchestrator")).info?.id` is it; (e) `list()[0]` is not it. (d) covers "a session created with its id
   resolves to it": `SessionContext.select` calls `Agent.select(session.agent)` (roles-skills card).
4. Update the `work.jsonc` comment. Run the AC1 commands.
5. App `mode-switch/state.ts` + `state.test.ts`: `decodeModes` keeps a valid list with unavailable Work; garbage
   or no available `code` → `CODE_ONLY`; `fetchModes` with a fake client rejecting `rpc.method_not_found`, a
   network error, and an undecodable reply → `CODE_ONLY`; `effective`: saved `work` available → `work`,
   unavailable → `code`, unknown string or undefined → `code`; `createFields`: Code returns the input unchanged
   (no key added; `undefined` metadata stays `undefined`), Work keeps `kete.permissionMode`, adds
   `kete.sessionMode: "work"`, `agent` undefined; Work without draft metadata → `{ "kete.sessionMode": "work" }`;
   `step` skips unavailable and wraps; `chosen` differs by server and by directory, and is `undefined` when
   nothing was chosen.
6. `mode-switch/view.tsx` (decision 6) and `mode-switch/mode-switch.tsx` (decisions 3, 5, 7).
7. Sidebar: `mode` prop on `KeteSidebarView`; wire it in `sidebar.tsx` (decision 2); CSS in `sidebar.css`.
8. `en.ts` keys; the composer-adapter marked edit.
9. Stories and spec tests (AC3): Code checked, Work `aria-disabled="true"`, "Not available yet" visible and
   referenced by Work's `aria-describedby`; clicking Work leaves Code checked and `last` empty. Available story:
   clicking Work → Work checked, `last` = `work`. Keyboard: focus Code, `ArrowRight` → Work checked and focused
   (available) / Code still checked (unavailable); only the checked radio has `tabindex="0"`; the focused radio's
   computed `outline-style` is not `none` after keyboard focus (use `page.keyboard.press("Tab")` into it so
   `:focus-visible` matches).
10. Docs: `upstream-patches.md` section, the plan doc. Run all verification commands, narrowest first.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `cd packages/core && bun run test ./test/kete/work-agent.test.ts`; then `bun run test ./test/kete/roles.test.ts ./test/kete/session-mode-session.test.ts`; `bun run test ./test/kete`; `bun run typecheck` |
| AC2 | `cd packages/app && bun test --conditions=solid --preload ./happydom.ts ./src/kete/mode-switch/state.test.ts`; then `bun test --conditions=solid --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/kete/mode.test.ts` |
| AC3 | `cd packages/app && bun run test:components -- component-tests/kete-shell.spec.ts` (browser once: `node_modules/.bin/playwright install chromium-headless-shell`) |
| AC4 | `cd packages/app && bun run typecheck && bun run test:unit`; root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main` |

## Risks
- The e2e mock server refuses unknown RPCs (`e2e/utils/mock-server.ts:1137`); the switch treats that as Code only,
  so e2e should be unaffected. The mock is not changed.
- Desktop `persisted()` loads asynchronously: a submit before it is ready creates a Code session. Fails safe.
- No switch on session routes, in the horizontal/inbox tab layouts or in editor hosts (no Kete sidebar there);
  those users always get Code. Fine for Phase A, Work is unavailable anyway.
- `composer.spec.ts` has 28 pre-existing failures on main (web-app card); don't chase them.

## Cards to update after the build
- `roles-skills`: the `kete.work-agent` plugin, why it is separate from the roles, registration order, test.
- `web-app`: `mode-switch/` files (add `packages/app/src/kete/mode-switch/**` to `paths`), the sidebar `mode` prop,
  workspace = current draft tab, the `choose`/`chosen` hand-off to `composer-adapter.ts`, the i18n keys, the new
  stories and spec tests.
- `config-kete`: the `work.jsonc` comment (the agent exists; still `available: false`).
