# kete-runner Helm chart

The Kete Code enterprise runner for Kubernetes (ADR 0011; design
`docs/tasks/2026-10-07-enterprise-runtime/spec.md` §4). It installs the `kete-job-host`
controller in `kubernetes` mode: it enrolls with the Kete platform under the job-host-v2 contract,
polls with signed requests (outbound HTTPS only, through your proxy if you set one), and runs each
unattended job in its own VM-isolated pod in a dedicated jobs namespace.

> **Status: pieces P1 and P2.** The controller, its state model, RBAC, admission policies,
> NetworkPolicies and the **`kubevm` pod driver** (each job the released job image's entrypoint,
> profile `kubevm`, in a VM-isolated pod with an outbox volume) are built. On kind CI a real job
> pod runs end to end under a test-only runc RuntimeClass with test builds of the runner and the
> entrypoint; **Kata itself has not yet run a full agent job** (spike S0 ran the pre-claim steps and
> a no-agent job in Kata; the acceptance run on x86 KVM hardware is open, see
> `docs/tasks/2026-10-08-k8s-runner-p2/handoff.md`). Still missing: the GitLab publisher (P3: an
> outbox is kept, never published), the platform serving job-host-v2 (P4) and a released runner
> image. A release runner image refuses `podDriver: placeholder` and the `kete-test` RuntimeClass.

## What it installs

| Object | Namespace | Purpose |
|---|---|---|
| Deployment `kete-runner` (1 replica, `Recreate`) | release (e.g. `kete-system`) | the controller, non-root, read-only root, all capabilities dropped, Pod Security `restricted` compliant, no ports, no probes on a port |
| ServiceAccount `kete-runner` | release | the controller's only identity |
| Role + RoleBinding | release | `get`/`update` on the keys and state Secrets and the Lease **by name**; `create` Secrets and Leases (first start); `get`/`delete` on the enrollment token Secret by name; `get` on the repositories' clone Secrets by name |
| Role + RoleBinding | jobs | pods `create, get, list, delete`; `pods/log` `get` (phase lines); secrets `create, get, delete`; persistentvolumeclaims `create, get, list, delete` (outboxes); events `create`. No `pods/exec`, `attach`, `portforward` |
| ClusterRole + Binding | — | `get` on nodes (the node boot ID and addresses the job checks), on the configured RuntimeClasses by name (`runtime_class_missing`) and on this release's admission policies and bindings by name (the fail-closed guard) |
| ConfigMap `kete-runner-config` | release | the controller's `config.json` (no secret in it) |
| Namespace `kete-jobs` (optional) | — | Pod Security `privileged` (job pods add capabilities inside their own VM), audit/warn `baseline` |
| 4 ValidatingAdmissionPolicies + Bindings | cluster | job pods, Secrets and outbox claims in the jobs namespace, the controller's own Secrets (below) |
| NetworkPolicies | release, jobs | controller: no ingress, egress to DNS, the API server and the platform/proxy only; jobs: default deny, DNS and the configured egress |

The Lease (`coordination.k8s.io`), the keys Secret `kete-runner-keys` and the state Secret
`kete-runner-state` are created by the controller at first start; `helm uninstall` leaves them, so a
reinstall keeps the runner's identity. Delete them (and create a new enrollment token) to re-enroll.

### Admission policies (always installed)

The jobs namespace is Pod Security `privileged`, so these ValidatingAdmissionPolicies (Kubernetes
≥ 1.30) are its only guard. There is no switch to turn them off, and the controller **fails closed**:
it checks at start and every 30 s that each policy exists with `failurePolicy: Fail` and a binding
of the same name that names it and denies; otherwise new starts are blocked (`cluster_unhealthy`).

`kete-runner-<jobs ns>-pods` — pods (create, update, ephemeral containers, resize) are refused
unless:

1. the request comes from the controller's ServiceAccount (`system:serviceaccount:<release ns>:
   <serviceAccountName>`) — nobody else creates **or changes** (labels, annotations, ephemeral
   containers, resize) a job pod;
2. `runtimeClassName` is one of `jobs.runtimeClassNames` (VM-isolated; `runc`/gVisor refused by the
   schema too);
3. no host network, PID or IPC namespace; no service account token; `enableServiceLinks: false`;
4. volumes are only `secret`, `emptyDir`, `projected` from secrets, configMaps and the downward
   API, and the pod's **own** outbox claim (`persistentVolumeClaim` named
   `kete-outbox-<the pod's kete.dev/machine-id label>`) — no hostPath, other PVCs, CSI, ephemeral,
   NFS, iSCSI, RBD, FC, …, no SA token projection;
5. no init or ephemeral containers, no `resourceClaims`, no `volumeDevices`, no host ports;
6. every image is from `jobs.images` (by digest);
7. no privileged container; every container drops `ALL` and adds only `jobs.allowedCapabilities`
   (the S0 set: `NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, SETUID, SETGID, KILL, CHOWN, DAC_OVERRIDE,
   FOWNER, FSETID, NET_BIND_SERVICE`);
8. no seccomp or AppArmor `Unconfined` (pod or container field, or the AppArmor annotation), no
   SELinux type override outside the baseline set (`container_t`, `container_init_t`,
   `container_kvm_t`, `container_engine_t`) and no SELinux user/role, no `procMount: Unmasked`, no
   pod sysctls, no Windows host process.

`kete-runner-<jobs ns>-secrets` — only the controller writes Secrets in the jobs namespace, and only
Opaque `kete-job-*` ones (the per-machine boot-ID/config Secrets), so nothing can squat a machine's
Secret name. P3's GitLab writer Secret will get its own, named exception.

`kete-runner-<jobs ns>-outboxes` — only the controller writes PersistentVolumeClaims in the jobs
namespace, only `kete-outbox-<machine-id>` labelled with that machine, `ReadWriteOnce`, without a
data source, selector or pre-bound volume (an outbox always starts empty, never a copy of another
job's).

`kete-runner-<release ns>-controller` — the controller may create or change only its own keys and
state Secrets (Opaque) in the release namespace (RBAC can't limit `create` by name).

## Prerequisites

- Kubernetes ≥ 1.30 with a VM-isolated RuntimeClass (AKS Pod Sandboxing, OpenShift sandboxed
  containers, Kata on EKS metal / GKE nested virtualisation). The controller blocks starts
  (`runtime_class_missing`) while a configured RuntimeClass doesn't exist. See "Kata" below.
- **etcd encryption at rest**: a per-job Secret carries the job's claim token and the repository's
  read credential until the pod runs (the controller deletes it then; the node keeps its tmpfs copy
  until the pod is deleted, spike S0).
- A CNI that enforces NetworkPolicy, ideally before a pod starts (Calico, Cilium). The job retries
  its host-boundary probe for 30 s, so a policy enforced a few seconds late is tolerated; one never
  enforced refuses every job (`host_boundary`), never runs one unfenced.
- A default StorageClass (or `jobs.outbox.storageClass`) for the outbox claims.
- An enrollment token from the portal (P4).

## Job pods (podDriver: kubevm)

For each machine the controller (after the image allowlist and the job image's cosign signature):

1. creates the outbox claim `kete-outbox-<machine>` (`jobs.outbox.size`, `ReadWriteOnce`);
2. creates the pod `kete-job-<machine>`: the job image by digest running
   `kete-job-entrypoint --config-file /run/kete-config/config.json`, `KETE_JOB_HOST_PROFILE=kubevm`,
   `runtimeClassName` = the first of `jobs.runtimeClassNames`, requests = limits =
   `jobs.resources`, `privileged: false`, `allowPrivilegeEscalation: false`, capabilities `drop:
   [ALL]` plus exactly the S0 set (above), no service account token, no service links,
   `restartPolicy: Never`, `activeDeadlineSeconds` = deadline + 6 min, the outbox mounted at
   `/var/lib/kete-outbox`. No probes: `exec` into a job pod fails once its cgroups are set up (S0);
3. once the pod is scheduled, reads the node's boot ID and addresses and writes the per-job Secret
   `kete-job-<machine>` (owner: the pod): `config.json` = the platform's sealed machine
   configuration (job id, platform URL, claim token, profile `kubevm`) plus the node's boot ID and
   the runner's **local section** — the repository's name, clone URL, ref and read credential, the
   data boundary, the proxy (URL and credentials), the CA bundle (with a proxy) and `jobs.egress`
   as internal ranges, and the node's addresses. None of the local section ever comes from or goes
   to the platform;
4. deletes the Secret once the pod runs, reads the pod's log for phase lines (the entrypoint's
   stdout carries nothing else), and maps the pod to the machine: `ImagePullBackOff`/`ErrImagePull`
   past 60 s or an invalid image → `failed`/`image_pull_failed`; still unschedulable after
   `jobs.startTimeoutSeconds` → `failed`/`pod_unschedulable`; a clone Secret that can't be read →
   `failed`/`repository_unavailable`; exited → `destroyed`/`exited`;
5. keeps the outbox after the pod is gone and deletes it `jobs.outbox.holdHours` after the
   machine's deadline (P3's publisher reads and deletes it).

Inside the pod the entrypoint (`packages/kete-job-entrypoint`, README "kubevm") refuses to run
unless its kernel's boot ID differs from the node's (`shared_kernel`, before anything is written),
unmounts the Secret, proves the host boundary (the node, the Kubernetes API, metadata, private
ranges) unreachable, sets up its firewall and kete-egress (configuration v2: through your proxy,
with your CA bundle, internal ranges = `jobs.egress`), claims only a runtime claim naming exactly
the repository the runner resolved, clones from the runner's source, runs `kete job run`, sends a
result bounded by `boundary`, writes the full result, audit log, proxy log and bundle to the outbox,
and finishes with `{"outbox": true}` — it never uploads.

### Kata

The capability set, the remounts and the boot-ID check were measured on Kata 4.2 (QEMU, runtime-rs)
in spike S0. Per platform, before production:

- size the Kata guest so it sees the job's memory (`default_memory`, and
  `static_sandbox_resource_mgmt` so the guest's `MemTotal` follows the pod limit — the entrypoint
  derives its cgroup limits from it), and keep `enable_mem_prealloc` off;
- set the RuntimeClass's `overhead.podFixed` to the measured per-pod cost (S0: about 390 MB for
  QEMU; the scheduler then reserves it);
- check NetworkPolicy enforcement timing and that `kubectl logs` works for the RuntimeClass.

## Proxy and CA

`proxy.url` is used by the controller (platform connection, job image verification through
`HTTPS_PROXY`) and by every job's kete-egress as its upstream (`CONNECT`). Credentials come from
`proxy.authSecret` (a key holding `username:password`), never from the URL. `caBundle` adds roots
for the controller (platform, image verification via `SSL_CERT_DIR`) and, with a proxy, for the
jobs' upstream TLS (kete-egress takes extra roots with its upstream proxy only; at most 32 KiB). Job
pods reach the proxy only if `jobs.egress` lists its address and port: the same CIDRs and ports are
the jobs namespace's NetworkPolicy and the jobs' internal ranges.

## Install

```sh
kubectl create namespace kete-system
kubectl label namespace kete-system pod-security.kubernetes.io/enforce=restricted
kubectl -n kete-system create secret generic kete-runner-enrollment --from-literal=token=kete_jhe_…
# optional: your proxy's or platform's CA
kubectl -n kete-system create secret generic corp-ca --from-file=ca.crt=corp-ca.pem
helm install kete-runner ./packages/kete-runner-chart -n kete-system -f my-values.yaml
kubectl -n kete-system logs deploy/kete-runner | grep fingerprint   # compare in the portal, then approve
```

`my-values.yaml` (see `values.yaml` for every key and `ci/lint-values.yaml` for a full example):

```yaml
platform: {url: https://portal.kete.example}
image: {repository: registry.corp/kete/runner, digest: "sha256:…"}
enrollment: {tokenSecret: kete-runner-enrollment}
proxy: {url: http://proxy.corp:3128}
caBundle: {existingSecret: corp-ca}
jobs:
  runtimeClassNames: [kata]
  images: ["registry.corp/kete/job@sha256:…"]
  slots: 16
  egress: {cidrs: ["10.20.0.10/32", "10.30.0.0/24"], ports: [443, 3128]}   # the proxy, GitLab
  resources: {cpu: "2", memory: 4Gi, ephemeralStorage: 20Gi}
repositories: ["gitlab:payments/api"]
repositorySources:
  - {name: "gitlab:payments/api", url: "https://gitlab.corp/payments/api.git", cloneSecret: gitlab-payments-read}
podDriver: kubevm
boundary: {summary: none, denials: actions, publishRefs: send}
networkPolicy:
  apiServer: {cidrs: ["10.0.0.1/32"], port: 443}   # kubectl get endpoints kubernetes -n default
  platform: {cidrs: ["10.20.0.10/32"], ports: [3128]}
```

No value takes a secret: the enrollment token, CA bundle, proxy credentials and clone credentials
(`kubectl create secret generic gitlab-payments-read --from-literal=username=… --from-literal=token=…`,
a read-only deploy token) are referenced by Secret name. Images are pinned by digest only; the job
image's cosign signature is verified by the controller before a pod is created (`image.Sigstore`,
TUF cache in an `emptyDir`; the registry and Sigstore are reached through the proxy, or the
controller's `networkPolicy.platform` must allow them).

## How the controller keeps state

- **Keys** (Ed25519 signing, X25519 sealing) in `kete-runner-keys`, annotated with the fingerprint
  and `kete.dev/keys: staged|enrolled`; staged keys (an interrupted enrollment) are never used.
- **State** (host id, generation, applied revision, halts, every machine and tombstone) in
  `kete-runner-state` as the same validated JSON as a VM host's `state.json`, written behind the
  agent's lock with a conditional `resourceVersion` update; a failed write blocks new starts until
  one succeeds.
- **Machines** are pods named `kete-job-<machine-id>`, labelled `app.kubernetes.io/managed-by:
  kete-runner`, `kete.dev/role: job`, `kete.dev/machine-id`, `kete.dev/job-id`, `kete.dev/deadline`
  (Unix seconds). At start the controller lists them: a labelled pod the state doesn't hold is
  deleted (orphan kill) and reported; a held one is re-adopted. Each pod has
  `activeDeadlineSeconds` = deadline + 6 min, a second killer behind the controller's own
  (deadline + 5 min), which works while the platform is unreachable.
- **One active replica**: a Lease (15 s, renewed every 2 s). Each renewal is bounded by the renew
  deadline (10 s after the last success); past it the replica stops acting as the host and exits
  (Kubernetes restarts it). On a clean shutdown it releases the Lease only after its final state
  write. A state write that conflicts (someone else wrote the Secret) is fatal too: the controller
  exits and reloads.
- Job pods carry `app.kubernetes.io/instance: <release>`; a runner only ever lists or deletes its
  own release's pods.

## Tests

`.github/workflows/kete-runner.yml` runs both on a two-node kind cluster with a local registry:

- `ci/e2e.sh` (P1) installs the chart (placeholder pod driver) against the job-host fake and checks
  enrollment through the proxy with the custom CA, RBAC, the admission policy, machines starting
  and stopping, exit, `repository_unknown`, orphan kill across a restart and the deadline kill.
- `ci/e2e-kubevm.sh` (P2) installs a second release with `podDriver: kubevm` and the job image
  built with `-tags kete_testdriver`, against the jobs-v1 fake and the job-host fake behind one
  platform origin and a CONNECT proxy, all outside the cluster: a real job pod end to end (boot-ID
  check in its test-only shared-kernel mode, Secret unmount, host boundary, egress v2 through the
  proxy, the runtime claim, the clone with the runner's credential, the scripted model through
  `kete job run`, the bounded result, the outbox, `finish {"outbox":true}`, no uploads), and the
  refusals: a claim naming another repository, a wrong node boot ID and a shared kernel under the
  release rule (`shared_kernel` before any write), a non-allowlisted RuntimeClass, a missing one
  (`runtime_class_missing`), an image that can't be pulled (`image_pull_failed`).

The `kete-test` RuntimeClass (runc) exists only in CI; only test builds of the runner and the
entrypoint accept it. GitHub's runners can't run Kata in kind, so CI proves the controller, the
pod, the entrypoint's control flow and the egress, not the VM boundary.
