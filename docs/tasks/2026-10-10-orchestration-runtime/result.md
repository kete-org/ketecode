# Result: Orchestration runtime (O2, O6, O7)

## What changed
- `docs/platform/{orchestrations-v1,jobs-v1,job-host-v2,egress-config-v2}.md` — copies of the platform files at 214e543 (header + byte-identical body).
- `docs/platform/test-vectors/orchestrations-v1/` (+ SHA256SUMS), `kete-job-entrypoint/.../testdata/jobs-v1/orchestration.json`, `kete-job-host/testdata/job-host-v2/orchestration.json` — vectors, byte-identical.
- `kete-job-entrypoint/internal/orchestration/` — strict plan-file reader, proposal, prompt read, bundle rule, node commit message, names.
- `kete-job-entrypoint/internal/platform/orchestrated.go` (+ claim.go, runtime.go, platform.go) — orchestrated claim types and checks, `orchestration_v1` announced, `orchestration_titles`.
- `kete-job-entrypoint/internal/job/orchestration.go` (+ job.go, deps.go), `gitops/ops.go`, `bundle/`, `entry/entry_linux.go`, `phaselog` — O6 flow, `KETE_JOB_ID`, `KETE_JOB_ZONE`.
- `kete-job-entrypoint/internal/fakeplatform/orchestration.go`, `itest/` — fake orchestrated claims, coordinator routes, plan-bundle check; six integration scenarios.
- `kete-job-host/internal/contract/v2_orchestration.go` (+ v2.go) — job-host-v2 mirror types (nothing reported).
- `util/src/kete/orchestration-spec.ts`, `job-secrets.ts`; `cli/src/kete/{job-orchestration,job-spec,job,job-standalone,job-serve}.ts` — spec section and its channel to `kete serve`.
- `core/src/kete/orchestration/{contract,client,plan,prompt}.ts`, `orchestrate.ts`, `dag.ts`, `job-plugin.ts`, `workflows.ts` — the tool, the zod mirror, the shared Kahn helper.
- `kete-harness-plugin/src/settings.ts` — reserved branch suffixes refused locally.
- ADR 0012 (contract notes O1, runtime notes), cards, `.github/workflows/kete-job-{entrypoint,image}.yml` path filters.

## Checks
| Check | Result |
|---|---|
| Go entrypoint: gofmt, vet (plain, integration, e2e, kete_testdriver tags), `go test ./...` | pass |
| Go entrypoint integration suite (privileged Docker, real git/helper/proxy) | 34/34 top-level tests pass, incl. 6 new orchestration scenarios |
| Go job host: gofmt, vet (plain, kvm, kete_testdriver, darwin), `go test ./...` as root in Docker | pass |
| Cross-repo byte checks (`KETE_PLATFORM_ORCHESTRATION_VECTORS`, `KETE_PLATFORM_JOBS_VECTORS`) | pass |
| core/util/cli/harness-plugin typecheck; targeted tests | pass |
| root `bun run lint` | 0 warnings, 0 errors |
| `upstream:check` | passed (no upstream file edited) |
| `verify --base main` (final commit) | 0 new failures (core 6810 pass / 30 fail vs main 6651 / 30; util, server, tui, cli all clean) |

## Acceptance criteria
- [x] AC1 — SHA256SUMS tests; platform byte comparison tests pass.
- [x] AC2 — Go: plan-files (38 + 5 reads), bundles 19, naming, jobs-v1 orchestration (4 accepted + runtime, 22 refused, boundaries), job-host-v2 orchestration 37; TS: plan-files, dag 32, messages 43, bundles, naming (141 tests).
- [x] AC3 — `internal/job/orchestration_test.go`, `internal/gitops` (argv + real git), integration `TestOrchestration*`.
- [x] AC4 — `core/test/kete/orchestrate.test.ts` (18 tests), cli/util tests.
- [x] AC5 — upstream:check; checks above.

## Cards updated
job-entrypoint, job-mode, workflows, job-host, harness-plugin, contracts.md (§6h).

## Metrics
- Agents used: librarian (cards), reviewer (diff review; findings fixed or recorded in handoff).
