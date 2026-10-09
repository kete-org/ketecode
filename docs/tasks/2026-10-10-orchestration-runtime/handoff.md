# Handoff: Orchestration runtime (O2, O6, O7)

## 2026-10-10 builder (single session)

Done: spec.md scope; checks in result.md. Not merged.

### For the platform (kete-code-platform)
- **O5 can rely on**: a coordinator turn that proposed a plan uploads a bundle that is exactly
  `.kete-orchestration/plan.json` (mode 100644, the bytes whose SHA-256 is the proposal's
  `plan_digest`, `prompt_digest`s computed by the same reader); any other change of that turn is
  left out and said on the job (`events` note "plan turn: only the plan file is published; N other
  change(s) left out"). Every other bundle (workers, integrations, plain jobs) never contains a
  `.kete-orchestration` path: the entrypoint refuses it with `push_error: unreadable` and a note
  "bundle refused: a change touches .kete-orchestration (orchestration_path)".
- **Coordinator routes as called**: `GET/PUT/POST /api/v1/jobs/{id}/orchestration[/plan|/decision]`
  with `Authorization: Bearer <job key>`, 30-second timeout, no retry; the tool reads
  `OrchestrationCoordinatorResponse` and `OrchestrationErrorResponse` (reason, issues). The tool
  sends `summary` only from Kete cloud and titles only when `spec.orchestration.titles` and the
  view's `titles` are `send`.
- **Pinned base**: when the base branch moved, the entrypoint fetches `base_sha` by id
  (`git fetch --depth=1 <url> +<sha>:refs/heads/<ref>`). GitHub serves reachable commits by id;
  **Harness Code is unverified** — if it refuses, such a job ends `refused` (`ref_mismatch`).
- **Agent configuration**: `orchestrate` is hidden from an agent whose permission rules wholly deny
  it (a catch-all `* deny`); a coordinator agent must not deny it, or every turn ends
  `coordinator_no_decision`.

### Deferred
- **Job-image end-to-end scenario with the real `kete`** (scripted model calling `orchestrate`
  against the fake platform's coordinator routes, checking the plan bundle): not built. The fake
  platform already serves orchestrated claims, the coordinator routes and the plan-bundle check
  (`internal/fakeplatform/orchestration.go`), so the scenario needs a gateway script, a knob and
  asserter checks. Not done for disk space on the build machine (the image build needs several GB);
  the real-git paths are covered by the integration suite instead.
- A pin or fetch failure on a GitHub job ends without revoking the clone token (as a verify failure
  always has); the token expires with the job. Consider a best-effort revoke in `failClone`.
- The runtime's audit log doesn't yet record the orchestration ids in its session start line (spec
  §10 audit row).
- Runner side (O10): `orchestration_v1` in reports, publish kinds, cleanup, the runner's
  `orchestration_titles`/`summary` boundary into `KETE_JOB_ZONE`'s place; the kubevm entrypoint's
  orchestrated claim (types exist: `ParseRuntimeOrchestratedClaimResponse`).

### Open questions
None blocking.
