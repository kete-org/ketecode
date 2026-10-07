# 0012. Agent orchestration across runners: coordinator turns and node jobs that hand work back through Git

- **Status:** Proposed
- **Date:** 2026-10-07

## Context

Phase 8 (`docs/architecture.md` §26, §50, §67, §102; ADR 0011) adds orchestration across runners:
a coordinating agent splits a task into sub-tasks that run as separate jobs on separate runners and
come back as one draft PR/MR. The maintainer decided on 2026-10-07: the coordinator runs as a job
inside a runner and asks the platform to start sub-jobs, the platform only schedules, and code
never reaches Kete's platform; one integration PR/MR built by the coordinator from per-sub-job
branches; one trust zone per orchestrated task; sub-tasks form a DAG under one budget and one
deadline, with retry and re-plan.

Constraints from the code: a job is one container and one `kete job run` with a 120-minute cap and
a host-side VM kill at 135 minutes (platform ADRs 0018, 0023); job mode runs only a synced agent,
fail-closed (ADR 0008), with `kete` reaching only the gateway and the platform; code leaves a job
only as a change bundle validated as hostile and pushed create-only on an exact base (platform ADR
0021; runner publisher, ADR 0011 rule 3); in-runtime orchestration already exists as the
`subagent` and `workflow` tools with worktrees.

Design: `docs/tasks/2026-10-07-cross-runner-orchestration/spec.md`. Control-plane side: platform
ADR 0026.

## Decision

1. **Every unit of work is an ordinary job.** An orchestration is a sequence of **coordinator
   turns** and a DAG of **nodes**, each attempt of each being a normal job with the normal
   entrypoint, job mode, policy, budget and push path. No second job system in the runtime.
2. **Continuation turns.** A coordinator turn plans (or re-plans, or integrates) and ends; it does
   not wait for children. The platform starts the next turn when the DAG is quiescent or the
   deadline reserve is reached. Turn state carries over through the platform's DAG metadata, the
   plan file's notes and the repository itself.
3. **The `orchestrate` tool exists only in job mode for coordinator turns** (spec
   `orchestration.role = "coordinator"`), registered from Kete-owned job-mode code. It validates a
   DAG locally (the shared Kahn check also used by `workflow`), sends **metadata only** to the
   platform with the turn's job key, and writes the full plan (prompts, notes) into the working tree
   at `.kete-orchestration/plan.json`. It has no repository, zone, branch, model, policy or deadline
   parameter: those are inherited and can only be narrowed. Workers never get the tool (depth 1).
4. **Code moves only through Git in the zone's repository.** Plan, node and integration branches
   (all under `kete/job/`) are created by the zone's existing push path from validated bundles. A
   plan bundle may contain only the plan file and plan turns run with edits denied; no other bundle
   may contain `.kete-orchestration`. Child prompts are read by the entrypoint from the plan branch,
   not received from the platform. Handoff notes travel in node commit messages written in-zone.
5. **Pinned refs.** Every extra ref a job fetches (plan, dependency or node branches) comes with a
   SHA recorded when it was created; the entrypoint fetches only in the clone phase, verifies the
   SHA and refuses on mismatch. The integration is built locally from those refs, tested, and leaves
   as one ordinary validated bundle on the orchestration's pinned base.
6. **Contracts are additive and feature-negotiated:** claim feature `orchestration_v1`, an optional
   `orchestration` section in job spec v1, claim `fetch` refs, plan-bundle vectors shared with the
   platform, and job-host-v2 `cleanup` items for runner-side branch deletion.
7. **Upstream untouched.** All code in `packages/*/src/kete/`, `packages/kete-*`; at most one marked
   registration line if a separate plugin is preferred, recorded in `docs/upstream-patches.md`.

## Consequences

- Orchestrations can run longer than one job and survive a lost runner (one infrastructure retry
  per node or turn), at the price of a VM boot and clone per coordinator turn and a coordinator
  that rebuilds context each turn.
- Repositories see short-lived `kete/job/<id>-…` branches during an orchestration; they are
  compare-and-deleted afterwards (7 days' retention after failure).
- The integration PR/MR is one commit; per-node history stays visible only until cleanup (and in
  the PR body's node list).
- The entrypoint gains extra pinned fetches and a plan-file reader; both validators gain the plan
  rule; the runner's publisher gains plan bundles, handoff notes and cleanup.
- Local laptop orchestration across processes is not provided; the `workflow` tool and worktree
  subagents remain the local answer. Revisit nested orchestration, approvals between steps, the
  §67 workflow engine and cross-zone work only with a new ADR.
