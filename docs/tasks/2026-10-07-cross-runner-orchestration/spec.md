# Spec: Phase 8 — Agent orchestration across runners (orchestrated jobs)

- Task: `docs/tasks/2026-10-07-cross-runner-orchestration` · Size: program (both repos) · Created: 2026-10-07
- Status: **approved** (maintainer, 2026-10-07: "proceed"; open questions take the recommendations; ADRs 0012 and platform 0026 stay Proposed until the Phase 8 S0 spike and contracts land) <!-- draft → approved → built → closed -->
- Decisions already taken by the maintainer (2026-10-07): **D-O1** the coordinator runs as a job
  inside a runner and asks the platform to start sub-jobs; the platform only schedules; code never
  reaches Kete's platform. **D-O2** one integration PR/MR: each sub-job works on its own branch, the
  coordinator merges them into an integration branch, resolves conflicts, runs tests and opens one
  draft PR/MR. **D-O3** one trust zone per orchestrated task (the org's own runners, or Kete cloud);
  within the zone the platform spreads sub-jobs across runners by capacity; code never crosses
  zones. **D-O4** sub-tasks form a DAG (`depends_on`), run in parallel otherwise; one budget and one
  deadline for the whole task, split by the coordinator; failed sub-tasks can be retried or
  re-planned.
- Builds on: the approved Phase 8 spec `docs/tasks/2026-10-07-enterprise-runtime/spec.md`, ADR 0011
  (kete-code) and platform ADR 0025 (both Proposed); Phase 7 cloud jobs (platform ADRs 0018–0024).
- ADRs drafted with this spec: kete-code `docs/adr/0012-cross-runner-orchestration.md`,
  kete-code-platform `docs/adr/0026-orchestrated-jobs.md` (both Proposed).

## Goal
Let one request ("migrate the payments service to the new SDK and update its three clients") be
split by a coordinating agent into sub-tasks that run as separate jobs on separate runners, in
parallel where the dependencies allow, inside one trust zone, under one budget and one deadline,
and come back as **one tested draft PR/MR**. Reuse the Phase 7 job lifecycle and the Phase 8
runner unchanged wherever possible: every unit of work stays an ordinary job.

## Reading guide (≈15 minutes)
§1 what exists · §2 the design in one picture · §3 the model (orchestration, coordinator turns,
nodes) · §4 how the coordinator asks for sub-jobs · §5 handing work back through Git · §6 waiting
(continuation turns) · §7 scheduling and placement · §8 failure, retry, cancellation, final status
· §9 UX · §10 security · §11 testing · §12 phased plan · §13 open questions · §14 out of scope,
risks, upstream. Appendices A–F (data model, contracts, plan file, state machines, limits, worked
example) are skimmable.

---

## 1. Today (from the code, 2026-10-07)

| Exists | Where | Use here |
|---|---|---|
| Job lifecycle: create → claim → events → result → finalizing → finish → terminal; sweeper (stuck, `lost`, deadline, orphans); cancel; idempotency key; per-org lock in `create_job` | platform `docs/jobs.md`, ADR 0018, `apps/portal/lib/jobs/*`, migrations `2026100*_jobs*.sql` | **Every coordinator turn and every sub-task is an ordinary job.** No second lifecycle |
| Per-job budget enforced atomically by the gateway (`authorize_job_request` locks the job row; `budget − spent − in-flight`) | migration `20261003001743_jobs_system_review.sql` | Unchanged per job; the orchestration **allocates** job budgets from one cap (§3.3) |
| Push path: platform validates the hostile bundle and creates one commit on exactly `base_sha`, create-only, optional draft PR (ADR 0021/0024); enterprise: the runner's publisher does the same in-zone (ADR 0011 rule 3) | `lib/jobs/push/*`, `lib/jobs/bundle/*`; runner P3 | **The only way code moves**: node branches, plan branches and the integration branch all go through it |
| Placement: `selfhosted` adapter, `job_host_candidates` ordered by free slots, no queue (one start retry after 6 min, then `host_unavailable`) | `lib/jobs/host/selfhosted/adapter.ts`, `20261003180000_job_hosts.sql` | Reused; the orchestration adds a **platform-side wait** (`ready`) so nodes don't fail for lack of capacity |
| Org-owned runners, placement by org/execution target, data boundary set by the runner | ADR 0025 rules 1–5, Phase 8 spec §3 | One zone per orchestration = the execution target; boundary applies to new fields |
| Local orchestration in one runtime: `subagent` tool (timeout, concurrency 4, stop cascade, permission ceiling, depth), worktree subagents, `workflow` tool (DAG of steps, Kahn validation, waves) | kete-code cards `subagents`, `worktrees-parallel`, `workflows` | Model for the coordinator tool and DAG validation; still available **inside** a job (in-VM parallelism) |
| Job mode: only synced agent, no project config/MCP, fail-closed unattended policy, `kete` reaches gateway + platform only (port A) | card `job-mode`, `egress`; ADR 0008 | The coordinator tool lives here, reaching the platform with the job key |
| Triggers: portal, API, Slack (`lib/slack/jobs.ts` → same handlers), Harness step `cloud` mode (`POST /api/v1/jobs` + polling) | platform, `packages/kete-harness-plugin` | Gain an "orchestrate" option calling the new routes |

What orchestration buys over in-VM subagents: separate VMs (CPU, memory, parallel builds and
tests), wall time beyond one job's 120-minute cap and the host's 135-minute VM kill (ADR 0023
rule 12), branch-level isolation and per-sub-task audit.

---

## 2. Design in one picture

```text
 Kete platform (schedules only; never sees code from an enterprise zone)
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ orchestration O (budget, deadline, DAG of nodes: keys, deps, budgets, states, SHAs)      │
 │   turn 1 job ──► nodes n1,n2 (parallel) ──► n3 (depends n1, base = n1's branch)           │
 │   ──► turn 2 job (integrate) ──► draft PR/MR                                              │
 │ scheduler = SQL `orchestration_advance` called from route after() + the 5-min sweeper    │
 └──────────▲─────────────────────────────────────────────────▲───────────────────────────┘
            │ plan metadata, decisions (job key)               │ ordinary job callbacks / runner polls
 ───────────┼──────────────────── trust zone (Kete cloud OR the org's runners) ─┼─────────────
            │                                                  │
  coordinator turn 1 (job, runner A)        worker n1 (job, runner B)   worker n2 (job, runner A)
  reads code, writes plan file ──push──►    fetches plan ref, prompt     ...
  `kete/job/<o8>-plan-1`                    from plan file; works;
                                            push ► `kete/job/<o8>-n1`
  coordinator turn 2 (job, any runner): fetches node branches (pinned SHAs) + plan, merges,
  resolves conflicts, runs tests ──push──► `kete/job/<suffix>` + draft PR/MR; node/plan branches deleted
            │
         Git remote of the repository (GitHub / Harness Code for Kete cloud; GitLab in the enterprise)
```

Everything that can contain code — sub-task prompts written by the coordinator, the coordinator's
notes, child results, diffs — travels **only through Git in the zone's own repository**, via the
zone's existing push path. The platform holds keys, dependencies, budgets, states, branch names and
commit SHAs.

---

## 3. The model

### 3.1 Three kinds of record

| Record | What it is | Lifetime |
|---|---|---|
| **Orchestration** (new table `job_orchestrations`) | The user's task: prompt, repo, base, zone, budget, deadline, limits, status, integration branch and PR. Shown to users as an "orchestrated job" | Up to the orchestration timeout (default 120 min, max 480) |
| **Coordinator turn** (a `jobs` row, `orchestration_role = coordinator`, `turn = n`) | One run of the coordinating agent: turn 1 plans; later turns re-plan or integrate | One job (≤ 120 min) |
| **Node** (new table `job_orchestration_nodes`) + its **attempts** (`jobs` rows, `role = worker`, `node_id`, `attempt`) | One sub-task in the DAG; each attempt is an ordinary job | One job per attempt |

**Why the parent is not itself a `jobs` row.** ADR 0018 rule 2 says one job = one container =
one `kete job run`, and every job rule (claim token, `deadline` ≤ 130 min, sweeper's `lost`,
gateway key lifetime) assumes that. A coordinator that waits for children spans several
containers (§6), so the parent is a record of its own and each container it uses is a normal job.
For users and the API the orchestration *is* the parent job: one id, one status, one budget, one
PR. (This refines the brief's "parent job + child jobs"; see Q3.)

### 3.2 Depth and fan-out

- **Depth 1.** Only coordinator turns can request nodes; workers can't (the tool isn't registered
  for them and the platform route refuses a worker's key). No nested orchestration.
- Limits per orchestration (platform-enforced, Appendix E): ≤ 8 nodes per plan revision, ≤ 16
  nodes in total, ≤ 6 coordinator turns, ≤ 3 attempts per node, `max_parallel` 1–8 (default 4),
  ≤ 32 jobs in total. Per org: running orchestrated jobs count toward the org's concurrency limit
  (§7.2).

### 3.3 One budget, enforced atomically

- The orchestration has `budget_micros` (default 10 USD, max 100 USD — Q4). Every job it creates
  gets its own `budget_micros` **carved out** of it. The platform enforces, under the
  orchestration row lock (`select … for update`), at every job creation:
  `Σ over its jobs (open: greatest(budget, spent); terminal: spent) + new job budget + reserve ≤ orchestration budget`.
- The gateway is unchanged: it caps each job by that job's own budget exactly as today. No double
  accounting, no new gateway lock. A child's unspent budget flows back automatically when it ends
  (its term switches from `budget` to `spent`).
- **Reserve:** one coordinator-turn budget (`coordinator_turn_budget_micros`, default 15% of the
  total, min 0.50 USD, max the job maximum) is never allocatable to nodes, so a final integration
  turn can always run.
- **Lock order:** only allocation takes the orchestration lock and it never locks existing job
  rows; job transitions and gateway calls never take the orchestration lock. No deadlock path.
- **Credit balance (ADR 0022 M5):** checked once at orchestration creation for the whole budget;
  an open orchestration counts as one outstanding obligation (`budget − Σ spent`) in later
  balance checks, and its own children aren't re-checked against the balance (they draw on an
  amount already covered). The gateway's per-request credit check stays.
- **Enterprise without the gateway:** each job's budget is enforced by the runtime (ADR 0008,
  ADR 0025 rule 6); the platform enforces the allocation sum; spend is "reported by the runner".

### 3.4 One deadline

`orchestration.deadline = created_at + timeout + 10 min`. Every job's deadline is clamped to it.
The scheduler starts no node whose minimum useful time (15 min) doesn't fit before
`deadline − integration_reserve` (default 30 min). At that point running nodes are cancelled and
a **final** coordinator turn is started (§8.3).

---

## 4. How the coordinator requests sub-jobs

### 4.1 The `orchestrate` tool (kete-code, job mode, coordinator turns only)

Registered by Kete-owned code (from `KeteJobPlugin` or a sibling plugin, the `workflows.ts`
pattern of `ctx.tool`) only when `KETE_JOB_MODE=1` **and** the job spec carries
`orchestration.role = "coordinator"`. Actions (discriminated union):

| Action | Effect |
|---|---|
| `plan` `{ notes, nodes: [{ key, title?, prompt, depends_on[], base_from?, agent?, budget_usd, timeout_minutes }] }` | Validates locally (schema, sizes, keys, acyclic — the Kahn check `workflows.ts` uses, factored into a shared Kete helper), then `PUT {platform}/api/v1/jobs/{job_id}/orchestration/plan` with **metadata only** (no prompts, no notes; title per boundary) plus `plan_digest`. On 200 it writes `.kete-orchestration/plan.json` (prompts + notes, Appendix C) into the working tree through job mode's confined file writes. Errors come back to the model to fix within the same turn. Callable again in the turn (replaces the proposal) |
| `status` | Returns the platform's view of the orchestration (nodes, states, attempts, outcomes, cost, SHAs; summaries only where the zone allows). The same state is injected into the turn's first message |
| `finish` `{ decision: "integrated" \| "abandon", summary }` | `POST …/orchestration/decision`. `integrated` = this turn's change is the integration result (pushed as the integration branch with the draft PR/MR); `abandon` = end as failed, nothing pushed except cleanup |

A turn must end with exactly one of: a committed `plan` or a `finish`; a turn that ends with
neither ends the orchestration `failed` (`coordinator_no_decision`) — no hidden failure, no loop.

### 4.2 Credentials and validation

- The tool authenticates with the turn's **job key** (`kete` already holds it on fd 3; port A
  already allows the platform host). ADR 0020 rule 3 is amended: a coordinator job's key may call
  the orchestration routes **of its own orchestration** while the job is `running`. Worker keys
  can't (403). Enterprise jobs without the gateway get a sync-only key with this scope added.
- The platform validates, under the orchestration lock: limits (§3.2), budget (§3.3), timeouts
  (≤ 120, ≤ remaining time), `agent` ∈ the orchestration's `worker_agents` (chosen by the
  requester at creation, default the coordinator's agent; each enabled in the org), `base_from` is
  absent (the orchestration's pinned base) or a node of this orchestration that is an ancestor in
  the DAG, keys unique and stable across revisions (`^[a-z][a-z0-9-]{0,31}$`), no re-use of a
  succeeded node's key with different content.
- **There is no repo, zone, branch, model, policy or deadline parameter.** Repository, base,
  execution target and pool are the orchestration's; the branch is derived
  (`kete/job/<o8>-<key>`); the model is the agent's pinned model; the policy is the orchestration's
  compiled `allow` (docs/jobs.md §5), which the coordinator can't widen.
- **Idempotency:** the proposal is keyed by (orchestration, turn job); nodes are unique on
  (orchestration, key); attempts on (node, attempt). Re-sending the same proposal is a no-op.

### 4.3 What a child receives

The platform creates each attempt as a normal job with a compiled spec: agent, model pin, policy,
budget, timeout, `branch = kete/job/<o8>-<key>`, and `orchestration: { id, role: "worker", node,
attempt, plan: { ref, sha, path } }`. The claim response adds `fetch` (extra refs with pinned
SHAs). The **prompt is not on the platform**: the entrypoint fetches the plan ref during the clone
phase, verifies its SHA, reads the node's prompt from `.kete-orchestration/plan.json` with its own
safe reader (≤ 64 KiB per node, UTF-8, key must match), and gives it to `kete job run`. The base
is the orchestration's pinned `base_sha`, or the commit SHA recorded for the `base_from` node.
Other dependencies are ordering-only; their branches are fetched read-only for reference.

---

## 5. Handing work back without code crossing the platform

**Recommendation: intermediate branches are pushed to the repository's remote** (not a zone-internal
artifact store). Git is the only store both zones already have, already secured (create-only push
on an exact base, hostile-bundle validation, draft PRs), already audited and visible to reviewers.
An artifact store would be new infrastructure in both zones (Kete Storage is in Kete's zone; the
runner's outbox PVC is per job and short-lived).

| Branch | Content | Pushed by | Deleted |
|---|---|---|---|
| `kete/job/<o8>-plan-<rev>` | base + exactly one file `.kete-orchestration/plan.json` | the turn's normal push (platform for Kete cloud, publisher in the enterprise) | at orchestration end (below) |
| `kete/job/<o8>-<key>` | the node's single commit on its base; commit message carries the node's result summary (the **handoff note**, written in-zone: the platform for Kete cloud, which already holds the summary; the publisher for the enterprise, which holds the local one) | same | same |
| `kete/job/<suffix>` (integration) | one commit on `base_sha` with the merged result; draft PR/MR whose body lists nodes, SHAs, status and the coordinator's summary (in-zone) | same, with `open_pr` | never (it is the deliverable) |

All names stay under `kete/job/`, so the existing `branch like 'kete/job/%'` constraint and the
documented advice to exclude `kete/job/*` from CI keep working; pushes carry `[skip ci]` as today.

**Bundle rules (both validators, shared vectors):** a plan turn's bundle must contain exactly the
one path `.kete-orchestration/plan.json` (≤ 256 KiB); every other bundle refuses any
`.kete-orchestration` component. Plan turns run with `edit`/`write` denied by policy (the tool
writes the plan file), so code can't ride along on a plan branch.

**Pinned bases (amends ADR 0021 rule 8 for orchestrated jobs only):** a node may be based on a
sibling node's branch, which is not protected. Instead of protection, the platform pins the SHA it
recorded when it (or the runner) created that branch; the entrypoint verifies the fetched ref
equals it, else refuses (`ref_mismatch`). The orchestration's own base still needs ADR 0021 rule 8
protection; its `base_sha` is resolved once at turn 1's claim and reused by every job.

**Integration (a coordinator turn).** The claim's `fetch` lists every succeeded node branch and the
latest plan branch with pinned SHAs; the entrypoint fetches them in the clone phase (the only phase
that reaches the Git host) into the pristine copy and exposes them in the agent's copy as
`refs/kete/nodes/<key>` and `refs/kete/plan`. The coordinator merges locally (git runs as the tool
user through the root helper; no network), resolves conflicts, runs the tests the policy allows,
and calls `finish integrated`. The entrypoint builds the bundle from the working tree against
`base_sha` as for any job, so **every line of the integration passes the same hostile-bundle
validation**, and the PR is one commit on the base (ADR 0021 rule 7 unchanged).

**Cleanup:** at a terminal orchestration the platform (Kete cloud: GitHub/Harness with a per-call
token) or the runner (enterprise: a `cleanup` item in job-host-v2 desired state) deletes each plan
and node branch **only if it still points at the recorded SHA** (compare-and-delete; a branch a
human moved is left alone and reported). Success: delete right after the PR/MR exists. Failure or
cancel: keep for 7 days for debugging, then delete (Q8).

---

## 6. Waiting: continuation turns, not a long-running coordinator

**Recommendation: the coordinator job ends after planning; the platform starts a new coordinator
turn when the DAG goes quiescent** (no node running, ready or runnable). State carries over through
the platform's DAG and the plan file's `notes`, plus the code itself.

| | Long-running coordinator | **Continuation turns (recommended)** |
|---|---|---|
| Job lifetime | Breaks the 120-min job cap, the 130-min deadline and the host agent's 135-min VM kill (ADR 0023 rule 12) for any non-trivial DAG | Each turn is a normal job well inside the caps; the orchestration can run up to 480 min |
| Capacity and cost | Holds a slot and a VM idle while children run; model context grows with polling | No idle slot; pays a VM boot + clone (≈1–2 min) per turn |
| Outbound-only runners | Needs a polling loop from inside the VM | Nothing new: the platform schedules, runners pull |
| Crash recovery | A crash loses the orchestration (ADR 0018 rule 12: no resume) | A lost turn is retried (§8.1); state lives on the platform and in Git |
| Credentials | Gateway key and callback token live for hours | Normal per-job lifetimes |
| Cost of the choice | — | The coordinator re-reads context each turn; mitigated by notes, the state summary, and handoff notes in commit messages |

The wake rule is deliberately simple for v1: wake when quiescent, or at the integration-reserve
point (final turn). No early wake on the first failure (a turn running concurrently with nodes
would race the DAG).

---

## 7. Scheduling and placement inside one zone

### 7.1 The scheduler

- `orchestration_advance(orchestration_id)` (SQL, `security definer`, under the orchestration
  lock): marks nodes `ready` whose dependencies succeeded; marks nodes `blocked` whose dependency
  ended without success; admits `ready` nodes up to `max_parallel` and the org's limit by creating
  their job rows (budget allocation in the same transaction); decides whether a coordinator turn is
  due. It returns the jobs to start; TypeScript calls the existing `adapter.start` for each.
- Called from the `after()` of every callback or action that ends an orchestrated job (result,
  finish, cancel, publish report, sweeper transitions) and, as a backstop, by the sweeper every
  5 minutes for each active orchestration. Idempotent; a missed call only delays.
- No queue service: the wait is a node state in the database. A node that can't be admitted stays
  `ready`; it never becomes `host_unavailable` for lack of org capacity.

### 7.2 Capacity, spread, affinity, fairness

- **Zone:** every job inherits the orchestration's execution target and pool (ADR 0025 rule 2):
  `kete_cloud` → the `KETE_JOB_HOST` backend; `enterprise_private` → active hosts of the same org
  only. Cross-zone placement is impossible by construction (no per-node zone field).
- **Spread:** reuse `job_host_candidates` (ordered by most free slots, then freshest report), which
  already spreads jobs across hosts and clusters of the zone. Fly: one machine per job.
- **Org concurrency:** today `JOB_ORG_CONCURRENCY_LIMIT = 2` for the whole org, which makes
  orchestration pointless. Proposed (Q5): an org-level limit from the plan/entitlement (default 8
  with orchestration enabled; enterprise: capped by the slots its runners report and a platform
  per-org cap). Orchestrated jobs count toward it; nodes beyond it wait `ready`; a standalone
  `POST /api/v1/jobs` keeps answering 409 at the limit.
- **Fairness:** admit `ready` nodes oldest-orchestration-first within an org, at most
  `max_parallel` per orchestration; the platform-wide `KETE_JOBS_PLATFORM_LIMIT` applies to all.
- **Affinity:** optional pool label on the orchestration (e.g. one cluster). No cache affinity in
  v1 (every job gets a fresh VM by design, ADR 0005/0019).
- **Rate limits (ADR 0022 M4):** creating an orchestration counts as one job creation; its jobs are
  bounded by the per-orchestration job cap (≤ 32) instead of the hourly limit.

### 7.3 A runner dies mid-child

Unchanged detection: heartbeats stop → the sweeper fails the job `lost` after 5 minutes and revokes
its credentials; a stale host is never assumed gone (ADR 0023 rule 11). New: the node gets one
automatic **infrastructure retry** (§8.1), placed on any eligible host of the zone. The runner's own
deadline killer and orphan reconcile clean up the dead machine when it comes back.

---

## 8. Failure, retry, re-plan, cancellation, final status

### 8.1 Two kinds of failure

| Job outcome | Kind | What happens |
|---|---|---|
| `host_unavailable`, `claim_timeout`, `lost`, `finish_timeout`, publish `failed` for a transient reason | infrastructure | Platform re-creates the attempt **once** with the same spec (new job, new claim token); a second infra failure marks the node `failed`. Same for a coordinator turn. *Amends ADR 0018 rule 12 for orchestrated jobs only* (Q6) |
| `error`, `refused`, `budget`, `time_limit`, push `refused`/`no_changes` | agent | Node `failed` (or `succeeded_empty` for `no_changes`); dependants `blocked`; coordinator decides at the next turn |

The coordinator's options at a turn: **retry** a node (same key, new attempt, optionally a new
prompt in a new plan revision, a new budget from the remaining pool), **re-plan** (new nodes,
supersede pending ones — superseded nodes are `cancelled` if not started), **integrate** what
succeeded, or **abandon**.

### 8.2 Cancellation propagates

Cancel the orchestration (requester with `agents.run`, others `agents.write`; or org disabled,
flag off, requester suspended — the existing `job_cancel_active` triggers) → orchestration
`cancelling` in one transaction (no further admissions or turns, pending/ready nodes `cancelled`),
then each open job is cancelled through the existing per-job cancel in its own transaction (a job
whose push has begun finishes it, as today). When every job is terminal → `cancelled`; cleanup per
§5. Cancelling a single node is allowed (same permissions) and counts as an agent failure.

### 8.3 Deadline, partial results, final status

- At `deadline − integration_reserve` the platform cancels running nodes and starts a **final**
  turn (`orchestration.final = true`): it may only `finish` (integrate the succeeded subset, or
  abandon), not plan.
- Final status:

| Orchestration status | When |
|---|---|
| `succeeded` | a turn called `finish integrated` and its push ended `created` (PR/MR opened) or `no_changes` (outcome `no_changes`, no PR). `partial = true` when any node ended `failed`/`blocked`/`cancelled`; the PR/MR body says which, and the PR stays draft |
| `failed` | `abandon`, `coordinator_no_decision`, turn limit or budget exhausted without integration, coordinator turn failed twice (infra) or once (agent), integration push refused |
| `timed_out` | the deadline passed before the final turn's push was recorded |
| `cancelled` | §8.2 |

Every node, attempt and turn keeps its own job record, so partial work is always visible.

---

## 9. UX

- **Portal:** "Orchestrated job" option on the job form (needs the entitlement, `agents.run` and
  `jobs.push`): repository, base, coordinator agent, worker agents, prompt, budget, timeout,
  `max_parallel`. The orchestration page shows the DAG (nodes as boxes, edges from `depends_on`,
  state colour, attempt count, cost bar against the budget, deadline countdown), the turns timeline,
  and links to each job's existing page. Enterprise zones show node keys only unless the runner
  allows titles; summaries are labelled "reported by the runner" or "not shared by your runtime".
- **API:** `POST/GET /api/v1/orchestrations`, `GET /api/v1/orchestrations/{id}` (includes nodes
  and jobs), `POST …/cancel`, `POST …/nodes/{key}/cancel` (Appendix B). `Job` gains an optional
  `orchestration` reference.
- **Slack:** the existing job command gains an orchestrate variant through the same session-caller
  seam (`lib/slack/jobs.ts`); the thread is updated at plan, each node end and the final result.
- **Harness step:** `cloud` mode gains `orchestrate: true` (polls the orchestration; outputs the
  PR URL, status, `partial`). `run` mode is unchanged (no platform scheduler in a pipeline).
- **CLI:** no user-facing `--orchestrate` in v1 (Q10). `kete job run` learns the spec's
  `orchestration` section (behind the claim feature), which is how tests drive coordinator and
  worker turns against a fake platform. For local, interactive multi-agent work the existing
  `workflow` tool and worktree subagents remain the answer.
- **Final summary** (portal, Slack thread, Harness output): status, `partial`, PR/MR link (subject
  to `publishRefs`), per-node table (key, status, attempts, duration, cost), total cost vs budget,
  and the coordinator's summary only where the zone's boundary allows (Kete cloud: redacted 4 KB;
  enterprise default `summary: none` → nothing; the full summary is in the in-zone PR/MR body).

---

## 10. Security

| Threat | Mitigation |
|---|---|
| **Prompt injection from repo content into the coordinator → child prompts** | Children are never more powerful than the coordinator: policy, agent set, model, repo, zone, budget and deadline all come from the orchestration, not the plan; the tool can only narrow. Child prompts are data in Git, read by the child under the same unattended fail-closed policy as any job (ADR 0008). Worst case equals a malicious prompt to an ordinary job: bad code in a draft PR |
| **Child → coordinator injection** (handoff notes, child code) | The coordinator treats node branches and commit messages as untrusted input; it runs child code only as the tool user inside its own VM (same as running repo code); no credential is reachable by tools (ADR 0019 rule 5) |
| **Fan-out / budget exhaustion** | Hard caps (§3.2, Appendix E) in SQL under the orchestration lock; allocation sum ≤ budget; reserve; per-org concurrency; per-orchestration job cap; turn cap; deadline |
| **Malicious child branch poisoning the integration** | Node branches are created create-only from validated bundles; fetched by **pinned SHA** (a branch moved by anyone after creation is refused); the integration result is itself one validated bundle; CI/Kete config paths refused (ADR 0021 rule 6); integration runs tests; PR/MR always draft; protected base |
| **Code reaching Kete from an enterprise zone** | Prompts, notes, handoff notes and diffs stay in Git in the zone; the platform receives keys, deps, budgets, states, SHAs, branch names; titles and summaries follow the runner's boundary (new key `orchestration.titles: omit \| send`, default `omit`). SHAs and branch names are required for orchestration; a runner that refuses them doesn't advertise the feature |
| **A worker key used to orchestrate** | Route checks key kind `job`, role `coordinator`, job `running`, same orchestration (403 otherwise); tool not registered for workers |
| **Plan branch smuggling code** | Plan-bundle rule: exactly one path; plan turns deny `edit`/`write` |
| **Replay / duplicate scheduling** | Unique keys on (orchestration, key), (node, attempt), (orchestration, turn); advance is idempotent under a lock |
| **Audit** | `orchestration_events` (append-only); `audit_events` `agent.orchestration.{started,completed,failed,cancelled}`; every job's existing `agent.job.*` events and metadata carry `orchestration_id`, `role`, `node_key`, `attempt`, `turn`; the runtime's audit log records the same ids in its session start line; enterprise full logs go to the enterprise sink with those ids |

---

## 11. Local-first testing

- **Platform:** pgTAP for allocation races (parallel `orchestration_propose_plan` and job
  creations never exceed the budget), limits, tenancy (an org's orchestration never sees another
  org's hosts or nodes), state transitions; route tests with the fake host adapter
  (`lib/jobs/host/fake.ts`) and fake repo access/push providers; the existing local end-to-end
  test against fakes extended with a scripted orchestration (turn 1 plans 3 nodes, one fails
  `lost` then succeeds, integration turn finishes).
- **kete-code:** core tests for the tool (registration only for coordinators, validation, plan
  file writing, error surfacing); entrypoint tests with `fakeplatform` (extra fetches, pinned-SHA
  refusal, worker prompt from plan, plan-bundle mode); `kete-job-image` e2e with the fake model
  scripting a coordinator turn and a worker turn; a shared DAG-validation helper tested once.
- **Enterprise path:** kind + the fake GitLab from Phase 8 P3 + the runner on the test-only
  shared-kernel build: an orchestration across two runner host identities in one org.
- **Needs real infra:** Kete cloud staging (Fly + a GitHub test org) for acceptance; the Phase 8
  pilot cluster for the enterprise acceptance run.

---

## 12. Phased build plan

Small PRs, each mergeable alone, behind `KETE_FLAG_ORCHESTRATION` (platform, fails closed) and the
claim feature `orchestration_v1` (runtime: inert unless the platform sends it). Contracts first.

| # | Repo | Piece | Acceptance (summary) | Real infra? |
|---|---|---|---|---|
| **O0** | both | This spec, ADR 0012 (kete-code), ADR 0026 (platform) approved | maintainer approval | — |
| **O1** | platform | Contract `orchestrations-v1` (Zod in `packages/shared`, standalone copy, vectors); jobs-v1 additive: feature `orchestration_v1`, claim `fetch`, worker `plan` ref, `spec.orchestration`, `Job.orchestration`; plan-bundle path rule + vectors | schemas, consistency tests, vectors | — |
| **O2** | kete-code | Contract copies; job spec v1 parser accepts `orchestration` (only with the feature); Go claim types | vectors byte-identical; spec tests | — |
| **O3** | platform | Migration: `job_orchestrations`, `job_orchestration_nodes`, `orchestration_events`, `jobs` columns; functions create/propose/commit/advance/decide/transition; allocation and reserve; limits; RLS, column grants (prompt like `jobs.prompt`), pgTAP incl. races and tenancy | pgTAP green; allocation never exceeds budget under concurrent calls | — |
| **O4** | platform | Routes: user orchestration routes, coordinator job-key routes; scheduler from `after()` + sweeper backstop; infra retry; deadline/reserve/final turn; cancel cascade; per-org concurrency setting | route tests with fake host; sweeper tests | — |
| **O5** | platform | Push path: `<o8>-plan-<rev>` / `<o8>-<key>` names, pinned sibling base, plan-bundle rule, refusal of `.kete-orchestration` elsewhere, handoff note in the commit message, compare-and-delete cleanup (GitHub, Harness), 7-day retention in the sweeper | push tests with fakes; existing GitHub/Harness tests unchanged | — |
| **O6** | kete-code | Entrypoint: advertise `orchestration_v1`; fetch extra refs in the clone phase with SHA checks; expose `refs/kete/*` in the agent copy; worker prompt from the plan file; plan-bundle mode | `fakeplatform` tests; image e2e | — |
| **O7** | kete-code | Runtime: `orchestrate` tool (coordinator only), plan file writer, state injection, built-in coordinator skill, plan-turn policy, shared DAG helper | core Kete tests; image e2e with scripted fake model | — |
| **O8** | platform + kete-code | Portal form + DAG page; Slack orchestrate; Harness `cloud` `orchestrate: true` (kete-code `kete-harness-plugin`) | page tests; plugin tests against the fake platform | — |
| **O9** | both | Kete cloud end to end on fakes (CI) → staging acceptance | scripted e2e green; one real orchestration on staging opens one draft PR and deletes node branches | **yes**: staging Fly + GitHub test org |
| **O10** | kete-code | Runner: publisher handles plan bundles, node names, handoff note, cleanup desired-state items; boundary key `orchestration.titles`; advertise feature | kind + fake GitLab e2e across two host identities | — |
| **O11** | platform | Orchestrated jobs on org hosts: placement via ADR 0025, publish report → node SHA, per-org concurrency from runner slots, job-host-v2 `cleanup` | route tests; pgTAP tenancy | — |
| **O12** | both | Enterprise end to end with P4e; pilot | kind e2e green; pilot run | **yes**: pilot cluster |
| **O13** | both | Docs and cards (`orchestration` card in kete-code, platform `docs/jobs.md` section, runbook) | reviewed | — |

**How it slots into Phase 8:** O0 now. O1–O2 start **after P0b/P0c merge** (they touch the same
contract modules and vectors). O3–O9 (the Kete cloud path) need nothing from the runner and run in
parallel with P1–P3. O10 needs P2 + P3; O11 needs P4a + P4b; O12 joins P4e and the pilot. P5
(interactive sessions) is independent. This keeps the Phase 8 order intact: the runner is not
delayed, and orchestration reaches enterprises no earlier than the runner itself is reliable.

---

## 13. Open questions (each with a recommendation)

1. **Q1 — Waiting model.** *Recommend:* continuation turns (§6). This is the choice everything else
   depends on.
2. **Q2 — Where child prompts live.** In-zone in the plan branch for every zone (recommended: one
   mechanism, honours D-O1 strictly, also gives the coordinator memory) vs on the platform for Kete
   cloud only (simpler for Kete cloud, two mechanisms). *Recommend:* in-zone everywhere.
3. **Q3 — Parent record.** A separate `job_orchestrations` table (recommended, §3.1) vs a `jobs` row
   with a new machine-less `waiting` state (overloads every job invariant).
4. **Q4 — Limits and money.** Budget default 10 / max 100 USD; timeout default 120 / max 480 min;
   ≤ 8 nodes per revision, 16 total, 6 turns, 3 attempts, `max_parallel` ≤ 8. *Recommend:* these for
   the beta; they are configuration, not contract.
5. **Q5 — Org concurrency.** *Recommend:* replace the constant 2 with a per-org limit from the plan
   (8 with orchestration enabled), enterprise capped by runner slots; nodes wait rather than 409.
6. **Q6 — Automatic retry.** *Recommend:* one platform retry for infrastructure outcomes only,
   orchestrated jobs only (amends ADR 0018 rule 12 there); agent failures go to the coordinator.
7. **Q7 — Human approval between steps** (e.g. approve the plan before nodes run). *Recommend:* out
   of v1 — jobs have no approvals (ADR 0018 rule 14, ADR 0008) and the draft PR/MR is the human
   gate; the `waiting` point after a plan turn is the seam for a later "approve plan" gate.
8. **Q8 — Branch retention.** *Recommend:* delete node/plan branches right after a successful
   PR/MR; keep 7 days after failure or cancel; compare-and-delete only.
9. **Q9 — Partial integration.** *Recommend:* allowed, as a draft PR/MR marked partial; the
   alternative (fail the whole orchestration if any node fails) wastes the work done.
10. **Q10 — Local CLI orchestration** (`kete job run --orchestrate` on a laptop). *Recommend:* not in
    v1; the laptop is a zone with no scheduler, and `workflow` + worktree subagents already cover
    local parallel work. Revisit with a local scheduler if users ask.
11. **Q11 — Titles in enterprise zones.** *Recommend:* boundary key `orchestration.titles`, default
    `omit` (portal shows node keys), consistent with `summary: none`.

---

## 14. Out of scope, risks, upstream

**Out of scope (v1).** Cross-zone orchestration; nested orchestration (depth > 1); long-lived or
multi-day workflows and user-authored workflow definitions (§67 Workflow Engine — this design's
node model is a seam for it); human approvals between steps (Q7); more than one repository per
orchestration; preserving per-node commit history in the integration PR (one commit, ADR 0021
rule 7); shared build caches or cache affinity; interactive sessions taking part; laptop
orchestration (Q10); billing changes (orchestrations cost the sum of their jobs).

**Risks.** (1) Coordinator plan quality: poor splits waste budget or conflict heavily — caps, the
reserve and the final turn bound the damage; measure on staging before widening limits. (2) Turn
latency (VM boot + clone per turn). (3) Branch noise and Git host API load (up to ~20 refs per
orchestration; GitHub rate limits) — cleanup and caps. (4) Sweeper and scheduler complexity: the
scheduler is SQL under one lock, called idempotently; pgTAP race tests are part of O3. (5)
Enterprise runners refusing SHAs/branch names via the boundary — the feature isn't advertised
there. (6) Contract churn alongside Phase 8's job-host-v2 — sequenced after P0b.

**Upstream mergeability.** All runtime code in Kete-owned paths: `packages/core/src/kete/` (tool,
DAG helper, skill), `packages/cli/src/kete/` (spec), `packages/kete-job-entrypoint`,
`packages/kete-job-host` (publisher, cleanup), `packages/kete-harness-plugin`. Expected upstream
edits: **none** — the tool registers from the already-registered `KeteJobPlugin` (or one marked
line in `plugin/internal.ts`'s existing Kete block if a separate plugin is cleaner, recorded in
`docs/upstream-patches.md`).

---

## Appendix A — Data model (platform)

**`job_orchestrations`** — `id` uuid pk; `organization_id`, `project_id`, `repository_id`
(composite FKs as `jobs`); `execution_target` (`kete_cloud` | `enterprise_private`), `pool` text
null; `base_ref`, `base_sha` (null until turn 1's claim resolves it, then fixed); `branch`
(`kete/job/<suffix>`, the integration branch), `open_pr` (always true in v1), `pr_url`;
`requested_by`; `prompt` (≤ 256 KiB; column grants as `jobs.prompt`, read via a
`get_orchestration_prompt` like `get_job_prompt`); `coordinator_agent_id`, `worker_agent_ids`
uuid[] (≤ 8); `allow` jsonb (the compiled request rules, docs/jobs.md §5); `budget_micros`,
`coordinator_turn_budget_micros`; `timeout_minutes` (1–480), `integration_reserve_minutes`,
`deadline`; `max_parallel` (1–8); `status` enum `orchestration_status`; `outcome` text ≤ 40;
`partial` bool; `final` bool; `turns` int; `plan_rev` int; `plan_branch`, `plan_sha` (latest
committed); `summary_text` (≤ 4 KB, boundary-filtered); `idempotency_key` (unique with org);
`created_at`, `started_at`, `ended_at`; `cleanup_due_at`, `cleanup_done_at`.

**`job_orchestration_nodes`** — `id`; `orchestration_id`, `organization_id`; `key` (unique per
orchestration); `plan_rev` (revision that last defined it); `title` text null (≤ 80, boundary);
`depends_on` text[] (keys); `base_from` text null; `agent_id`; `budget_micros`;
`timeout_minutes`; `state` enum (Appendix D); `attempts` int; `infra_retries` int;
`current_job_id`; `branch`; `commit_sha` (from `expected_commit_sha` or the runner's publish
report); `outcome`; timestamps.

**`jobs` additions** — `orchestration_id` uuid null FK; `orchestration_role` (`coordinator` |
`worker`) null; `node_id` null; `attempt` int null; `turn` int null. Checks: role set ⇔
orchestration set; coordinator ⇒ node null and turn set; worker ⇒ node and attempt set. Unique
(`node_id`, `attempt`), (`orchestration_id`, `turn`).

**`orchestration_events`** — append-only (trigger as `job_events`): transitions, plan commits,
admissions, retries, cleanup outcomes; metadata ≤ 2 KB, no prompt or code.

**Functions** (all `security definer`, `search_path = ''`, service role only): `create_orchestration`
(org lock; flag, entitlement, limits, balance, idempotency; inserts the orchestration and turn 1
via the internal job creator), `create_orchestrated_job` (internal: the `create_job` checks minus
the hourly limit, plus allocation under the orchestration lock), `orchestration_propose_plan`,
`orchestration_commit_plan` (on the plan turn's push `created`), `orchestration_decide`,
`orchestration_advance`, `orchestration_transition` (the only writer of `status`),
`orchestration_cancel`. `job_apply_transition` is unchanged except for adding the orchestration ids
to its `audit_events` metadata.

## Appendix B — Contract changes

| Contract | Change | Version |
|---|---|---|
| New `orchestrations-v1` (`packages/shared/src/api/v1/orchestrations.ts`, standalone copy, vectors) | User routes: `POST /api/v1/orchestrations` (`Idempotency-Key`; body: `project_id`, `repository_id`, `base_ref?`, `agent`, `worker_agents?`, `prompt`, `allow?`, `budget_micros?`, `coordinator_turn_budget_micros?`, `timeout_minutes?`, `max_parallel?`, `branch_suffix?`) → 201 `{ orchestration }`; `GET /api/v1/orchestrations[/{id}]`; `POST …/{id}/cancel`; `POST …/{id}/nodes/{key}/cancel`. Coordinator routes (job key): `GET /api/v1/jobs/{id}/orchestration`, `PUT /api/v1/jobs/{id}/orchestration/plan`, `POST /api/v1/jobs/{id}/orchestration/decision` | new v1 |
| jobs-v1 claim | request `features += orchestration_v1` (an orchestrated job claimed without it → 404, job `refused`, metadata `entrypoint: outdated`, the `clone_revoke_callback` precedent); response adds `fetch: [{ name, ref, sha }]` (≤ 17) and, in `spec.orchestration`, `{ id, role, turn?, node?, attempt?, final?, plan?: { ref, sha, path } , state? }` | additive, feature-negotiated |
| jobs-v1 `Job` | optional `orchestration: { id, role, node_key?, attempt?, turn? }` | additive |
| kete job spec v1 | optional `orchestration` object (the runtime refuses unknown fields, so only sent with the feature) | additive in-repo (contracts.md §6d) |
| Bundle rules (TS validator, Go port, shared vectors) | plan bundle = exactly `.kete-orchestration/plan.json`; `.kete-orchestration` refused elsewhere | contract change to the vectors |
| job-host-v2 (Phase 8) | desired-state `cleanup: [{ branch, expect_sha }]`, report `cleanup` outcomes; publish report always carries `branch`/`commit_sha` for orchestrated jobs; boundary key `orchestration.titles` | folded into v2 before it ships |
| ADR 0020 rule 3 | coordinator job keys may call their own orchestration's routes | platform ADR 0026 |

## Appendix C — Plan file (`.kete-orchestration/plan.json`, in-zone only)

```json
{
  "version": 1,
  "orchestration_id": "uuid",
  "rev": 1,
  "notes": "coordinator's working notes for later turns (≤ 32 KiB)",
  "nodes": [
    { "key": "sdk-core", "title": "Port core client", "prompt": "…(≤ 64 KiB)…",
      "depends_on": [], "base_from": null, "agent": "developer", "budget_usd": 2, "timeout_minutes": 45 },
    { "key": "client-web", "prompt": "…", "depends_on": ["sdk-core"], "base_from": "sdk-core",
      "agent": "developer", "budget_usd": 1.5, "timeout_minutes": 30 }
  ]
}
```

Whole file ≤ 256 KiB, UTF-8, strict schema. The platform-side proposal carries the same nodes
without `prompt`/`notes` (and without `title` where the boundary omits it) plus `plan_digest`
(SHA-256 of the file). The worker entrypoint reads only its own node's `prompt` and refuses when
the key is missing; powers (agent, budget, timeout, policy) always come from the platform spec.

## Appendix D — State machines

**Orchestration:** `queued` → `coordinating` (a turn job is open) ⇄ `running_nodes` (nodes open, no
turn) → `succeeded` | `failed` | `timed_out`; any non-terminal → `cancelling` → `cancelled`.
Forward-only between terminal states; only `orchestration_transition` writes `status`.

**Node:** `pending` (deps not done) → `ready` (deps succeeded; waiting for capacity) → `running`
(attempt job open) → `succeeded` | `succeeded_empty` (`no_changes`) | `failed`; `pending` →
`blocked` (a dependency didn't succeed); `pending`/`ready`/`blocked` → `superseded` (re-plan) or
`cancelled`; `failed`/`blocked` → `pending` again only by a coordinator retry (new attempt).

**Turn due when:** the orchestration is `running_nodes` and no node is `ready`, `running` or
`pending` with all deps done; or the integration-reserve point is reached (final turn).

## Appendix E — Limits (configuration, platform-enforced)

| Limit | Value (beta) |
|---|---|
| Nodes per plan revision / in total | 8 / 16 |
| Coordinator turns | 6 (the last is forced `final`) |
| Attempts per node (incl. infra retry) | 3 |
| Infra retries per node or turn | 1 |
| `max_parallel` | 1–8, default 4 |
| Jobs per orchestration | 32 |
| Orchestration budget | default 10 USD, max 100 USD; each job ≤ the job max (25 USD) |
| Orchestration timeout | default 120, max 480 min; each job ≤ 120 min; integration reserve 30 min |
| Plan file / node prompt / notes | 256 KiB / 64 KiB / 32 KiB |
| Org concurrency (orchestration enabled) | 8 (enterprise: ≤ reported runner slots) |

## Appendix F — Worked example

1. User asks (portal) "migrate payments to SDK v3 and update web, mobile and admin clients",
   budget 20 USD, 240 min, `max_parallel` 3. Turn 1 (3 USD reserve) claims, pins `base_sha`, reads
   code, calls `plan` with nodes `sdk-core`; `client-web`, `client-mobile`, `client-admin` (each
   `depends_on: [sdk-core]`, `base_from: sdk-core`); 2 + 3×1.5 USD allocated. Turn 1 ends; its
   bundle (the plan file only) is pushed as `kete/job/ab12cd34-plan-1`; the plan is committed.
2. `sdk-core` runs on runner A, pushes `kete/job/ab12cd34-sdk-core`; the platform records its SHA.
   The three clients become `ready` and are spread across runners A, B, C (most free slots).
3. `client-mobile`'s runner dies; the job goes `lost`; one infra retry runs on B and succeeds.
   `client-admin` ends `budget`. Quiescent → turn 2: the coordinator sees `client-admin` failed,
   retries it with a tighter prompt and 1 USD (plan rev 2). It succeeds.
4. Turn 3 fetches the four node branches and plan rev 2 by pinned SHA, merges, fixes a conflict in
   a shared type, runs the tests, calls `finish integrated`. The integration commit is validated and
   pushed to `kete/job/payments-sdk-v3` with one draft PR listing the four nodes. Node and plan
   branches are compare-and-deleted. Status `succeeded`, cost 13.4 / 20 USD.
