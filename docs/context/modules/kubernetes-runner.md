---
module: kubernetes-runner
paths: [packages/kete-runner-chart/**, packages/kete-job-host/internal/runner/**, packages/kete-job-host/internal/kube/**, packages/kete-job-host/internal/driver/kubernetes/**, .github/workflows/kete-runner.yml]
verified-at: 99f9825fb1
---

## Quick answers
- What is this module? The enterprise runner for Kubernetes (ADR 0011, Phase 8): `kete-job-host
  kubernetes`, the job host agent speaking **job-host-v2** as a non-root controller pod, plus the
  Helm chart `packages/kete-runner-chart`. Built in piece **P1** (task
  `docs/tasks/2026-10-08-k8s-runner-p1`): controller, Lease, state and keys in Secrets, proxy/CA,
  the generic pod driver with the boot-ID Secret handoff, a **test-only placeholder** pod driver,
  RBAC, admission policy, NetworkPolicies, kind e2e. Piece **P2** (task
  `docs/tasks/2026-10-08-k8s-runner-p2`) added the **kubevm pod driver** (real job pods), the
  outbox, pods/log phase lines, pod failure reasons, the RuntimeClass guard, proxy credentials and
  repository sources. The GitLab publisher is P3; the platform serves v2 from P4.
- What does the kubevm pod driver do? `KubeVMPod`/`KubeVMSecret` (`internal/driver/kubernetes/kubevm.go`):
  the job image's entrypoint with `--config-file /run/kete-config/config.json`, profile `kubevm`,
  the first RuntimeClass, requests = limits = `job_pod`, drop ALL + `JobCapabilities` (11, S0),
  outbox PVC `kete-outbox-<id>` at `/var/lib/kete-outbox`. The Secret (`SecretFunc`, written after
  scheduling) holds `config.json`: the sealed machine config + `node_boot_id` + the local section
  (repository source URL, ref = run machine `base_ref`, the clone Secret's `username`/`token`,
  boundary, proxy + `proxy_auth` + CA bundle, `job_pod.internal`, the node's addresses,
  `shared_kernel_test` only for `kete-test` in a test build). Must match the entrypoint's
  `bootenv.Config`/`Local` (no shared Go code: separate modules).
- Failure reasons? `driver.FailedError` (`internal/driver/driver.go`): `Status` returns it for a
  Pending pod (`pendingFailure`: image pull errors past `ImagePullGrace` 60 s or an invalid name →
  `image_pull_failed`; unschedulable past the start timeout → `pod_unschedulable`), `Start` for a
  missing source/credential (`repository_unknown`/`repository_unavailable`); the agent turns it into
  `failed`/<reason> on v2 hosts and cleans up (`agent.go` actObserve/actStart).
- Phase lines? `Driver.Logs` reads `pods/<name>/log` (≤ 256 KiB) and returns the lines not seen
  before (a partial last line waits); the agent's phase filter keeps only phase lines.
- Outbox lifetime? Created before the pod, kept after `Stop`; `CollectOutboxes` (runner goroutine,
  every 10 min) deletes it once deadline + grace + 1 min + `outbox_hold_hours` passed and no pod
  exists. P3's publisher will read and delete it earlier.
- RuntimeClass guard? `policyGuard.check` also gets every configured RuntimeClass
  (`kube.RuntimeClassExists`): missing → `runtime_class_missing`, error → `cluster_unhealthy`.
- Test-only RuntimeClass? `kete-test` (kind: runc). `runner.Run` refuses it unless
  `kdriver.TestBuild` (`-tags kete_testdriver`); only then does the Secret ask for the entrypoint's
  test-only shared-kernel mode. Test builds also verify images with accept-all
  (`verify_testdriver.go`); release builds use `image.Sigstore` with the TUF cache in
  `runner.CacheDir` (`/var/cache/kete-runner`, an emptyDir).
- Where does it start? `cmdKubernetes` (`packages/kete-job-host/cmd/kete-job-host/main.go:175`):
  refuses root and non-kubernetes configs, builds `kube.InCluster()`, calls `runner.Run`
  (`internal/runner/runner.go:73`). Exit 3 = agent halted, 1 = error/lease lost (Kubernetes restarts).
- Is it a second agent? No. `runner.Run` builds the same `internal/agent` with `Options.Store`
  (`kube.SecretStore`) and `Options.V2` (`agent.V2`: kubernetes version, RuntimeClasses,
  repositories, advertise, boundary). The agent builds every report in v2's shape and writes v1's
  for v1 hosts (`encodeReport`, `internal/agent/agent.go:1263`; `decodeResponse` `:1290`); v2
  assignment rules in `checkV2` (`:578`): `ValidateKubernetes` (repository required) →
  `config_invalid`, unknown repository → `repository_unknown`, `publish` → `config_invalid` (no
  publisher until P3). `contract_mismatch` halts durably (`state.HaltContractMismatch`).
- How is state kept? `kube.SecretStore` (`internal/kube/store.go:99` Save, `:117` Run): the
  state.json document in Secret `kete-runner-state`, written behind the agent's lock by a
  goroutine, conditional on resourceVersion; Save returns the last write error (→ the agent's
  `saveFailed` → starts blocked). Keys: `kube.KeySecret` (`:221`), annotation `kete.dev/keys:
  staged|enrolled` + fingerprint; staged keys are never used.
- How does enrollment work? `ensureEnrolled`/`enrollOnce` (`runner.go:217`, `:251`): reads the token
  Secret (`enrollment_secret`, key `token`), stages keys, `EnrollRequestV2` with kubernetes facts
  (`generation` `k8s-<date>-<hex>`), deletes the token Secret on a definitive answer, commits keys,
  saves and flushes the state. Missing token Secret → waits (logs `enroll_waiting`).
- Leader election? `kube.Elector` (`internal/kube/lease.go`, Acquire/Hold/Release): client-go's
  algorithm (expiry judged on the local clock from the last observed resourceVersion), 15 s lease,
  2 s retry; every renewal is bounded by last-success + 10 s and Hold returns `ErrLost` the moment
  that passes → the runner stops and exits. Hold never releases; `runner.Run`'s `finish` releases
  only after the agent returned and the final state flush (never after `ErrLost`).
- State conflict? A 409 on the state Secret is fatal (`SecretStore.OnFatal`): the runner stops and
  Kubernetes restarts it to reload; it never retries a stale write forever.
- Admission policy guard? `policyGuard` (`internal/runner/runner.go`): at start and every
  `PolicyEvery` (30 s) it gets each `admission_policies` policy (failurePolicy Fail) and its
  same-named binding (names it, Deny); otherwise the driver's `StartsBlocked` is `cluster_unhealthy`
  and `Start` refuses. The chart has no switch to drop the policies.
- What is a machine? A pod `kete-job-<machine-id>` in the jobs namespace (`internal/driver/kubernetes`):
  `Start` (`kubernetes.go:100`) creates it with labels (`kete.dev/machine-id`, `job-id`, `deadline`,
  `role=job`, managed-by), no SA token, no service links, `activeDeadlineSeconds` = deadline + 6 min,
  waits for `spec.nodeName`, reads `Node.status.nodeInfo.bootID`, creates the owner-referenced
  Secret `kete-job-<id>` with `node_boot_id` (a 409 there — a squatted name — deletes the pod at
  once); pods and List carry/select `app.kubernetes.io/instance`; `Status` (`:205`) maps phases (Running deletes the
  Secret); `List` (`:261`) is the reconcile source (malformed labelled pods deleted).
- Why doesn't it run the host guard? `internal/hostguard` refuses containers because the
  firecracker/dedicated drivers isolate with the host kernel; the controller is a pod by design and
  isolation is per job pod (RuntimeClass + admission policy + the entrypoint's boot-ID check). See
  the `internal/runner` package comment; `cmdKubernetes` never calls `newDriver`/`driverChecks`.
- Proxy and CA? `kubernetes.proxy` (http(s)://host:port, no credentials) → `client.Options.Proxy`
  (CONNECT; TLS verified end to end) with `proxy_auth_file` (`username:password`, read at start)
  as the URL's userinfo (Go sends it as `Proxy-Authorization` on CONNECT); `kubernetes.ca_bundle` →
  system roots + bundle. Jobs get the proxy, credentials (re-read per job) and, with a proxy, the CA
  bundle (≤ 32 KiB) in their local section. The kube client never uses a proxy.

## Purpose
Run Kete Code's unattended jobs inside an enterprise's own Kubernetes cluster, outbound-only, with
each job in a VM-isolated pod, reusing the job host agent instead of a second job system.

## Entry points
- `kete-job-host kubernetes --config /etc/kete-runner/config.json` (chart Deployment).
- Config section `kubernetes` (`parseKubernetes`, `packages/kete-job-host/internal/config/config.go:539`).
- Chart values `packages/kete-runner-chart/values.yaml` (schema `values.schema.json`).

## Key files
- `packages/kete-job-host/internal/runner/runner.go` — Lease, enrollment, agent wiring; `verify_*.go`
  the placeholder build's accept-all image verifier (test tag only).
- `packages/kete-job-host/internal/kube/{kube,lease,store}.go` — REST client (no client-go), Lease
  elector, state/keys Secrets; `kubetest/` in-memory API server for tests.
- `packages/kete-job-host/internal/driver/kubernetes/{kubernetes,kubevm,placeholder,placeholder_release}.go`.
- `packages/kete-job-host/internal/config/kubevm.go` — `repository_sources`, `job_pod`, internal
  ranges (egress v2 rules duplicated: canonical, ≥ /8, no forbidden range).
- `packages/kete-job-host/internal/fakeplatform/` — `V2` mode, `AssignV2`; `cmd/kete-fake-platform`
  (TLS + admin API + CONNECT proxy) for the kind e2e.
- `packages/kete-runner-chart/templates/` — `rbac.yaml`, `admission-policy.yaml`,
  `networkpolicy.yaml`, `deployment.yaml`, `configmap.yaml`, `namespace-jobs.yaml`.
- `packages/kete-runner-chart/ci/` — `e2e.sh` (P1), `e2e-kubevm.sh` (P2: real job pods against the
  entrypoint's fake + the job-host fake outside the cluster), `e2e-fixtures.yaml`, `kind.yaml` (two
  nodes), `Dockerfile`, `lint-values.yaml` (kubevm).

## Data flow
Helm values → ConfigMap `config.json` (subPath mount: a regular root-owned file, as `config.Load`
requires) → `runner.Run` → Lease → state/keys Secrets (enroll if needed) → agent poll loop over
the platform client (v2 signatures, proxy, CA) → desired state → `kubernetes` driver → pods +
boot-ID Secrets in the jobs namespace → status → reports.

## Data and APIs used
- job-host-v2 (`docs/platform/job-host-v2.md`), types in `internal/contract/v2.go`.
- Kubernetes API: pods, pods/log, secrets, PVCs, events in the jobs namespace; secrets/leases in
  the release namespace (by name; the clone Secrets get by name); `get nodes`; `get` RuntimeClasses
  by name; `/version`.
- The entrypoint's kubevm configuration (`packages/kete-job-entrypoint` README "kubevm") and outbox
  format (`manifest.json` v1).

## Rules that must not break
- Never two pollers on one key: the agent runs only while the Lease is held; losing it stops the process.
- No secret in values, ConfigMap or logs; the token Secret is deleted once spent.
- The admission policies are the jobs namespace's only guard (PSA `privileged` there) and always
  installed: only the controller SA creates or changes job pods; Pod Security baseline and more
  (volume allowlist, seccomp/AppArmor/SELinux/procMount/sysctls/hostProcess, no resource claims or
  volume devices, allowlisted digests, drop ALL + allowed caps); only the controller writes Opaque
  `kete-job-*` Secrets and `kete-outbox-<id>` claims (RWO, no data source) in the jobs namespace and
  its own two Secrets at home; a pod may mount only its own outbox claim. The controller blocks
  starts while any policy or binding is missing.
- RBAC stays least privilege: no `pods/exec`, no cluster-wide Secrets, cluster scope = `get nodes`
  and `get` on the configured RuntimeClasses and the release's policies by name.
- The per-job Secret's local section never comes from the platform; nothing in it is logged.
- The placeholder driver, the accept-all verifier and the `kete-test` RuntimeClass exist only under
  `-tags kete_testdriver`; a release build refuses them before touching the cluster.
- Kubernetes run machines without `repository`, or with `publish` (until P3), never start.

## Testing
- `go test -race -tags kete_testdriver ./internal/kube/... ./internal/runner/... ./internal/driver/kubernetes/...`
  (no root needed; `kubetest` + fake platform v2 over TLS: lifecycle, refusals, deadline kill, orphan,
  restart, proxy, token handling). `go test ./internal/runner/...` without the tag: release refusal.
- Chart: `helm lint . --strict -f ci/lint-values.yaml`; `helm template … | kubeconform -strict`.
- kind e2e: `.github/workflows/kete-runner.yml` job `e2e` → `ci/e2e.sh` then `ci/e2e-kubevm.sh`
  (builds `kete`, the job image with `--go-tags kete_testdriver` and a fake image first).
- The chart's rendered `config.json` is parsed by `config.Parse` in CI
  (`TestChartRenderedConfig`, `KETE_RUNNER_RENDERED_CONFIG`).

## Changes
- Adding a pod driver: a `PodFunc` (+ `SecretFunc`, outbox) + a `pod_driver` value in
  `parseKubernetes` + `podDriver` in the runner; RBAC additions go in `templates/rbac.yaml`.
- Changing the job's configuration: `kubevm.go` (`jobConfig`) **and** the entrypoint's
  `internal/bootenv/kubevm.go` together.
- A new admission rule: `templates/admission-policy.yaml` and an e2e `denied` case.

## Gotchas
- The deadline kill fires at deadline + 5 min (`contract.DeadlineGrace`); the e2e waits for it.
- NetworkPolicy `apiServer.cidrs` must be the endpoint IPs (post-DNAT), port usually 6443 on kind.
- `SecretStore.Flush` needs `Run` running. Writes are asynchronous: a crash can lose the last
  transitions; reconcile then treats a just-created pod as an orphan (deleted, reported).
- Pods show `FailedMount` until the boot-ID Secret exists (expected, S0 §4.5).
- No liveness/readiness probes yet (distroless image, no port); the Lease covers split-brain. Job
  pods never get exec probes (exec fails once their cgroups are set up, S0).
- The platform's run machine `resources` are ignored: `job_pod` sizes every pod (local ceiling).
- CI's kind has no Kata: the kubevm e2e runs under runc with the test-only shared-kernel builds and
  fences the worker's own addresses off from its pods with iptables (kind's CNI doesn't).
