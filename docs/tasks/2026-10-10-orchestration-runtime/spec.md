# Spec: Orchestration runtime (O2, O6, O7)

- Task: `docs/tasks/2026-10-10-orchestration-runtime` · Size: large (shared contracts, security, several packages) · Created: 2026-10-10
- Status: built <!-- draft → agreed (medium) / approved (large) → built → closed -->
- Parent: the approved program spec `docs/tasks/2026-10-07-cross-runner-orchestration/spec.md` (rows O2,
  O6, O7; maintainer approval 2026-10-07), ADR 0012. Platform side already built: O1 contracts
  (kete-code-platform PR #79) and O3–O4 core (PR #80); their handoffs
  `docs/tasks/2026-10-09-orchestration-{contracts,core}/handoff.md` there list what kete-code must do.

## Goal
The kete-code (runtime) side of orchestrated jobs for the Kete cloud zone: the contract mirror, the
job entrypoint that can run a coordinator turn or a node's attempt, and the coordinator's
`orchestrate` tool, so that once the platform's push path (O5) lands an orchestration runs end to end.

## Scope
- **O2 — contract mirror** (modules `job-entrypoint`, `job-host`, `job-mode`): byte-for-byte copies of
  `orchestrations-v1.md`, `jobs-v1.md`, `job-host-v2.md` (and the re-copied `egress-config-v2.md`) in
  `docs/platform/`; the vectors (`docs/platform/test-vectors/orchestrations-v1/` read by Go and
  TypeScript tests; `jobs-v1/orchestration.json` and `job-host-v2/orchestration.json` in the Go
  testdata) with SHA256SUMS; Go: orchestrated claim types and checks (`checkOrchestratedClaim`), the
  strict plan-file reader (canonical integers, duplicate/case-variant names refused, lone
  surrogates), proposal and digests, worker prompt read, bundle rule, node commit message, branch
  names, `orchestration_titles`; job-host-v2 mirror types (features, cleanup, base_sha, publish
  kinds, `ref_mismatch`) without advertising anything; TypeScript: a zod mirror of
  `orchestrations.ts` (+ the jobs-v1 pieces it needs) and kete job spec v1's optional
  `orchestration`.
- **O6 — entrypoint**: announce `orchestration_v1`; the pinned base (fetch the exact commit when the
  base branch moved; a moved node base is refused); extra refs fetched as `refs/heads/<branch>` into
  `refs/kete/*` and checked at their pinned SHAs (`ref_mismatch`); refs/kete/* in the agent's copy; a
  worker's prompt from the plan file at the pinned plan commit, digest checked (`prompt_mismatch`
  etc.); plan-bundle mode for a coordinator; `.kete-orchestration` refused in every other bundle;
  `KETE_JOB_ID` for kete.
- **O7 — runtime**: the `orchestrate` tool (plan / status / finish), registered only in job mode for
  a coordinator turn; the coordinator routes with the job's own key; the plan file written only
  after a 200; local validation with the contract's own rules; titles and summaries boundary-gated;
  the plan file removed on a finish after a proposal; permission rules (no edits under
  `.kete-orchestration`; none at all after a plan); the coordinator's instructions and starting
  state in the system prompt; the shared Kahn helper (`KeteDag`) used by the `workflow` tool too.
- The Harness step refuses reserved branch suffixes locally (jobs-v1 narrowing, contracts handoff).
- Tests: Go and TS vectors, entrypoint unit tests with fakes, fake platform support (orchestrated
  claims, coordinator routes, the plan-bundle check) and integration scenarios with the real git.

## Out of scope
- The platform's push path (O5), portal/Slack/Harness orchestrate options (O8), staging (O9), the
  runner side (O10–O12). The kubevm entrypoint doesn't announce the feature.
- The job-image end-to-end scenario with the real `kete` (deferred: see handoff).

## Acceptance criteria
- [x] AC1: the copies are byte-identical to the platform's (SHA256SUMS; `*MatchPlatform` tests with the platform checkout).
- [x] AC2: every vector passes in Go and TypeScript (plan files, reads, dag, bundles, naming, messages, orchestrated claims and refusals, boundary titles, job-host-v2 cases).
- [x] AC3: the entrypoint runs coordinator and worker claims: pinned base, fetches, refusals, prompt, bundles (unit tests; integration with real git).
- [x] AC4: the `orchestrate` tool: registration only for coordinators in job mode, validation before any request, proposal digests identical to the platform's, file only after a 200, finish/abandon, boundary gating, permission rules.
- [x] AC5: no upstream file edited; checks green (typecheck, tests, Go vet/test, lint, upstream:check, verify).

## Risks and constraints
Shared contracts (copies only, never edited), security (pinned SHAs, prompt binding, plan-bundle
rule, edits denied after a plan, no prompt or note leaves the zone), fail closed everywhere (a job
without the feature path never sees any of it; a missing credential fails the tool).
