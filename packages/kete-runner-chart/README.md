# kete-runner Helm chart

The Kete Code enterprise runner for Kubernetes (ADR 0011; design
`docs/tasks/2026-10-07-enterprise-runtime/spec.md` §4). It installs the `kete-job-host`
controller in `kubernetes` mode: it enrolls with the Kete platform under the job-host-v2 contract,
polls with signed requests (outbound HTTPS only, through your proxy if you set one), and runs each
unattended job in its own VM-isolated pod in a dedicated jobs namespace.

> **Status: piece P1.** The controller, its state model, RBAC, admission policy and
> NetworkPolicies are built and tested on kind with a **test-only placeholder pod driver**. The
> VM-isolated job pod driver (Kata, the `kubevm` entrypoint profile) is P2, the GitLab publisher
> P3, and the platform serves job-host-v2 from P4. A release runner image refuses
> `podDriver: placeholder`, so this chart does not run real jobs yet.

## What it installs

| Object | Namespace | Purpose |
|---|---|---|
| Deployment `kete-runner` (1 replica, `Recreate`) | release (e.g. `kete-system`) | the controller, non-root, read-only root, all capabilities dropped, Pod Security `restricted` compliant, no ports, no probes on a port |
| ServiceAccount `kete-runner` | release | the controller's only identity |
| Role + RoleBinding | release | `get`/`update` on the keys and state Secrets and the Lease **by name**; `create` Secrets and Leases (first start); `get`/`delete` on the enrollment token Secret by name |
| Role + RoleBinding | jobs | pods `create, get, list, delete`; secrets `create, get, delete`; events `create`. No `pods/exec`, `attach`, `portforward` |
| ClusterRole + Binding | — | `get` on nodes only (the node boot ID the job compares with its own) |
| ConfigMap `kete-runner-config` | release | the controller's `config.json` (no secret in it) |
| Namespace `kete-jobs` (optional) | — | Pod Security `privileged` (job pods add capabilities inside their own VM), audit/warn `baseline` |
| ValidatingAdmissionPolicy + Binding | cluster | every pod in the jobs namespace must pass the rules below |
| NetworkPolicies | release, jobs | controller: no ingress, egress to DNS, the API server and the platform/proxy only; jobs: default deny, DNS and the configured egress |

The Lease (`coordination.k8s.io`), the keys Secret `kete-runner-keys` and the state Secret
`kete-runner-state` are created by the controller at first start; `helm uninstall` leaves them, so a
reinstall keeps the runner's identity. Delete them (and create a new enrollment token) to re-enroll.

### Admission policy (jobs namespace)

Kubernetes ≥ 1.30 (`ValidatingAdmissionPolicy` GA). A pod is refused unless:

1. it is created by the controller's ServiceAccount (`system:serviceaccount:<release ns>:kete-runner`);
2. its `runtimeClassName` is one of `jobs.runtimeClassNames` (VM-isolated classes; `runc` and gVisor
   are refused by the values schema too);
3. it uses no host network, PID or IPC namespace and no `hostPath` volume;
4. it gets no service account token (`automountServiceAccountToken: false`, no projected token);
5. `enableServiceLinks: false`;
6. it has no init or ephemeral containers;
7. every container runs an image from `jobs.images` (by digest);
8. no container is privileged; every container drops `ALL` and adds only `jobs.allowedCapabilities`
   (the S0-measured set: `NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, SETUID, SETGID, KILL, CHOWN,
   DAC_OVERRIDE, FOWNER, FSETID, NET_BIND_SERVICE`);
9. no container uses a host port.

## Prerequisites

- Kubernetes ≥ 1.30 with a VM-isolated RuntimeClass (AKS Pod Sandboxing, OpenShift sandboxed
  containers, Kata on EKS metal / GKE nested virtualisation) — needed from P2.
- **etcd encryption at rest** (per-job Secrets will carry a claim token for minutes).
- A CNI that enforces NetworkPolicy, ideally before a pod starts (Calico, Cilium).
- An enrollment token from the portal (P4).

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
repositories: ["gitlab:payments/api"]
boundary: {summary: none, denials: actions, publishRefs: send}
networkPolicy:
  apiServer: {cidrs: ["10.0.0.1/32"], port: 443}   # kubectl get endpoints kubernetes -n default
  platform: {cidrs: ["10.20.0.10/32"], ports: [3128]}
```

No value takes a secret: the enrollment token and CA bundle are referenced by Secret name. Images
are pinned by digest only; the job image's cosign signature is verified by the controller before a
pod is created (P2, existing `image.Sigstore`).

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
- **One active replica**: a Lease (15 s, renewed every 2 s, lost after 10 s without renewal). A
  replica that loses it exits and is restarted; the old one releases it on shutdown.

## Tests

`ci/e2e.sh` (run by `.github/workflows/kete-runner.yml` on kind with a local registry) installs the
chart against the repository's fake platform and checks enrollment through the proxy with the
custom CA, RBAC, the admission policy, machines starting and stopping, exit, `repository_unknown`,
orphan kill across a restart and the deadline kill.
