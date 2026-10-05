# Spec: Kete Code step for Harness CI/CD pipelines

- Task: `docs/tasks/2026-10-05-harness-step` · Size: large · Created: 2026-10-05
- Status: approved (user pre-approved all recommendations, 2026-10-04)

## Goal
A Harness pipeline can run Kete Code as a step — fix a failing build, review a change, write release
notes — either inside the pipeline's own container (local unattended run) or by starting a Kete
cloud job, with a budget, a time limit and a clear outcome.

## Scope (new `packages/kete-harness-plugin`; image `ghcr.io/kete-org/kete-harness-plugin`)
1. **Plugin image** (Harness CI "Plugin" step, Drone-compatible: settings arrive as `PLUGIN_*` env):
   small Debian-slim image with `git`, `ca-certificates` and the released `kete` (pinned by
   version + checksum), multi-arch, signed with cosign like the job image, built and pushed by the
   release workflow.
2. **Modes** (`PLUGIN_MODE`):
   - `run` (default): `kete job run` in the step's workspace (ADR 0008 unattended rules: required
     budget `PLUGIN_BUDGET` and time limit `PLUGIN_TIMEOUT`, fail closed on anything not allowed,
     audit log written to the workspace as an artifact). Model access: a Kete API key
     (`PLUGIN_KETE_API_KEY`, a Harness secret) through the gateway, or BYOK provider keys.
     Optional `PLUGIN_PUSH_BRANCH` (push the result to a new branch, never the target branch) and
     `PLUGIN_COMMENT` (write the summary to a file Harness can post).
   - `cloud`: start a Kete cloud job through the platform API (`POST /api/v1/jobs`) on a connected
     repository and wait for its outcome (poll with backoff, honour the time limit), printing the
     job URL and PR link. Requires cloud jobs to be enabled for the org (Phase 7).
   - Task text from `PLUGIN_TASK`, or a preset `PLUGIN_PRESET` (`fix-build` reads the previous
     step's log path `PLUGIN_LOG`, `review`, `release-notes`).
3. **Outputs:** exit code 0 success / 1 failure / 2 refused (policy, budget); Harness output
   variables via `$DRONE_OUTPUT`/`$HARNESS_OUTPUT` file (`KETE_OUTCOME`, `KETE_SUMMARY`,
   `KETE_BRANCH`, `KETE_JOB_URL`).
4. **Secrets:** keys only from env (Harness secrets), never echoed; the audit log is redacted by the
   existing redactor.
5. **Docs:** `docs/integrations/harness.md` (pipeline YAML examples for both modes, least-privilege
   keys), `packages/kete-harness-plugin/README.md`.
6. **CI:** build the image and run its tests on PRs (path-filtered); a fake platform for `cloud`
   mode; a fake model endpoint for `run` mode.

## Out of scope
- Harness triggers starting Kete jobs (platform task 7), Harness Code repos (task 8), a Harness
  marketplace listing.

## Acceptance criteria
- [ ] AC1: Settings parsing/validation (`PLUGIN_*`), with clear errors for missing budget/timeout/
  task and invalid modes (unit tests).
- [ ] AC2: `run` mode runs `kete job run` with the budget and limit, writes outputs and the audit
  artifact, and never pushes to the target branch (integration test with a fake model).
- [ ] AC3: `cloud` mode starts a job against a fake platform, waits, maps outcomes to exit codes and
  outputs, honours the limit (integration test).
- [ ] AC4: Image builds multi-arch in CI; release workflow pushes and signs it (dry run on PRs).
- [ ] AC5: Docs; lint, typecheck/tests, `upstream:check`.

## Risks
- `cloud` mode depends on cloud jobs, which haven't run in production yet (Phase 7 pilot pending).
- Pipelines often run as root in containers: `kete job run`'s unattended policy still applies; the
  plugin never disables permission checks.
