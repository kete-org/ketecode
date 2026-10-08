---
module: kubernetes-runner
paths: [packages/kete-runner-chart/**, packages/kete-job-host/internal/runner/**, packages/kete-job-host/internal/kube/**, packages/kete-job-host/internal/driver/kubernetes/**, .github/workflows/kete-runner.yml]
verified-at: 2605a2afd7
---

## Quick answers
- What is this module? The enterprise runner for Kubernetes (ADR 0011, Phase 8): `kete-job-host
  kubernetes`, the job host agent speaking **job-host-v2** as a non-root controller pod, plus the
  Helm chart `packages/kete-runner-chart`. Built in piece **P1** (task
  `docs/tasks/2026-10-08-k8s-runner-p1`): controller, Lease, state and keys in Secrets, proxy/CA,
  the generic pod driver with the boot-ID Secret handoff, a **test-only placeholder** pod driver,
  RBAC, admission policy, NetworkPolicies, kind e2e. The VM-isolated pod driver and `kubevm`
  entrypoint are P2; the GitLab publisher P3; the platform serves v2 from P4.
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
  (CONNECT; TLS verified end to end); `kubernetes.ca_bundle` → system roots + bundle. The kube
  client never uses a proxy. Proxy authentication is not built.

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
- `packages/kete-job-host/internal/driver/kubernetes/{kubernetes,placeholder,placeholder_release}.go`.
- `packages/kete-job-host/internal/fakeplatform/` — `V2` mode, `AssignV2`; `cmd/kete-fake-platform`
  (TLS + admin API + CONNECT proxy) for the kind e2e.
- `packages/kete-runner-chart/templates/` — `rbac.yaml`, `admission-policy.yaml`,
  `networkpolicy.yaml`, `deployment.yaml`, `configmap.yaml`, `namespace-jobs.yaml`.
- `packages/kete-runner-chart/ci/` — `e2e.sh`, `e2e-fixtures.yaml`, `kind.yaml`, `Dockerfile`, `lint-values.yaml`.

## Data flow
Helm values → ConfigMap `config.json` (subPath mount: a regular root-owned file, as `config.Load`
requires) → `runner.Run` → Lease → state/keys Secrets (enroll if needed) → agent poll loop over
the platform client (v2 signatures, proxy, CA) → desired state → `kubernetes` driver → pods +
boot-ID Secrets in the jobs namespace → status → reports.

## Data and APIs used
- job-host-v2 (`docs/platform/job-host-v2.md`), types in `internal/contract/v2.go`.
- Kubernetes API: pods/secrets/events in the jobs namespace; secrets/leases in the release
  namespace (by name); `get nodes`; `/version`.

## Rules that must not break
- Never two pollers on one key: the agent runs only while the Lease is held; losing it stops the process.
- No secret in values, ConfigMap or logs; the token Secret is deleted once spent.
- The admission policies are the jobs namespace's only guard (PSA `privileged` there) and always
  installed: only the controller SA creates or changes job pods; Pod Security baseline and more
  (volume allowlist, seccomp/AppArmor/SELinux/procMount/sysctls/hostProcess, no resource claims or
  volume devices, allowlisted digests, drop ALL + allowed caps); only the controller writes Opaque
  `kete-job-*` Secrets in the jobs namespace and its own two Secrets at home. The controller blocks
  starts while any policy or binding is missing.
- RBAC stays least privilege: no `pods/exec`, no cluster-wide Secrets, cluster scope = `get nodes`.
- The placeholder driver and accept-all verifier exist only under `-tags kete_testdriver`; a release
  build refuses `pod_driver: placeholder` before touching the cluster.
- Kubernetes run machines without `repository`, or with `publish` (until P3), never start.

## Testing
- `go test -race -tags kete_testdriver ./internal/kube/... ./internal/runner/... ./internal/driver/kubernetes/...`
  (no root needed; `kubetest` + fake platform v2 over TLS: lifecycle, refusals, deadline kill, orphan,
  restart, proxy, token handling). `go test ./internal/runner/...` without the tag: release refusal.
- Chart: `helm lint . --strict -f ci/lint-values.yaml`; `helm template … | kubeconform -strict`.
- kind e2e: `.github/workflows/kete-runner.yml` job `e2e` → `ci/e2e.sh`.

## Changes
- Adding a pod driver (P2): a `PodFunc` + a `pod_driver` value in `parseKubernetes` + `podDriver` in
  the runner; RBAC additions (e.g. `pods/log` for phase lines) go in `templates/rbac.yaml`.
- A new admission rule: `templates/admission-policy.yaml` and an e2e `denied` case.

## Gotchas
- The deadline kill fires at deadline + 5 min (`contract.DeadlineGrace`); the e2e waits for it.
- NetworkPolicy `apiServer.cidrs` must be the endpoint IPs (post-DNAT), port usually 6443 on kind.
- `SecretStore.Flush` needs `Run` running. Writes are asynchronous: a crash can lose the last
  transitions; reconcile then treats a just-created pod as an orphan (deleted, reported).
- Pods show `FailedMount` until the boot-ID Secret exists (expected, S0 §4.5).
- No liveness/readiness probes yet (distroless image, no port); the Lease covers split-brain.
