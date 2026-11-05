# Spec: WS1 session mode

- Task: `docs/tasks/2026-11-05-ws1-session-mode` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, Phase A pre-approval: "continue building until Phase A is complete", recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
A session records which mode (Code or Work) it was created in, the mode can't change afterwards, and a
session that names no agent starts with its mode's agent. PR 1.2 of `docs/desktop-enhancement-plan.md`;
stacked on 1.1 (`KeteModes`, #93). Code sessions behave exactly as today.

## Scope
Modules: `permissions` and `unattended` (session metadata keys and the lock pattern), `config-kete` (profiles).

- **Where the mode lives**: session metadata key `kete.sessionMode` (`"code" | "work"`), like
  `kete.permissionMode` and `kete.unattended`. The plan's "`mode` on `POST /session`" becomes this key: no
  API, openapi or SDK change. A session without the key is a Code session (every existing session).
- **Validated at create** (core `Session.create`, next to the `KeteAddDir.guard` call; one marked line): an
  unknown value, or a mode whose profile is `available: false` (Work until 1.3), refuses the create with a
  clear error. Children inherit metadata already, so a subagent stays in its parent's mode.
- **Immutable** (`Session.setMetadata`; one marked line, next to `KeteUnattendedPolicy.guardMetadata`): the key
  can't be added, changed or removed after create — the same rule and error type as `kete.unattended`.
- **Default agent**: where a session's agent is resolved with no agent named (`SessionContext.select`, and any
  other place that calls `Agent.select(session.agent)` for the same session, so the model and the agent
  agree), a Work session uses its profile's `agent`. A Code session keeps today's selection (configured
  default, then `build`), so a user's `default_agent` setting still wins in Code. An explicitly named agent
  always wins. Minimal marked edits; the logic lives in Kete-owned code (`core/src/kete/session-mode.ts`).
- Shared key and parser in `util/src/kete/` (as `permission-mode` does) so the app (1.4) and the TUI can use it.
- `docs/upstream-patches.md`, the plan doc (metadata key instead of a `mode` field), and cards.

## Out of scope
- Enforcing Work's rules (1.3); making Work available (1.3); the `work-orchestrator` agent and the switch
  (1.4). Until 1.3, Work can't be created, so the Work default-agent path is covered by unit tests that inject
  an available Work profile.
- TUI, CLI flag or VS Code support for choosing a mode.

## Acceptance criteria
- [ ] AC1: Creating a session with `kete.sessionMode: "code"` or without it works as today; `"chat"` and
  (while unavailable) `"work"` are refused with an error naming the mode.
- [ ] AC2: `setMetadata` that adds, changes or removes `kete.sessionMode` is refused; one that keeps it equal
  (while changing other keys) succeeds.
- [ ] AC3: A child session inherits its parent's mode.
- [ ] AC4: Default agent: no agent named + Code → today's default (`build`, or the configured default); no
  agent + Work (profile injected as available) → the profile's agent; an explicit agent → that agent.
- [ ] AC5: core typecheck and `bun run test` (kete and session tests), server kete tests, lint, `upstream:check`
  (every upstream edit marked), `verify --base main`.

## Risks and constraints
- Security: the lock matters for 1.3 — a session must not drop out of Work's restrictions by rewriting its
  metadata, so the guard is in the runtime, not the client. Refusing unavailable Work at create keeps an
  unenforced Work session from existing.
- Upstream edits: `core/src/session.ts`, `core/src/session/session.ts`, `core/src/session/context.ts` (and the
  model-resolution site if it selects the agent separately): marked, one line each where possible.
- Contract: `kete.sessionMode` becomes a session metadata contract the app and other clients write.
