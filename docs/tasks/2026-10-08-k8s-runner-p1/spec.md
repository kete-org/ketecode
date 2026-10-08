# Spec: Enterprise runtime P1 — Helm chart + Kubernetes controller with a fake driver

- Task: `docs/tasks/2026-10-08-k8s-runner-p1` · Size: large · Created: 2026-10-08
- Status: **approved** under the Phase 8 approval (parent spec
  `docs/tasks/2026-10-07-enterprise-runtime/spec.md` §10 row P1, approved 2026-10-07; ADR 0011 accepted)

## Goal
The controller half of the enterprise Kubernetes runner: `kete-job-host` running as a non-root pod
that speaks job-host-v2, keeps its state and keys in cluster objects, holds a Lease, reaches the
platform through an enterprise proxy with a custom CA, and manages one pod per machine — proven on
kind with a test-only placeholder pod driver, packaged as a Helm chart with least-privilege RBAC,
an admission policy and NetworkPolicies.

## Scope
- `packages/kete-job-host` (card `job-host`, new card `kubernetes-runner`):
  - agent: pluggable `state.Store`; `Options.V2` (v2 reports/responses/seal, `checkV2`,
    `contract_mismatch` halt); v1 wire bytes unchanged.
  - client: v2 profile and limits; explicit proxy (never the environment's).
  - config: `driver: kubernetes` + `kubernetes` section (namespaces, Secrets, Lease, RuntimeClasses,
    proxy, CA bundle, repository names, boundary, pod driver, placeholder exits, start timeout).
  - `internal/kube`: minimal REST client (no client-go), Lease elector, `SecretStore`, `KeySecret`;
    `kubetest` fake API server.
  - `internal/driver/kubernetes`: generic pod driver (labels, boot-ID Secret after scheduling,
    owner reference, deletion once running, `activeDeadlineSeconds` second killer, reconcile list);
    placeholder `PodFunc` under build tag `kete_testdriver` only.
  - `internal/runner` + `kete-job-host kubernetes`: Lease, v2 enrollment from a token Secret, agent wiring.
  - fake platform: v2 mode; `cmd/kete-fake-platform` (TLS, admin API, CONNECT proxy) for kind.
- `packages/kete-runner-chart` (new): Deployment (1 replica, Recreate), SA, RBAC, jobs namespace
  (PSA privileged), ValidatingAdmissionPolicy, NetworkPolicies, ConfigMap, values + schema, README.
- CI `.github/workflows/kete-runner.yml`: helm lint, kubeconform, values refusals, Go tests (test
  tag), kind e2e. `kete-job-host.yml` also vets the test tag.
- Docs: chart README, card `kubernetes-runner`, INDEX, job-host card pointer, this folder.

## Out of scope (P2+)
VM-isolated job pod driver and `kubevm` profile, per-job machine config in the Secret, `pods/log`
phase lines, `runtime_class_missing`/`cluster_unhealthy` detection, pod failure reasons
(`pod_unschedulable`, `image_pull_failed`), publisher and outbox (P3), repository URLs/credentials,
proxy authentication, metrics, released runner image, platform v2 serving (P4), cross-runner
`cleanup` (O10/O11).

## Acceptance criteria
- [ ] AC1: the controller enrolls under job-host-v2 (kubernetes facts) from a token Secret, deletes
  the spent token, keeps keys and state in Secrets, and polls with v2 reports.
- [ ] AC2: a Lease allows one active replica; losing it stops the controller; restart re-adopts machines.
- [ ] AC3: placeholder machines start (pod + boot-ID Secret) and stop; exit and deadline kill work;
  orphans are killed at start; malformed run machines are refused before any pod.
- [ ] AC4: platform traffic honours the configured proxy and CA bundle; the API server is reached directly.
- [ ] AC5: chart passes `helm lint` and kubeconform; values schema/templates refuse unsafe values.
- [ ] AC6: kind e2e: install, enroll, poll, start/stop, orphan + deadline kill, admission policy refuses
  a runc pod (and foreign/privileged/non-allowlisted pods), RBAC least privilege.
- [ ] AC7: release builds refuse the placeholder driver; the k8s mode never runs the VM host guard.
- [ ] AC8: VM hosts (job-host-v1) behave as before (existing tests in kete-job-host.yml).

## Risks and constraints
Security-sensitive (RBAC, admission, credentials): tests cover token deletion/no-leak, creator
rule, capability and RuntimeClass rules, conflict-on-write. Contract: job-host-v2 types from P0c
unchanged. Dependencies: none added (client-go deliberately avoided). No upstream files touched.
