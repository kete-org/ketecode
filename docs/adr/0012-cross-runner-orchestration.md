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

## Contract notes (O1, 2026-10-09)

Carried over from kete-code-platform ADR 0026 "Contract notes (O1)" and "Review amendments (O1)" (the
contract task `docs/tasks/2026-10-09-orchestration-contracts` there), so this ADR and the platform's
agree on what was built; the copies of the contracts are `docs/platform/orchestrations-v1.md`,
`jobs-v1.md` "Orchestrated jobs" and `job-host-v2.md` "Orchestration".

The contracts are defined (task `docs/tasks/2026-10-09-orchestration-contracts`): `orchestrations-v1`
(`packages/shared/src/api/v1/orchestrations.ts`, `docs/contracts/orchestrations-v1.md`), additive
jobs-v1 feature `orchestration_v1` and additive job-host-v2 fields, with vectors. Nothing is served;
the status stays Proposed until the Phase 8 S0 spike. Precisions and deviations from the design
spec, recorded here so O3–O11 and kete-code build to the contract:

- **Prompts stay out, digests come in.** The proposal carries a SHA-256 `prompt_digest` per node as
  well as the file's `plan_digest`, so the platform can refuse a changed succeeded node and bind the
  committed plan file to the proposal (Kete cloud: it recomputes `orchestrationPlanProposal` from
  the bundle) without ever holding a prompt.
- **Integer money and per-node attempts in the plan file.** Nodes carry `budget_micros` (not
  `budget_usd`), `max_attempts` (1–3) and the plan an optional lower `max_parallel`.
- **The worker spec has no prompt.** `JobSpec` is unchanged; an orchestrated claim's spec is the
  separate `JobOrchestratedSpec` (prompt only for a coordinator, no `review`). `spec.orchestration.plan`
  is `{ rev, branch, sha }` (the path is fixed by the contract); `fetch` entries are
  `{ name: plan | nodes/<key>, branch, sha }`, exposed as `refs/kete/<name>`; the claim schema itself
  refuses any fetch, branch or clone ref that isn't this orchestration's. A coordinator's spec says
  whether titles may be sent (`titles`); there is no `state` in the spec (the tool reads it from
  `GET …/orchestration`).
- **Result v1 is unchanged.** The handoff note lives in the node commit's message
  (`orchestrationNodeCommitMessage`, trailers last); the integration outcome is the orchestration's
  `integration` (decision, turn, push status, PR/MR, commit).
- **Boundary key** `orchestration_titles` is a flat, optional key of `JobDataBoundary` (absent =
  `omit`), not a nested `orchestration.titles`.
- **job-host-v2 gains more than `cleanup`:** report `features` (`orchestration_v1`, allowed only with
  `publish_refs: send` — the mechanism behind "a runner that refuses SHAs doesn't advertise the
  feature"), run machine `repository.base_sha` with the failed reason `ref_mismatch` (pinned bases
  on runtime repositories) and `publish.orchestration` (`plan` / `node` / `integration`: the
  publisher must know which bundle rule, branch and commit message apply). Cleanup items are checked
  one by one so a bad item can't discard a desired state.
- **Names.** Node keys `plan` and `plan-…` are reserved (plan branches); the integration branch
  defaults to `kete/job/<o8>` and a `branch_suffix` starting with 8 hex digits and `-` is refused.
- **DAG rules made precise** (`validateOrchestrationPlan`, vectors): a dependency is a listed node or
  a held `succeeded`/`succeeded_empty` one; `base_from` is any transitive dependency; repeating a
  succeeded node exactly is a no-op; held `pending`/`ready`/`blocked` nodes left out are superseded.
- **Not served yet, guarded.** The served v2 poll treats a report with any of the new fields as one
  failing the schema (as before they existed) until O11, because `job_data_boundary_valid` still
  takes exactly three keys.

### Review amendments (O1, 2026-10-09)

- **Budget floor.** Each coordinator turn gets `coordinator_turn_budget_micros` and the same amount is
  held as the reserve, so creation requires `budget ≥ 2 × reserve + 0.25 USD` (the least a node may
  be given); the minimum budget is 1.25 USD. A plan fits when `allocated + plan cost + reserve ≤
  budget`, where `allocated` already counts the running turn and the plan cost is the budget of every
  listed node that will run (new, redefined `pending`/`ready`/`superseded`, retries), exact repeats of
  succeeded nodes excluded (`orchestrationPlanCost`).
- **Branch namespace (narrows jobs-v1).** A requested `branch_suffix` of 8 hex digits alone or
  followed by `-`, any case, is refused for every job and orchestration, so no member can pre-create
  an orchestration's create-only branches. Cleanup items name exactly a plan or node branch. The
  platform never issues an orchestration id whose `<o8>` collides with an orchestration of the same
  repository that is still open or still has branches awaiting cleanup.
- **Prompt binding.** A worker's spec carries the committed `prompt_digest`; the entrypoint refuses a
  plan-file prompt with another digest (`prompt_mismatch`).
- **Titles** are refused (`title_not_permitted`), not silently dropped, when the narrowed boundary
  omits them; stored titles and summaries pass the platform's secret-shape redactor. A decision's
  summary is ≤ 4,096 UTF-8 bytes and refused with a NUL or a lone surrogate.
- **One reading of a plan file.** Strict JSON: canonical non-negative integers only and no duplicate
  or case-variant member names (`not_canonical`), case-sensitive names, so TypeScript and Go read the
  same bytes identically. Issues sort by code units.
- **Retries.** A retry is refused once the attempts made reach the smallest of the node's
  `max_attempts` as first committed (a revision may lower it, never raise it), the listed value and
  the hard cap.
- **Accepted residual risk: a metadata covert channel.** A coordinator (or code steering it) in an
  enterprise zone chooses node keys, dependency shapes, budgets, timeouts, attempt counts and the
  timing of plans and decisions, all of which reach the platform. A compromised coordinator could
  encode a few hundred bytes of repository content per turn into them. The plan-file content (prompts,
  notes) never crosses, keys are bounded (32 characters, ≤ 16 nodes, ≤ 6 turns) and titles are
  boundary-gated; the remaining low-bandwidth channel is accepted, as for job outcomes and timing
  today, and is noted for enterprise reviews.
- **Guard.** Until O11 the served v2 poll also treats a report with a machine reason `ref_mismatch` as
  failing the schema.

## Runtime notes (O2, O6, O7, 2026-10-10)

What kete-code built against the contract (task `docs/tasks/2026-10-10-orchestration-runtime`):

- **Feature.** The cloud entrypoint announces `orchestration_v1` (with `clone_revoke_callback`);
  the `kubevm` entrypoint doesn't until the runner's publisher handles orchestrated jobs (O10). An
  orchestrated claim passes `checkOrchestratedClaim`'s port before anything is cloned.
- **Pinned base.** When the orchestration's base branch has moved past the pinned `base_sha`, the
  entrypoint remakes the pristine copy at exactly that commit, fetched by its id (a git host must
  serve reachable commits by id, as GitHub does; Harness Code is unverified). A node-based job's base
  that moved is refused (`ref_mismatch`), never followed.
- **Extra refs.** Fetched in the clone phase as `refs/heads/<branch>` into `refs/kete/<name>`, each
  checked at its pinned commit, then copied into the agent's working copy. A worker fetches the tips
  only (reference); a coordinator fetches the history down to the pinned base, so the tool user can
  merge node branches locally with no network.
- **Bundles.** A coordinator turn whose working tree holds `.kete-orchestration/plan.json` publishes
  exactly that file (any other change is left out, with a note on the job); every other bundle, of
  every job, refuses a `.kete-orchestration` path (`push_error: unreadable`).
- **The tool.** `orchestrate` exists only in job mode for a coordinator turn; it needs no policy
  `allow` of its own (the role is the platform's), but an agent whose rules wholly deny
  `orchestrate` doesn't get it (and the turn then ends `coordinator_no_decision`). Titles and the
  decision's summary leave only from Kete cloud (the entrypoint sets `KETE_JOB_ZONE=kete_cloud` on the cloud path, `enterprise_private` on kubevm) and only where the
  claim allows; elsewhere they stay in-zone until the runner's boundary is wired in (O10). Kete cloud
  has no runner boundary: as with a job's result text, the summary goes to the platform, which
  redacts it and cuts it to 4 KB (the zone's `summary` is effectively `redacted`). The job's id
  reaches `kete` as `KETE_JOB_ID`; the orchestration section travels to `kete serve` on the existing
  descriptor channel.
- **What enforces a planning turn.** The entrypoint's bundle rule (Go, `internal/bundle`
  `applyOrchestration`) is the control; the runtime's deny of the `edit` tools after a proposal is
  advisory (a shell command can still change the tree). A coordinator's bundle is a plan bundle only
  when `kete` recorded a standing proposal (proposed, no decision) in its own state directory
  (`orchestration-turn.json` in kete's home, which the job's tools — another user — can't write);
  then it is exactly the plan file and its SHA-256 must be the recorded `plan_digest`, and the
  platform commits it only when it is the proposal's. Without a standing proposal (a decision was
  made, or no plan) any `.kete-orchestration` path is left out and the rest — the integration — is
  published, so a plan file written by hand can't turn an integration into a plan bundle.
- **Clone token.** Every clone-phase failure (clone, pinned base, verify, extra fetches) releases
  the clone token before the result: GitHub's revoke endpoint, Harness Code's clone-done.
- **Plan-file reader.** Both readers (Go and TypeScript) refuse nesting deeper than 8 levels
  (`not_json`), a Kete addition; its vectors, with minus zero, a lone surrogate in a member name and
  duplicates spelled with `\u` escapes, are in `docs/kete-test-vectors/orchestrations-v1-additions/`
  until the platform's vectors carry them.
- **Threat model: plan metadata leaves the zone.** Node keys, dependencies, agents, budgets,
  timeouts, attempt counts and the timing of plans and decisions are chosen by the model and sent to
  the platform (the O1 covert-channel residual risk above). On Kete cloud the code is already in
  Kete's zone, so this adds nothing; for enterprise zones (O10) it must be reconsidered — e.g.
  bounding or coarsening what the runner lets through — before orchestration is offered there.
