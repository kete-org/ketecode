# Handoff: Enterprise runtime P2 — kubevm job pods, entrypoint kubevm profile, outbox, egress v2

## 2026-10-08 implementer (Claude)
- Done: see result.md. Built in the sparse worktree `feature/k8s-runner-p2`; PR kete-org/ketecode#23.
- Decisions:
  - **The job's local section travels in the per-job Secret as the entrypoint's own
    configuration** (`config.json`: the sealed fields + `node_boot_id` + `local`), read with
    `--config-file /run/kete-config/config.json` (that exact path). The two modules share no Go code:
    `kete-job-host internal/driver/kubernetes/kubevm.go` (`jobConfig`) and
    `kete-job-entrypoint internal/bootenv/kubevm.go` (`Config`/`Local`) must change together.
  - **Boot ID first, unmount second.** The boot stage only reads the file; `setup_host` (boot-ID
    rule) runs before anything is written; the Secret volume is unmounted in `setup_kubevm` right
    after. Unmounting is itself a write (the mount table), so it can't come before the check.
  - **Test-only shared-kernel mode inverts the rule** (equal boot IDs required) instead of skipping
    it, so kind CI still proves the runner read the pod's node, and a wrong node boot ID is still
    refused. It also leaves the three host-wide sysctls alone (they'd change the CI node). Release
    builds refuse the flag in `bootenv` and in `hostprofile`; the runner's release build refuses the
    `kete-test` RuntimeClass, and only its test build writes the flag.
  - **Host boundary before the firewall, as root, with a 30 s retry.** egress-config-v2 says the
    kubevm probe runs "after the firewall"; root before the in-guest rules reaches strictly more
    than any user after them, so a pass here implies a pass there. Targets added: the Kubernetes API
    (`KUBERNETES_SERVICE_HOST:PORT`, code `kube_api`) and the node's addresses from the Node object
    (`node`). Recorded as an interpretation, not a deviation; say so if the platform side disagrees.
  - **Repository sources with static read credentials in P2** (`repository_sources`, a Secret with
    `username`/`token` in the controller namespace, RBAC `get` by name): needed to run a real job.
    P3 adds minted tokens and the writer/publisher. The run machine's `base_ref` is the clone ref;
    the entrypoint records the commit it got as `base_sha` (`git rev-parse`), as spec §4.5 says.
  - **Outbox format v1**: `result.json` (full), `audit.jsonl`, `proxy.jsonl`, `bundle.tar.gz`, then
    `manifest.json` (atomic, last) with sizes and SHA-256; root, group 65532 (the runner image's
    non-root group), files 0640, directory 0750. Kept after the pod; collected `holdHours` after the
    deadline. P3's publisher must treat all of it as hostile.
  - **`summary: redacted` sends what `none` does** until a vetted Go redactor exists (stricter,
    never wider).
  - **kete-egress v2 as a runtime form of v1's Config** (allowlists keyed by `host`/`host:port`),
    not a parallel proxy: v1 behaviour and output are unchanged (golden tests).
  - **The upstream CA bundle needs a proxy** (egress v2 puts `ca_bundle_file` under `upstream`):
    without a proxy the chart's `caBundle` serves the controller only. Contract gap worth raising
    on the platform side if enterprises without a proxy use private CAs for GitLab.
  - **Pod failure reasons via `driver.FailedError`**: image pull errors past 60 s (invalid names at
    once) → `image_pull_failed`; unschedulable past the start timeout → `pod_unschedulable`; a
    missing/unreadable clone Secret → `repository_unavailable`. The agent applies them on v2 hosts
    only and removes the pod.
  - **Kind CI fence**: kind's CNI doesn't fence a pod off from its own node's addresses, so the e2e
    adds iptables REJECT rules on the job worker for traffic from its pod CIDR to the node itself
    (a production CNI/Kata node's job), and runs the fakes outside the cluster on the `kind` Docker
    network, so the NetworkPolicy and the probe are exercised as in an enterprise.
- **Not proven / open (needs action):**
  - **Kata acceptance on x86 KVM hardware** (S0 couldn't finish an agent job under nested virt on
    Apple silicon). Run, on a bare-metal or x86 nested-KVM k3s/kubeadm node with Kata 4.x
    (QEMU or Cloud Hypervisor), the chart with `podDriver: kubevm`, a *release* runner image and a
    *release* job image (no test tags), a real RuntimeClass (`kata-qemu`, overhead.podFixed ≈ 400Mi),
    against the fakes as in `ci/e2e-kubevm.sh` (or staging): (1) a lifecycle job to `finish`, with
    timings; (2) a runc pod with the same config → `shared_kernel`; (3) `kubectl logs` phase lines
    reach the controller; (4) the Secret volume is gone in the guest; (5) the guest's `MemTotal`
    follows the limit (Kata `default_memory`/`static_sandbox_resource_mgmt`); (6) NetworkPolicy
    enforcement timing vs the 30 s retry. Then one managed cluster each (AKS Pod Sandboxing,
    OpenShift sandboxed containers, EKS metal, GKE nested), as the parent spec lists.
  - **`seccompProfile: RuntimeDefault` inside Kata** is still untested (S0); the pod sets none.
  - **Released runner image** (multi-arch, cosign, in `kete-release.yml`): not built in this piece;
    the chart needs one before any customer install.
  - **Controller probes** (liveness/readiness without a port): not built; the Lease covers
    split-brain.
  - **Image verification behind a TLS-intercepting proxy**: `SSL_CERT_DIR` with a subPath mount of
    the CA is wired but not exercised in CI (the test build accepts all images).
  - P3: the GitLab writer Secret's exception in the jobs-namespace Secret policy; publisher pods'
    admission; minted token revoke on `clone_done` (the phase line now reaches the controller).
