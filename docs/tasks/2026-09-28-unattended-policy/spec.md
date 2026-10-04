# Spec: Unattended runs fail closed (ADR 0008)

- Task: `docs/tasks/2026-09-28-unattended-policy` · Size: large · Created: 2026-09-28
- Status: approved (user, 2026-09-28)

## Goal
A session marked **unattended** is enforced by the runtime, not a client: anything that would ask a
person is denied with a reason the agent sees, unless the run's policy allowed it in advance, and the
run can't start without a spending budget and a time limit. This is the enforcement `kete job run`
(next task) and cloud jobs (ADR 0005) build on.

## Scope
- **Marking a run unattended** (permissions, sessions): a `kete.unattended` session-metadata key set
  when the root session is created, like `kete.permissionMode`. Its value carries the run's policy:
  an optional list of `allow` rules (same shape as permission rules) and the required limits.
  - The check resolves it from the session's **root** (walking `parentID`), not from the session's
    own metadata: worktree subagents replace metadata (`tool/plugin/subagent.ts:227`), so plain
    inheritance would drop the flag.
  - Once set it can't be removed or widened for that session family (a metadata update that drops or
    changes it is refused).
- **Fail closed** (new Kete plugin, alongside permission-mode and permission-ceiling): a
  `permission.evaluate` hook that, for an unattended family, turns every `ask` into `deny` with the
  message "unattended run: not allowed by this run's policy" — unless one of the run's `allow` rules
  matches, which turns that `ask` into `allow`. It never touches `deny`, and never turns `deny` or
  the other hooks' tightening into `allow`: the policy only narrows.
- **Required limits**: starting a prompt in an unattended family is refused, with a clear error, when
  the run has no spending budget or no time limit (the run's own values, falling back to
  `kete.budget.session` and an explicitly set `kete.subagents.timeout`; the 60-minute default and
  `0` = no limit don't count). The run's time limit bounds the whole run, not only subagents.
- Docs: permissions card, `skill/kete.md`, a line in `docs/upstream-patches.md` if an upstream file
  is touched.

## Out of scope
- `kete job run` and any job API or HTTP route (next task; it will set the metadata).
- The audit log (ADR 0008 bullet 4): nothing exists today; a separate task before jobs ship.
- Where the policy comes from on the platform (organization policy, agent autonomy): the job spec
  carries it for now.
- Changing `kete run --auto` (stays an interactive convenience).

## Acceptance criteria
- [x] AC1: In an unattended session, a tool call whose rules say `ask` is denied without a
  `permission.asked` event, and the model sees the unattended reason (core Kete test).
- [x] AC2: An `allow` rule in the run's policy lets that call through; a `deny` rule still wins over
  it; the policy can't allow what the subagent permission ceiling or permission mode deny (test).
- [x] AC3: A subagent of an unattended session — including a worktree subagent — is also unattended
  (test).
- [x] AC4: A metadata update that removes or changes `kete.unattended` is refused (test).
- [x] AC5: A prompt in an unattended session without a budget, or without a time limit, is refused
  with an error naming what's missing; with both, it runs; an unattended run is stopped at its time
  limit (tests).
- [x] AC6: Interactive sessions behave exactly as before (existing permission tests pass).
- [x] AC7: core, schema typecheck; core Kete tests; `bun run lint`; `upstream:check`;
  `kete-tools verify --base main`; protocol and client regenerated if a schema type is exposed.

## Risks and constraints
- **Security:** this is a permission change; it must only tighten. Tests for bypass: a child session
  shedding the flag, a metadata update removing it, an allow rule widening a deny.
- **Upstream edits:** likely a minimal marked edit in `session.ts` (refuse removing the key) or a
  Kete hook instead if one exists; upstream-guard reviews.
- **Contract:** `kete.unattended` is a new session-metadata key that `kete job run` and the cloud
  worker will set; treat its shape as a contract (versioned field or additive only).
- The time limit for a whole run is new: today only subagents are timed.
