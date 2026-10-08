# Handoff: Enterprise runtime P1 — Helm chart + Kubernetes controller with a fake driver

## 2026-10-08 implementer (Claude)
- Done: see result.md. Built in the sparse worktree `feature/k8s-runner-p1`.
- Decisions:
  - **No client-go.** `internal/kube` is a ~600-line REST client for exactly the calls needed
    (pods, secrets, events, leases, `get nodes`, `/version`). client-go would add dozens of modules
    (k8s.io/api, apimachinery, …) to an agent whose dependency set is audited; the surface here is small.
  - **The controller is the existing agent**, not a copy: `agent.Options.Store` and `agent.Options.V2`.
    Reports are built in v2's shape and written as v1's `Report` for v1 hosts (same struct → same bytes).
  - **State in one Secret** (`kete-runner-state`, the state.json document) written behind the agent
    lock, plus labelled pods as the reconcile source. Keys in `kete-runner-keys` (staged → enrolled).
  - **Enrollment in the controller** (from a token Secret, deleted once spent) instead of a Helm
    hook Job: one code path, no extra RBAC subject. The fingerprint is logged for comparison.
  - **Boot-ID handoff built now** in the generic pod driver (create pod → wait for node → read
    `bootID` → create owner-referenced Secret → delete once Running), so P2 only adds the job's
    configuration to the Secret and the VM pod spec.
  - **`activeDeadlineSeconds` = deadline + 6 min** (spec said + 5): one minute behind the
    controller's own kill so the kubelet acts only when the controller is gone and the reason stays
    `deadline`.
  - **RBAC deviation from spec §4.3**: no `get runtimeclasses` (task brief: cluster scope `get nodes`
    only; the RuntimeClass existence check is P2 and will need it), no `pods/log` (P2, phase lines),
    events `create` (not `list`): the controller records Events on job pods.
  - **Run machines with `publish` are refused `config_invalid`** until the publisher exists (P3),
    rather than run and silently never published.
- Open for P2: `runtime_class_missing` check (+ RBAC), pod failure reasons, `pods/log`, liveness
  probe, the released runner image (multi-arch, cosign), proxy authentication via a Secret,
  `cluster_unhealthy`.

## 2026-10-08 implementer (Claude) — security review round
- Fixed on the same branch: (1) admission policy extended to Pod Security baseline and more
  (volume allowlist, seccomp/AppArmor field+annotation/SELinux/procMount/sysctls/hostProcess,
  volumeDevices, resourceClaims), matches `pods/resize`, and refuses any UPDATE of job pods by
  anyone but the controller; (2) no switch to disable the policies, and the controller's
  `policyGuard` blocks starts (`cluster_unhealthy`) unless every policy + Deny binding exists
  (RBAC: `get` by name); (3) the Lease is released only in `finish`, after the agent stopped and
  the final state flush; (4) a 409 on the state Secret is fatal (runner stops, restart reloads);
  (5) each renewal is bounded by the renew deadline and Hold gives up the moment it passes;
  (6) a Secret policy for the jobs namespace (controller only, Opaque `kete-job-*`) and pod deletion
  on a 409 when creating the machine Secret. Nits: schema patterns and `quote` for interpolated
  values, jobs egress refuses `0.0.0.0/0`, `::/0`, prefixes shorter than /8 and the link-local
  metadata range, a policy limiting the controller's own Secret writes to its two names (Opaque),
  `app.kubernetes.io/instance` on job pods and in the List selector, staged keys reused on an
  enrollment retry, pod list paging (`continue`), CI tools and images pinned (kind node image,
  registry, busybox by digest; helm, kind, kubeconform by version).
- e2e limits, stated honestly: the Windows host-process case also sets `hostNetwork` (API
  validation requires it), so that denial may come from the host-namespace rule; the volume-device
  case also needs a PVC volume, refused by the volume rule; `pods/resize` doesn't exist on the kind
  1.32 node (the rule is in place, not exercised).
- **Tracked for P2:** the RuntimeClass existence check (`runtime_class_missing`; needs `get
  runtimeclasses` by name), plus `pods/log`, pod failure reasons, `cluster_unhealthy` for an
  unhealthy API server, probes, proxy authentication, the released runner image. P3: the GitLab
  writer Secret's exception in the jobs-namespace Secret policy (or its own namespace).
