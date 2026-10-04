# 0008. Unattended runs fail closed

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Interactive sessions ask a person when a permission rule says `ask`. An autonomous job has no one
to ask. Today the only unattended mode is `kete run --auto` (also `--yolo`,
`--dangerously-skip-permissions`), which works in the CLI client by answering every request "once"
— approving everything that isn't explicitly denied (`packages/cli/src/run/noninteractive.ts`).
Without `--auto`, `kete run` rejects and interrupts. Repository content read by an agent may try to
steer it (prompt injection), and nobody would see it happen.

## Decision

A run started as **unattended** (a job, or `kete job run`) is enforced by the runtime, not the client:

- Every request that would `ask` is **denied**, with a reason the agent sees ("unattended run: not
  allowed by this job's policy"), unless the job's policy explicitly allows it. Deny rules still win.
- A job's policy comes from the platform (organization policy and the agent's autonomy level,
  the platform's ADR 0008, "platform-managed agents" — not this repo's 0008) plus the job spec; it can only narrow what the agent's rules
  allow, never widen them.
- A spending budget and a time limit are required for every unattended run (`kete.budget.session`,
  `kete.subagents.timeout`); a run without them is refused.
- Every tool call, permission decision, model call, file change and command is written to an audit
  log (§109), with secrets redacted.
- `--auto` stays a client convenience for interactive use; it is not used for jobs.

## Consequences

- Nothing runs unattended that a policy didn't allow in advance; prompt injection can't get
  approval from a person who isn't there.
- Jobs fail more often at first, with clear reasons, until policies are tuned; the audit log shows
  which permissions to allow.
- The permission mode (`packages/core/src/kete/permission-mode.ts`) and the subagent permission
  ceiling (`permission-ceiling.ts`) already only tighten; the unattended mode is another tightening
  hook of the same kind.
