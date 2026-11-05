# Spec: WS1 work-orchestrator and Code|Work switch

- Task: `docs/tasks/2026-11-05-ws1-mode-switch` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, Phase A pre-approval: "continue building until Phase A is complete", recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
The desktop and web app show a Code | Work switch at the top of the sidebar. New sessions start in the selected
mode, and the choice is remembered per workspace. The runtime has the `work-orchestrator` agent that a Work
session starts with. PR 1.4, the last PR of Phase A (`docs/desktop-enhancement-plan.md`); stacked on 1.3.
Work itself stays unavailable (`available: false`) until the file-I/O race from 1.3's security review is fully
closed. Until then the switch shows Work as unavailable, and nothing can create a Work session.

## Scope
Modules: `roles-skills` (built-in agents), `web-app` (sidebar, new-session create, i18n), `config-kete` (profiles).

- **Agent** (`core/src/kete/work-agent.ts`, registered next to the Kete plugins): `work-orchestrator`, a primary
  agent marked `hidden` (so it never appears in Code's picker or becomes the default), with a prompt for delegated
  knowledge work: plan briefly, work only in the granted folders, write results as new files, explain what it did.
  Its permissions add nothing; Work mode's plugin (1.3) sets the limits. It's added for every user, including users
  signed in to an org, unlike the starter roles.
- **Switch** (`app/src/kete/mode-switch/`, a pure view plus a connector, as `KeteSidebarView` and `KeteSidebar` are):
  - reads `kete.modes` from the focused server; with an older runtime or an error it shows Code only;
  - shows a segmented Code | Work control at the top of the Kete sidebar. An unavailable mode is shown disabled
    with a short "Not available yet" hint;
  - remembers the selection per workspace (`Persist.serverWorkspace`, key `kete-mode`); a remembered mode that is
    no longer available falls back to Code.
- **New sessions**: `session.create` gets `kete.sessionMode` merged into its metadata (merged with the permission
  mode draft's key). For Work, the agent comes from the mode, not the composer's selection. This is one marked
  edit in `new-session/composer-adapter.ts` that calls a Kete helper.
- English strings through i18n (`kete.mode.*` keys, marked); the product name through `{{product}}`.
- `docs/upstream-patches.md`, the plan doc, and the cards.

## Out of scope
- Making Work available. That needs openat-based file I/O, a follow-up security task.
- Work-specific UI beyond the switch (library, approvals, folders: Phases B and C). TUI and VS Code switches.

## Acceptance criteria
- [ ] AC1: Core: `work-orchestrator` exists for every user (with and without an org sign-in), is hidden, and is
  not the default agent. A session created with its id as the agent resolves to it.
- [ ] AC2: Pure logic tests: mode list decoding (unavailable or older runtime → Code only); the remembered-mode
  fallback; `session.create` metadata merging (`kete.sessionMode` plus `kete.permissionMode` kept); Work → no
  composer agent.
- [ ] AC3: Story and component spec: the switch renders Code selected, and Work disabled with the hint when it's
  unavailable. When Work is available (story prop), selecting it calls back with `work`. It can be operated by
  keyboard, with a radiogroup or tab semantics and visible focus.
- [ ] AC4: app typecheck and `test:unit`, the new component spec, core kete tests, lint, `upstream:check`, `verify
  --base main`.

## Risks and constraints
- No new security surface: the runtime refuses an unavailable mode (1.2) whatever the UI sends.
- Upstream edits: `composer-adapter.ts` (one marked line) and `en.ts` (marked keys). The switch mounts inside
  the Kete sidebar, which is Kete-owned.
- Accessibility: an accessibility check of the switch.
