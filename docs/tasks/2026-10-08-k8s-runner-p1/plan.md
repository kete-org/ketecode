# Plan: Enterprise runtime P1 — Helm chart + Kubernetes controller with a fake driver

## Cards read
- docs/context/modules/job-host.md (verified-at c377dd3136)

## Files
| File | Read / change | Why |
|---|---|---|
| packages/kete-job-host/internal/agent/agent.go | change | Store, V2 wire, checkV2, contract_mismatch |
| packages/kete-job-host/internal/state/state.go | change | Store/FileStore, Encode/Decode, v2 reasons, halt |
| packages/kete-job-host/internal/client/client.go | change | v2 profile/limits, explicit proxy |
| packages/kete-job-host/internal/config/config.go | change | kubernetes driver + section |
| packages/kete-job-host/internal/kube/* | new | REST client, Lease, Secret stores, kubetest |
| packages/kete-job-host/internal/driver/kubernetes/* | new | pod driver, placeholder (tag) |
| packages/kete-job-host/internal/runner/* | new | controller orchestration |
| packages/kete-job-host/cmd/kete-job-host/main.go | change | `kubernetes` subcommand |
| packages/kete-job-host/internal/fakeplatform/* | change/new | v2 mode, e2e server |
| packages/kete-runner-chart/** | new | chart, CI fixtures, e2e |
| .github/workflows/kete-runner.yml, kete-job-host.yml | new/change | CI |

## Steps
1. State store seam, client v2/proxy, agent v2 (v1 bytes unchanged).
2. Config section; kube client, Lease, Secret stores with kubetest tests.
3. Pod driver + placeholder; runner + subcommand; fake platform v2; runner tests.
4. Chart, values schema, lint values; e2e script and workflow.
5. Docs and cards.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1–AC4, AC7 | `go test -race -tags kete_testdriver ./internal/kube/... ./internal/runner/... ./internal/driver/kubernetes/...`; `go test ./internal/runner/...` |
| AC5 | `helm lint . --strict -f ci/lint-values.yaml`; `helm template … \| kubeconform -strict`; refusal loop in kete-runner.yml |
| AC6 | kete-runner.yml job `e2e` (`ci/e2e.sh`) |
| AC8 | kete-job-host.yml (`sudo go test -race ./...`) |

## Cards to update after the build
- kubernetes-runner (new), job-host (pointer), INDEX
