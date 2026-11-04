# Spec: Plan approval (parity B4)

- Task: `docs/tasks/2026-11-04-plan-approval` · Size: M · Created: 2026-11-04
- Status: built (2026-11-04: maintainer pre-approved Milestone B specs that follow the recommended options; docs/parity-plan.md)

## Goal
In Plan mode the agent finishes by presenting its plan; the user approves it, and the session leaves
Plan mode (to Accept-edits or Default) and starts implementing, without the user switching mode and
agent by hand. Rejecting keeps the session planning, with the user's feedback.

## Scope
- A Kete tool `present_plan` (core `kete/plan-approval.ts`, module card permission-mode): offered only to a
  root session whose permission mode is `plan` (removed from every other request in the `context` hook),
  refused when called anyway outside Plan mode, in a subagent, or in an unattended family.
- It asks the user through a question form (metadata `kind: question`, `kete: plan-approval`, so every
  client shows it and `kete run` dismisses it with a message): the plan text (≤ 64 KiB) and three answers
  (the user's own words count as feedback): approve and accept edits → mode `accept-edits`; approve, keep the default checks →
  mode `default`; keep planning → stays in Plan, with optional feedback returned to the agent.
- On approval: the root session's `kete.permissionMode` metadata changes (merged, other keys kept), and if
  the session's agent is upstream's `plan` agent it switches to the default primary agent (Agent.select()),
  unless that default is `plan` itself (then `build`). The runner re-reads both at the next step, so the
  agent implements in the same turn; upstream's Plan plugin adds its "no longer in Plan mode" reminder.
- Plan mode's prompt (a Kete reminder in the `context` hook, Plan mode only) tells the agent to call
  `present_plan` when the plan is ready instead of asking the user to switch modes.
- Docs: docs/permissions.md (Plan section), the permission-mode card.

## Out of scope
- Clients' own plan rendering (the question form's description is the plan text).
- Saving the plan to a file; editing the plan inside the approval form.

## Acceptance criteria
- [ ] AC1: In Plan mode (root session) the request's tools include `present_plan`; in any other mode or in a
      subagent they don't.
- [ ] AC2: Approve + accept edits sets the root session's mode to `accept-edits` keeping other metadata keys,
      switches the `plan` agent to the default agent, and returns a result telling the agent to implement.
- [ ] AC3: Approve + default sets `default`; a session not on the `plan` agent keeps its agent.
- [ ] AC4: Keep planning (or a dismissed form) changes nothing and returns the user's feedback.
- [ ] AC5: Called outside Plan mode, in a subagent, or in an unattended family it fails without asking or
      changing anything; an over-long plan fails.
- [ ] AC6: core typecheck and `bun run test ./test/kete` in packages/core pass; `upstream:check` passes.

## Risks and constraints
- Security: the tool raises the session's permissions, so only the user's own answer to the form may do it;
  the model can't answer forms. Unattended runs never ask (ADR 0008), so the tool refuses there.
- No upstream file edits beyond the plugin registration line (internal.ts, marked).
