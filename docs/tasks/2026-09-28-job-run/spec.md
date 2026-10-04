# Spec: `kete job run` — local unattended jobs (ADR 0005, 0008)

- Task: `docs/tasks/2026-09-28-job-run` · Size: large · Created: 2026-09-28
- Status: approved (user, 2026-09-28)

## Goal
A developer (and later the cloud worker, ADR 0005) can run an agent task unattended from a job spec:
`kete job run job.json` starts a run that nothing can approve mid-way, on its own branch, within a
budget and a time limit, and reports honestly how it ended and where its audit log is.

## Scope
- **Command** (cli): `kete job run <spec.json>` with the same server flags as `kete run`
  (`--server`, `--standalone`, default background service) and `--json` for a machine-readable
  result. JSON only; no new dependency.
- **Job spec (v1)**, validated before anything starts, with clear errors:
  - `version: 1`; `prompt` (string) or `prompt_file` (path, relative to the spec);
  - `agent`, `model` (optional; defaults as `kete run`);
  - `policy`: `allow` rules (`{action, resource}`), `budget` (USD, required), `timeout`
    (minutes, required) — the `kete.unattended` shape (`unattended` card), validated with its schema;
  - `branch` (optional name; default `kete/job/<short id>`).
- **Isolation on a feature branch:** the job creates a git worktree on a new branch from the current
  `HEAD` (`POST /api/worktree`), runs the session there, and leaves the worktree and branch for review
  (never merges or pushes). A job outside a git repository runs in the directory and says so.
- **Unattended session:** the root session is created with `metadata: {"kete.unattended": policy}`;
  the runtime enforces the rest (fail closed, limits, audit). The client never answers a permission
  request for a job; if one arrives, it's rejected and reported as a bug.
- **No self-widening:** in every unattended run (enforced by the runtime, so the cloud worker gets it
  too), edits to the project's `.kete/` directory (and the global Kete config) are denied, whatever
  the agent's rules or the run's `allow` rules say.
- **Output:** the agent's final text on stdout; a summary on stderr (outcome, branch, worktree path,
  cost, duration, audit log path); with `--json`, one JSON object instead.
- **Outcome and exit codes:** read from the audit log's `run ended` line when the audit file is on this
  machine, else from the session's execution event:
  `0` completed · `1` error · `2` refused (spec invalid, limits missing, audit unavailable) ·
  `3` time limit · `4` budget · `130` interrupted.
- Docs: `skill/kete.md`, the cli and unattended cards; `docs/` user docs for the job spec.

## Out of scope
- Cloud execution, the job API and the orchestrator (platform); a container image.
- Schedules, queues, retries; several jobs in parallel from one command.
- Pushing the branch or opening a PR (a job leaves the branch; pushing needs explicit policy).
- Organization policy from the platform narrowing the job policy (later; the spec carries it now).
- YAML job specs.

## Acceptance criteria
- [x] AC1: An invalid spec (missing budget or timeout, unknown field, bad allow rule, no prompt) exits
  `2` with a message naming the problem and starts nothing (cli Kete test).
- [x] AC2: A valid spec creates a worktree on a new branch and a root session carrying
  `kete.unattended` with the spec's policy (test against a real server).
- [x] AC3: The run completes → exit `0`, final text on stdout, summary with branch and audit path;
  `--json` prints the result object (test with a fake model/provider).
- [x] AC4: A denied action, a time limit and a budget stop map to the right outcome and exit code
  (tests).
- [x] AC5: The user's checkout is untouched: edits land only in the job's worktree (test).
- [x] AC6: In an unattended run, an edit to `.kete/` is denied even when an allow rule and the
  agent's rules would allow it; interactive sessions are unaffected (core Kete test).
- [x] AC7: cli and core typecheck; cli and core Kete tests; `bun run lint`; `upstream:check`;
  `verify --base main`; protocol and client regenerated if an endpoint changes.

## Risks and constraints
- **Contract:** the job spec v1 and the exit codes become contracts the cloud worker will use;
  additive changes only.
- **Remote servers:** with `--server <remote>`, the audit file isn't on this machine; the outcome falls
  back to the execution event and the summary names the server-side path.
- **Security:** the job's policy only narrows; the spec can't widen deny rules. `.kete/` edits are
  denied in unattended runs (user decision, 2026-09-28).
- **Upstream edits:** likely none (new Kete command, existing endpoints); `resolveSessionTarget` may
  need a metadata parameter — prefer a Kete-owned path.
