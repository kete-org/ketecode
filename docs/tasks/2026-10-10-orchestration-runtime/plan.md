# Plan: Orchestration runtime (O2, O6, O7)

Built in one session from the program spec and the platform handoffs (no separate planner pass; the
steps below are what was done, in order, with the command that verifies each).

1. **Copies** — `docs/platform/{orchestrations-v1,jobs-v1,job-host-v2,egress-config-v2}.md` (header +
   the platform file at 214e543); vectors into `docs/platform/test-vectors/orchestrations-v1/` and the
   Go testdata, SHA256SUMS regenerated. Verify: `go test ./internal/orchestration/ ./internal/fakeplatform/`
   (entrypoint), `go test ./internal/vectors/` (job host); with `KETE_PLATFORM_*_VECTORS` set, the
   byte comparisons.
2. **Go contract (entrypoint)** — `internal/orchestration/{planjson,planfile,orchestration}.go`,
   `internal/platform/orchestrated.go` (+ `ClaimResponse.Fetch`, `Claim.Orchestrated`,
   `DataBoundary.OrchestrationTitles`). Verify: `go test ./internal/orchestration/ ./internal/platform/`.
3. **Go contract (job host)** — `internal/contract/v2_orchestration.go` + fields in `v2.go`. Verify:
   `go test ./internal/contract/ ./internal/vectors/`.
4. **O6 flow** — `internal/job/orchestration.go` (pinBase, fetchRefs, workerPrompt, copyKeteRefs),
   wiring in `job.go`, `deps.go` (Git methods, `KeteEnv.JobID`, `BuildBundle` kind),
   `internal/gitops/ops.go` (ResolveCommit, PinBase, FetchRefs, CopyKeteRefs), `internal/bundle`
   (`Kind`, `applyOrchestration`), `entry_linux.go` (`KETE_JOB_ID`), phaselog steps `fetch`,
   `plan_prompt` and code `ref_mismatch`, claim features. Verify: `go test ./internal/job/
   ./internal/bundle/ ./internal/gitops/`.
5. **Fake platform + integration** — `internal/fakeplatform/orchestration.go` (branches, claims, coordinator
   routes, plan-bundle check), `fakekete` scenarios, `itest` scenarios. Verify: `go test
   ./internal/fakeplatform/`; `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src"
   -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh`.
6. **TS spec and channel** — `util/src/kete/orchestration-spec.ts`, `job-secrets.ts` overlay,
   `cli/src/kete/{job-spec,job-orchestration,job,job-standalone,job-serve}.ts`. Verify: `bun test` of
   the touched util/cli tests; `bun run typecheck` in util and cli.
7. **TS contract and tool** — `core/src/kete/orchestration/{contract,client,plan,prompt}.ts`,
   `core/src/kete/{orchestrate,dag}.ts`, `job-plugin.ts` (install), `workflows.ts` (KeteDag). Verify:
   `bun run test ./test/kete/orchestration-contract.test.ts ./test/kete/orchestrate.test.ts
   ./test/kete/workflows.test.ts ./test/kete/job-plugin.test.ts` in core; `bun run typecheck`.
8. **Harness step** — reserved suffixes in `settings.ts`. Verify: `bun test test/settings.test.ts`.
9. **Docs** — ADR 0012 notes, cards, this folder; CI path filters for the vectors and the new runtime
   files. Verify: `node scripts/agent/card-check.mjs`, root `bun run lint`, `upstream:check`, `verify --base main`.
