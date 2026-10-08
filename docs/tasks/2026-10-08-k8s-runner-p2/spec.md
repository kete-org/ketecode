# Spec: Enterprise runtime P2 — kubevm job pods, entrypoint kubevm profile, outbox, egress v2

- Task: `docs/tasks/2026-10-08-k8s-runner-p2` · Size: large · Created: 2026-10-08
- Status: **approved** under the Phase 8 approval (parent spec
  `docs/tasks/2026-10-07-enterprise-runtime/spec.md` §10 row P2 and its binding "S0 findings"
  amendments; ADR 0011 accepted)

## Goal
Real job pods for the enterprise Kubernetes runner: the controller starts each machine as the
released job image's entrypoint (profile `kubevm`) in a VM-isolated pod, hands it its machine
configuration and the runner's local section through a per-job Secret written after scheduling,
reads its phase lines, keeps its outputs in an outbox volume, and reports pod failures with
job-host-v2's reasons; the entrypoint proves it runs in its own kernel before writing anything,
claims only a runtime claim for the repository the runner resolved, clones from the runner's
source, bounds its result, writes the outbox and finishes with `{"outbox":true}`; kete-egress acts
on configuration v2 (enterprise proxy, CA bundle, internal ranges).

## Scope
- `packages/kete-job-entrypoint`: profile `kubevm` (`hostprofile`, source `file`), `--config-file`
  (`bootenv`: `node_boot_id`, `local` section, 48 KiB), boot-ID check first (`shared_kernel`),
  `setup_kubevm` (Secret unmount + proof, `/proc/sys` and `/sys/fs/cgroup` remounts),
  `host_boundary` with the Kubernetes API and node targets and a bounded retry (30 s), egress v2,
  the runtime claim (`ClaimRuntime`, fail closed), local clone + recorded base, bounded result,
  `internal/outbox` (manifest v1), `FinishOutbox`; test-only shared-kernel mode behind
  `-tags kete_testdriver` (equal boot IDs required, host-wide sysctls left alone; refused by release
  builds); the fake platform's runtime mode, job-host forwarding, persistent CA, `-linger`.
- `packages/kete-egress`: `serve`/`nft` on v2 (`config.Load`, `ConfigV2.Runtime`, host:port
  entries, address rules with forbidden and internal ranges, CONNECT through the upstream proxy
  with credentials, CA bundle, nft additions).
- `packages/kete-job-host`: config `pod_driver: kubevm`, `repository_sources`, `job_pod`,
  `proxy_auth_file`; kube client (PVCs, pods/log, RuntimeClasses, node addresses); driver
  (`KubeVMPod`, `KubeVMSecret`, outbox PVC + collector, `Logs`, `FailedError` →
  `pod_unschedulable`/`image_pull_failed`/`repository_unavailable`); agent (FailedError on v2,
  `Spec.Repository`); runner (kubevm wiring, RuntimeClass guard → `runtime_class_missing`, release
  refusal of `kete-test`, Sigstore verifier with an emptyDir TUF cache, proxy credentials).
- `packages/kete-runner-chart`: values/schema (kubevm default, `repositorySources`,
  `jobs.resources`, `jobs.outbox`, `proxy.authSecret`), ConfigMap, RBAC (pods/log, PVCs, clone
  Secrets by name, RuntimeClasses by name), admission (own-outbox PVC volume rule, outbox claims
  policy), Deployment (cache emptyDir, proxy credentials, `HTTPS_PROXY`, `SSL_CERT_DIR`), README.
- `packages/kete-job-image/scripts/build.sh --go-tags` (CI only).
- CI: `kete-runner.yml` (two-node kind; `ci/e2e-kubevm.sh`), `kete-job-entrypoint.yml` (test tag).
- Docs: chart README, entrypoint README "kubevm", egress README "Configuration v2", cards
  `kubernetes-runner`, `job-entrypoint`, `egress`, INDEX, this folder.

## Out of scope
The GitLab provider and publisher (P3: minted tokens, revoke on `clone_done`, bundle validation,
push, MR — the outbox is kept, never published), the platform serving v2 (P4), enterprise model
endpoints in job mode (P4d), a released runner image and its release workflow, controller
liveness/readiness probes, a Go result redactor (`summary: redacted` sends what `none` does).

## Acceptance criteria
- [ ] AC1: the kubevm entrypoint refuses `shared_kernel` before any write when its boot ID equals
  the node's or is missing; a release build refuses the test-only shared-kernel mode.
- [ ] AC2: it unmounts the config Secret, remounts, retries the host boundary within a bound, and
  refuses a claim that isn't a runtime claim for exactly its repository with nothing else sent.
- [ ] AC3: a kubevm job writes its full result, audit, proxy log, bundle and manifest to the outbox,
  sends a result bounded by the boundary, finishes `{"outbox":true}` and never uploads.
- [ ] AC4: kete-egress serves and generates rules from v2 (upstream CONNECT with credentials, CA
  bundle, internal ranges, forbidden ranges); v1 unchanged.
- [ ] AC5: the controller builds the S0 pod (caps, RuntimeClass, resources, no token), writes the
  per-job Secret after scheduling, reads phase lines from pods/log, reports `image_pull_failed`,
  `pod_unschedulable`, `repository_unavailable`, `runtime_class_missing`, keeps outboxes until
  expiry; a release build refuses `kete-test`.
- [ ] AC6: the chart lints/kubeconforms, refuses unsafe values, its rendered config parses, and the
  admission policies admit the kubevm pod and its own outbox only.
- [ ] AC7: kind e2e: a real job pod lifecycle (claim → scripted model → outbox → finish) and the
  refusals (wrong repository, wrong boot ID, shared kernel under the release rule, non-allowlisted
  and missing RuntimeClass, image pull).

## Risks and constraints
Security-sensitive (isolation check, credentials in a Secret, egress widening). Kata can't run in
GitHub's kind: CI proves control flow under runc with test-only builds; the VM boundary needs the
Kata acceptance run (handoff). No new dependencies; no upstream files.
