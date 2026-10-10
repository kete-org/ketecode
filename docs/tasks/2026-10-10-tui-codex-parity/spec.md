# Spec: Terminal UX parity with Codex CLI

- Task: `docs/tasks/2026-10-10-tui-codex-parity` · Size: large · Created: 2026-10-10
- Status: approved (maintainer, 2026-10-10: all six phases; D1 (a), D2 (a), D3 (a))
- Depends on: PR #33 (`fix/tui-brand`: brand violet, wordmark, animated logo, prompt at the bottom of
  home, outlined prompt). Build after it merges.

## Goal
Close the day-to-day terminal UX gaps between `kete` (the TUI) and OpenAI's Codex CLI, and bring
the TUI's new-session screen in line with the VS Code chat panel, so a developer moving from Codex
loses nothing they rely on.

## Comparison (verified 2026-10-10)
Codex sources: its CLI docs, command reference and release notes (0.119–0.162). Kete facts are from
code search on `main`.

| Area | Codex | Kete today | In this spec |
|---|---|---|---|
| Status line | `/statusline`: configurable items (model + reasoning, context left, branch, usage, PR/branch summary), theme colours | Fixed row under the prompt: location:branch, Kete status slots (sandbox, local model, todo). Context % only in the sidebar (`sidebar/context.tsx:30`) and mini footer | P1 |
| Prompt history search | Ctrl+R reverse search | ↑/↓ only (`prompt/history.tsx`, `prompt/index.tsx:1022,1058`); Ctrl+R is `session.rename` (`config/keybind.ts:122`) | P2 |
| New-session screen | Header + occasional tips | Logo + prompt; no tips; the VS Code panel's notices (`kete-vscode/src/panel.ts:19`) have no TUI counterpart | P3 |
| Transcript | Search in fullscreen transcript; `/copy` picker (response, code block, quote) | Whole-transcript copy/export (`routes/session/index.tsx:1149`), per-message copy (`<leader>y`); no search, no per-code-block copy in the session view | P4 |
| Prompt editing | Vim mode (`/vim`, motions, text objects, undo, search) | None | P5 |
| Reasoning effort | Alt+, / Alt+. lower/raise | `variant.cycle` Ctrl+T (`keybind.ts:173`), one direction; variant shown in the prompt | P6 |
| Diagrams | Inline Mermaid, display equations | Not rendered (upstream `packages/merman` exists; not wired into TUI markdown) | P6 (investigate) |
| Key debugging | `/keymap debug` | None | P6 |
| Already at parity | — | External editor (`<leader>e`), queued prompts, side questions, focus-gated notifications (`attention.ts:79`), terminal title, image paste, per-message copy, session fork/resume/tabs | — |

Not pursued: voice mode (F8), the agent "Command Center" (Kete has session tabs), cloud chat
browsing (`codex cloud`; Kete's cloud jobs are a platform feature).

## Scope
Each phase is a separate PR. Module cards: `ui-branding` (TUI), `config-kete`, `web-app` (notice
text shared with the panel), `todo` (status slots). The cards don't yet cover TUI slots, attention
config, prompt history or the TUI config schema; the librarian adds them (scout's "Docs enough: no").

**P1. Configurable status line.** A Kete-owned TUI plugin (`tui/src/kete/statusline.tsx`) that
renders into the existing `prompt.footer.status` / `home.footer.status` slots
(`packages/plugin/src/tui/context.ts:191-201`), so the prompt component itself is not edited.
- Items: `context` (% left, from `util/session.ts` `contextUsage`), `model` (with variant),
  `mode` (the permission mode: Default/Auto/Ask/Plan — the label the VS Code panel shows; today the
  TUI shows only the agent, e.g. `Build`), `branch`, `directory`, `sandbox`, `balance` (Kete Gateway
  credit), `todo`, `local-model`. Existing Kete slot plugins (sandbox, local model, todo) become
  items instead of separate registrations.
- Config: an ordered list of item IDs, default `["directory", "branch", "mode", "context"]`, plus
  `colors: boolean`. `/statusline` opens a picker that edits and saves it. Items that don't fit the
  width drop from the end; nothing wraps.
- Decision D1 below: where the setting lives.

**P2. Prompt history search.** Ctrl+R in the prompt opens an inline reverse-incremental search over
`prompt-history.jsonl` (matches highlighted, Ctrl+R again for older matches, Enter to accept,
Esc to restore the draft). Decision D2: `session.rename`'s default key.

**P3. New-session notices and tips.** Under the logo on the home screen:
- Notices, same text as the VS Code panel: "Agents from your portal" (only when signed in to a
  portal that synced agents), "Kete reads your AGENTS.md" (only when the workspace has one).
  Dismissible; dismissals persist in TUI storage per notice.
- One rotating tip per launch from a short Kete-owned list (keys, `/statusline`, `/mode`, `!` shell,
  `@` files). Off with a config flag; never more than one line; hidden below 12 rows.
- The notice list lives in one Kete-owned module the panel and the TUI both import (so wording can't
  drift), or, if packaging makes that impractical, a test asserts the two lists are equal.

**P4. Transcript search and code-block copy.**
- `session.search` (default `<leader>/`; `/find`): a search bar over the open session's rendered
  messages; n/N or ↑/↓ jump between matches; matches highlighted; Esc closes.
- `/copy` (and the message dialog) gains a picker: whole response, a single code block, or the whole
  transcript (today's behaviour).

**P5. Vim mode for the prompt.** Opt-in (`/vim` toggles, config default off): normal/insert modes,
mode shown in the status line, motions (`h j k l w b e 0 $ gg G`), operators (`d c y` with motions
and `dd cc yy`), text objects (`iw aw i" a" i( a(`), `u` / Ctrl+R undo/redo, `p`, `x`, `/` `?`
search with `n N`. Before building, check upstream OpenCode for a vim branch or plugin and extend it
instead if one exists (CLAUDE.md §4).

**P6. Smaller items.**
- `variant.next` / `variant.previous` (Alt+. / Alt+,), alongside `variant.cycle`.
- `/keymap debug`: shows raw key events and which binding (if any) they resolve to.
- Mermaid: investigate wiring upstream's `packages/merman` into TUI markdown code fences; build it
  only if it renders correctly at 80 columns without network access. Otherwise record why not.

## Out of scope
- Voice, agent Command Center, cloud chat browsing.
- Changing the VS Code panel or the web UI beyond sharing the notice list.
- Restyling the session transcript itself.
- Any change to permission semantics (P1 only displays the mode).

## Decisions (answered 2026-10-10)
- **D1 Where the status line setting lives.** (a) The TUI config (`tui.json`,
  `tui/src/config/index.tsx`) as a new `statusline` key, one marked upstream edit — **chosen**:
  it's a display setting like `animations`, and per-machine. (b) The `kete` section of the runtime
  config (`schema/src/config/kete.ts`), which also syncs from the platform but mixes UI into runtime
  config.
- **D2 Ctrl+R.** (a) Ctrl+R searches history when the prompt has focus; `session.rename`'s default
  moves to `<leader>r` — **chosen**, matches Codex and shells; users who set their own rename key
  are unaffected; CHANGELOG notes it. (b) Keep Ctrl+R for rename and use another key for search.
- **D3 Mode vs agent label.** (a) The status line's `mode` item shows the permission mode; the prompt
  keeps showing the agent (`Build`/`Plan`) — **chosen**, the two are different things. (b) Also
  rename how the TUI labels agents to match the panel.

## Acceptance criteria
- [ ] AC1 (P1): with no config, the row under the prompt shows directory, branch, mode and context %
  (TUI render test at 100 columns), and context % matches `contextUsage` for a fixture session.
- [ ] AC2 (P1): a configured item list renders in order, unknown IDs are reported as config errors
  (not dropped silently), and items drop from the end at narrow widths without wrapping (render
  tests at 60 and 40 columns).
- [ ] AC3 (P1): `/statusline` changes and persists the list (test via the config store).
- [ ] AC4 (P2): Ctrl+R in the prompt finds the newest matching history entry; repeated Ctrl+R walks
  older matches; Enter accepts; Esc restores the original draft (prompt tests).
- [ ] AC5 (P2): rename is reachable at its new default and through the command palette; a user
  keybind override for rename still wins (keybind tests).
- [ ] AC6 (P3): notices show only under their conditions (signed in with synced agents; AGENTS.md
  present), a dismissal persists across restarts, and the TUI and panel notice text are identical
  (tests).
- [ ] AC7 (P3): one tip at most, none when disabled or under 12 rows (render tests).
- [ ] AC8 (P4): `<leader>/` finds matches across messages, n/N cycle them, Esc clears highlighting
  (session route test).
- [ ] AC9 (P4): the copy picker copies exactly one chosen code block (test with a multi-block
  message).
- [ ] AC10 (P5): with vim on, each listed motion/operator/text object has a test on the prompt
  buffer; with vim off (default), typing behaves exactly as today (existing prompt tests pass).
- [ ] AC11 (P6): Alt+. / Alt+, move the variant up/down and stop at the ends; `/keymap debug`
  shows the resolved binding for a pressed key.
- [ ] AC12 (P6): Mermaid either renders a flowchart fixture at 80 columns offline, or the result
  records why it was not built.
- [ ] AC13 (all): `bun run typecheck` and `bun run test` in `packages/tui` (and `packages/kete-vscode`
  for P3) pass; root `bun run lint`; `upstream:check` passes and every upstream edit is listed in
  `docs/upstream-patches.md`; built binary checked in a real terminal for each phase.

## Risks and constraints
- **Upstream merges (§4):** P1 and P3 should be plugins in existing slots, with no prompt edit. P2,
  P4, P5 need edits to `component/prompt/index.tsx` and `routes/session/index.tsx`, both large and
  active upstream; keep each a small marked hook into Kete-owned modules. P5 is the largest merge
  risk; check upstream first.
- **Contracts:** keybind defaults (D2) and new config keys (D1) are user-facing contracts. Old
  configs must keep working; changes go in the CHANGELOG.
- **Performance (§11):** the status line recomputes only on its inputs (no polling); history search
  is bounded by the existing history cap; transcript search runs on rendered text of the open
  session only.
- **Privacy/security:** the history file and transcripts stay local; nothing new leaves the
  machine. The `balance` item reuses the existing gateway client data, with no new requests.
- **Offline:** every phase works with no network; notices that need the portal don't show offline.
- **Cross-platform:** key handling (Alt, Ctrl+R) differs across terminals and Windows; P6's
  `/keymap debug` helps triage. Test Ctrl+R/Alt keys on macOS Terminal, iTerm2, Windows Terminal.
