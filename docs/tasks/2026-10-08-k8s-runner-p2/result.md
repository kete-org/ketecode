# Result: Enterprise runtime P2 — kubevm job pods, entrypoint kubevm profile, outbox, egress v2

PR: kete-org/ketecode#23 (branch `feature/k8s-runner-p2`).

## What changed
- `packages/kete-egress` — `config.Load`/`ConfigV2.Runtime`; proxy: host:port entries
  (`hostname.AuthorityEntry`/`HostHeaderEntry`), v2 address rules (`addrAllowed`), CONNECT through
  the upstream proxy with credentials (`dialViaUpstream`; a 2xx answer's body is never read),
  `AddCABundle`/`ReadProxyAuth`, reason `upstream_proxy`; `netrules` v2 additions; tests.
- `packages/kete-job-entrypoint` — `hostprofile` (`KubeVM`, `SourceFile`, `KubeVMKernel`,
  `KubeTargets`, `sharedkernel_{release,testdriver}.go`); `bootenv` (`kubevm.go`: `Local`,
  `ParseKubeVMConfig`, `ReadConfigFile`); `entry` (`kubevm_linux.go`: `setup_kubevm`, dirs, egress
  v2, runtime deps; boundary retry with kube targets); `isolation` (reasons `kube_api`, `node`);
  `platform` (`ClaimRuntime`, `FinishOutbox`); `job` (`Runtime`: runtime claim, recorded base,
  bounded result, outbox, outbox finish); `outbox` (new); `gitops.Head`; `layout`; `phaselog`;
  fake platform (runtime mode, job-host forwarding, `-listen`, `-ca-dir`, `-linger`).
- `packages/kete-job-host` — config (`kubevm.go`: `repository_sources`, `job_pod`, internal ranges;
  `proxy_auth_file`); kube client (PVCs, pod logs, RuntimeClasses, node addresses); driver
  (`kubevm.go`; outbox PVC + `CollectOutboxes`; `Logs`; `pendingFailure`, `notScheduled`;
  `driver.FailedError`; `Spec.Repository`); agent (FailedError → v2 failed reasons); runner
  (kubevm wiring, RuntimeClass guard, `kete-test` refusal, Sigstore verifier + cache, proxy
  credentials); `kubetest` (pod logs, RuntimeClasses, addresses); fake admin `claim_token`, phase lines.
- `packages/kete-runner-chart` — values/schema, ConfigMap, RBAC, admission (own-outbox volume rule,
  outbox claims policy on CREATE), Deployment, README; `ci/kind.yaml` (two nodes), `ci/e2e-fixtures.yaml`,
  `ci/lint-values.yaml` (kubevm), `ci/e2e-kubevm.sh` (new).
- `packages/kete-job-image/scripts/build.sh` — `--go-tags`.
- `.github/workflows/kete-runner.yml`, `kete-job-entrypoint.yml`.
- Docs: entrypoint README "kubevm", egress README "Configuration v2", chart README, cards
  `kubernetes-runner`, `job-entrypoint`, `egress`, INDEX, this folder.

## Checks
| Check | Result |
|---|---|
| gofmt; `go vet` (darwin, linux; entrypoint also integration/e2e/kete_testdriver; job-host also kete_testdriver) | pass (local) |
| kete-egress `go test ./internal/...` (incl. v2 proxy, chunked CONNECT 200 regression, netrules v2, Load) | pass (local, CI) |
| entrypoint `go test ./...` and `-tags kete_testdriver ./internal/hostprofile/... ./internal/bootenv/...` | pass (local, CI) |
| job-host `-race -tags kete_testdriver` kube, runner, kubernetes driver; release runner; config | pass (local, CI); root-only suites pass in CI only |
| helm lint, kubeconform 1.30/1.32, refusals, rendered config parsed by `config.Parse` | pass (local, CI `chart`) |
| kind e2e P1 (`ci/e2e.sh`) on the two-node cluster | pass (CI) |
| kind e2e P2 (`ci/e2e-kubevm.sh`) | pass (CI, 157 s): real job claim → clone → `kete job run` with the scripted model → bounded result → outbox (manifest with result, audit, proxy log, bundle) → finish `{"outbox":true}`, no uploads; image_pull_failed; repository mismatch refused with only the claim sent; shared_kernel (wrong node boot ID; release rule on a shared kernel) as the first failed step; non-allowlisted RuntimeClass denied; runtime_class_missing blocks and unblocks |
| kete-job-image e2e (dedicated profile, unchanged behaviour), kete-job-host (root suite, kernel configs), kete-egress (incl. privileged integration), kete-build | pass (CI); kete-job-host `TestOneAtATimeStopAndCrash` (dedicated driver, untouched) failed once and passed on rerun — the flake P1 recorded |

Bugs found by CI and fixed on the branch: the outbox claim policy refused the scheduler's
annotation (now CREATE only); `kube_api`/`node` weren't known isolation reasons (every probe round
answered `probe`); kete-egress read the body of a CONNECT 200 framed with `Transfer-Encoding`
(Go's server does that), hanging until the header deadline; the e2e expected to see a job running
that finished within one poll.

## Acceptance criteria
- [x] AC1 — hostprofile/bootenv tests (both builds); e2e refusal pods (first lines `setup_host
  start`, `setup_host failed shared_kernel`, then `job exit`).
- [x] AC2 — e2e phase lines `setup_kubevm ok`, `host_boundary` note then ok (a NetworkPolicy
  enforced ~2 s late, absorbed by the retry); `TestRuntimeClaimRefusedStopsLikeA404`; e2e M2.
- [x] AC3 — `TestRuntimeLifecycle`, outbox tests; e2e M1 calls and outbox manifest.
- [x] AC4 — egress unit tests, nft syntax check (integration), e2e traffic through the upstream proxy
  with the custom CA and internal ranges.
- [x] AC5 — driver/runner tests; e2e pod spec, Secret gone, phase lines, image_pull_failed,
  runtime_class_missing; `TestReleaseBuildRefusesSharedKernelTestClass`. `pod_unschedulable` and
  `repository_unavailable` are unit-tested only.
- [x] AC6 — CI `chart`; e2e (the kubevm pod and its outbox admitted; P1 denials still pass).
- [x] AC7 — CI `e2e`. **Under runc with test-only builds; not Kata** (handoff).

## Cards updated
- `kubernetes-runner`, `job-entrypoint`, `egress`, INDEX.

## Metrics
- Agents used: implementer (this session), one read-only security reviewer (no blocker/major;
  minor fixes applied: outbox group check, proxy credentials/DNS notes in the chart README).
- Time: one long session, interrupted twice by usage limits; 6 CI iterations of the kind e2e.
