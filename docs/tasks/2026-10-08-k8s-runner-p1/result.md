# Result: Enterprise runtime P1 — Helm chart + Kubernetes controller with a fake driver

PR: kete-org/ketecode#21 (branch `feature/k8s-runner-p1`).

## What changed
- `packages/kete-job-host/internal/state/state.go` — `Store`/`FileStore`, `Encode`/`Decode`, v2 failed reasons, `HaltContractMismatch`.
- `packages/kete-job-host/internal/agent/agent.go` — `Options.Store`, `Options.V2` (`V2` type), v2 wire (`encodeReport`, `decodeResponse`), `checkV2`, `contract_mismatch` halt.
- `packages/kete-job-host/internal/client/client.go` — `Options.V2` (profile, limits, reasons), `Options.Proxy`.
- `packages/kete-job-host/internal/config/config.go` (+ `kubernetes_test.go`) — `driver: kubernetes`, `kubernetes` section.
- `packages/kete-job-host/internal/kube/` — REST client, Lease elector, `SecretStore`, `KeySecret`, `kubetest/`, tests.
- `packages/kete-job-host/internal/driver/kubernetes/` — pod driver, placeholder (`kete_testdriver`), release stub, tests.
- `packages/kete-job-host/internal/runner/` — controller orchestration, test-tag verifier, tests (lifecycle, token, proxy, release refusal).
- `packages/kete-job-host/cmd/kete-job-host/main.go` — `kubernetes` subcommand.
- `packages/kete-job-host/internal/fakeplatform/` — v2 mode, `AssignV2`, `NewCert`, `cmd/kete-fake-platform`.
- `packages/kete-runner-chart/` — the chart, values schema, README, `ci/` (e2e, fixtures, kind config, Dockerfile, lint values).
- `.github/workflows/kete-runner.yml` (new), `.github/workflows/kete-job-host.yml` (vet the test tag).
- Docs: card `kubernetes-runner`, INDEX, job-host card pointer, `packages/kete-job-host/README.md` section.

## Checks
| Check | Result |
|---|---|
| `go vet` darwin, linux, linux+`kete_testdriver`, linux+`kvm`; `gofmt` | pass (local) |
| `go test -race -tags kete_testdriver` kube, runner, kubernetes driver | pass (local, 3× for runner) |
| `go test -race` runner (release build), client, contract, sig, seal; config `-run Kubernetes` | pass (local) |
| Root-only tests (agent v1 suite, state, keys, config files) | not runnable locally (macOS, no root/Docker); pass in CI `kete-job-host.yml` |
| `helm lint --strict`, `helm template \| kubeconform -strict` (1.30, 1.32), values refusals | pass (local and CI `chart`) |
| kind e2e (`ci/e2e.sh`) | pass in CI (373 s script, job 7m50s) after one fix (the e2e's `can-i pods/exec` syntax) |
| `kete-job-host.yml` `test` | pass; one run failed in `internal/driver/dedicated` `TestStartFailureCleansUp` (`Cannot find device "kjh0"`, code not touched by this PR), passed on rerun — flaky |

## Acceptance criteria
- [x] AC1 — runner_test `TestRunnerLifecycle`; e2e "host enrolled", "spent token Secret deleted", "v2 reports".
- [x] AC2 — kube_test lease tests; e2e restart: orphan killed, M3 re-adopted.
- [x] AC3 — runner_test; e2e M1 start/stop, M2 exit, M3 deadline kill, M4 repository_unknown, orphan.
- [x] AC4 — `TestRunnerProxyCarriesPlatformTraffic`; e2e proxy CONNECT count > 0 with the fake platform's CA as the chart's CA bundle.
- [x] AC5 — CI `chart`.
- [x] AC6 — CI `e2e` (admission refused runc by SA and admin, foreign creator, privileged, non-allowlisted image; RBAC can-i checks).
- [x] AC7 — `TestReleaseBuildRefusesPlaceholder`; `cmdKubernetes` doesn't call `newDriver`/`driverChecks`.
- [x] AC8 — CI `kete-job-host.yml` `test` (v1 agent suite as root).

## Cards updated
- `kubernetes-runner` (new), `job-host` (pointer), `INDEX.md`.

## Metrics
- Agents used: one implementer (this session); no scout/reviewer sub-agents.
- Time: one session (interrupted once by an API rate limit).

## Security review round (2026-10-08)
Fixes on the same branch (see handoff.md for the list). Checks:

| Check | Result |
|---|---|
| `go vet` darwin, linux, linux+`kete_testdriver`; `gofmt` | pass (local) |
| `go test -race -tags kete_testdriver` kube, runner, kubernetes driver (new: bounded Hold, fatal conflict, staged-key reuse, policy guard blocks/unblocks, Secret squat, lease released last, other instance's pods untouched, list paging) | pass (local) |
| `go test -race` runner (release), client; config `-run Kubernetes` | pass (local) |
| helm lint, kubeconform 1.30/1.32, refusals (incl. new: policy switch, broad egress, unsafe names) | pass (local and CI `chart`) |
| kind e2e | pass in CI (383 s script) after two e2e-only fixes: feature gates ProcMountType/UserNamespacesSupport so the API server keeps `procMount`, and a custom Secret type for the non-Opaque case. Every new denial passes, as do the guard (binding deleted → `cluster_unhealthy`, M5 refused, `helm upgrade` restores) and the earlier scenarios |
| kete-job-host.yml `test` (root suite) | pass |

Not exercised in e2e: `pods/resize` (no such subresource on the kind 1.32 node). The host-process
case also sets `hostNetwork` and the volume-device case also needs a PVC volume (API validation
requires both), so those two denials may come from the neighbouring rule.
