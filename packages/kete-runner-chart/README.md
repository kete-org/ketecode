# kete-runner Helm chart

The Kete Code enterprise runner for Kubernetes (ADR 0011; design
`docs/tasks/2026-10-07-enterprise-runtime/spec.md` §4). It installs the `kete-job-host`
controller in `kubernetes` mode: it enrolls with the Kete platform under the job-host-v2 contract,
polls with signed requests (outbound HTTPS only, through your proxy if you set one), and runs each
unattended job in its own VM-isolated pod in a dedicated jobs namespace.

> **Status: pieces P1, P2 and P3.** The controller, its state model, RBAC, admission policies,
> NetworkPolicies, the **`kubevm` pod driver** (each job the released job image's entrypoint,
> profile `kubevm`, in a VM-isolated pod with an outbox volume) and the **GitLab self-managed
> provider and publisher** (per-job clone tokens, publisher pods that validate the job's bundle and
> push a new branch with a draft merge request) are built. On kind CI a real job pod runs and is
> published end to end against a fake GitLab under a test-only runc RuntimeClass with test builds of
> the runner and the entrypoint; **Kata itself has not yet run a full agent job or a publisher**
> (spike S0 ran the pre-claim steps and a no-agent job in Kata; the acceptance run on x86 KVM
> hardware is open, see `docs/tasks/2026-10-08-k8s-runner-p2/handoff.md`), and **no real GitLab
> has been used yet** (`docs/tasks/2026-10-09-k8s-runner-p3/handoff.md`). Still missing: the
> platform serving job-host-v2 (P4), audit-log shipping to an enterprise sink, and a released
> runner image. A release runner image refuses `podDriver: placeholder` and the `kete-test`
> RuntimeClass.

## What it installs

| Object | Namespace | Purpose |
|---|---|---|
| Deployment `kete-runner` (1 replica, `Recreate`) | release (e.g. `kete-system`) | the controller, non-root, read-only root, all capabilities dropped, Pod Security `restricted` compliant, no ports, no probes on a port |
| ServiceAccount `kete-runner` | release | the controller's only identity |
| Role + RoleBinding | release | `get`/`update` on the keys and state Secrets and the Lease **by name**; `create` Secrets and Leases (first start); `get`/`delete` on the enrollment token Secret by name; `get` on the repositories' static clone Secrets and minter Secrets by name |
| Role + RoleBinding | jobs | pods `create, get, list, delete` (job and publisher pods); `pods/log` `get` (phase lines); secrets `create, delete` (**no `get`**: the writer Secrets there stay unreadable to the controller); persistentvolumeclaims `create, get, list, delete` (outboxes); events `create`. No `pods/exec`, `attach`, `portforward` |
| ClusterRole + Binding | — | `get` on nodes (the node boot ID and addresses the job checks), on the configured RuntimeClasses by name (`runtime_class_missing`) and on this release's admission policies and bindings by name (the fail-closed guard) |
| ConfigMap `kete-runner-config` | release | the controller's `config.json` (no secret in it) |
| ConfigMap `kete-publisher` (when a repository publishes) | jobs | the publisher's `publish.json`: repositories, GitLab URLs, writer Secret names, proxy (no secret); the controller has no access to ConfigMaps |
| Namespace `kete-jobs` (optional) | — | Pod Security `privileged` (job pods add capabilities inside their own VM), audit/warn `baseline` |
| 5 ValidatingAdmissionPolicies + Bindings | cluster | job and publisher pods, Secrets (and the publisher Secrets' exception) and outbox claims in the jobs namespace, the controller's own Secrets (below) |
| NetworkPolicies | release, jobs | controller: no ingress, egress to DNS, the API server, the platform/proxy and (optionally) GitLab only; job pods: default deny, DNS and the configured egress; publisher pods: DNS and `publisher.egress` (GitLab or the proxy) only |

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

Publisher pods (label `kete.dev/role: publish`) are held to more: exactly one container, the runner
image (`image.repository@image.digest`), command `/usr/local/bin/kete-job-host publish` with
exactly its fixed flags, no environment, no lifecycle hooks or probes, no working directory or
custom termination-message path, `runAsNonRoot`, read-only root file system, no added
capabilities, every mount read-only at its fixed path, and only these volumes: the machine's own
outbox claim with `readOnly: true`, the `kete-publisher` ConfigMap and the publisher Secrets.
**No pod at all may read a Secret through `env.valueFrom` or `envFrom`** (job and publisher pods
use literal values only). **No other pod — no job
pod — may mount a publisher Secret** (directly or through a projected volume).

`kete-runner-<jobs ns>-secrets` — only the controller writes Secrets in the jobs namespace, and only
Opaque `kete-job-*` ones (the per-machine boot-ID/config Secrets), so nothing can squat a machine's
Secret name. The one named exception: the **publisher Secrets** (every `writerSecret`,
`publisher.caBundleSecret`, `publisher.proxyAuthSecret`), which you (or External Secrets) create.

`kete-runner-<jobs ns>-publisher-secrets` — the controller may not create, change or delete a
publisher Secret (and its Role has no `get` on Secrets in the jobs namespace), so it can neither read
the GitLab writer credential nor swap it for one it knows.

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
- A StorageClass for the outbox claims (`jobs.outbox.storageClass`, required; below).
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
   data boundary, the proxy (URL and the *jobs'* credential), the CA bundle (with a proxy) and
   `jobs.egress` as internal ranges (refused if one contains the node's addresses, its pod range or
   the Kubernetes API), and the node's addresses. None of the local section ever comes from or goes
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

### Outbox storage

The outbox is written by a job VM (under Kata a filesystem volume is typically shared into the
guest through virtio-fs, served on the node by `virtiofsd`) and later read by the publisher, so its
StorageClass must keep it a bounded, inert data volume:

- **enforces capacity** (a block-backed CSI driver: EBS, Azure Disk, PD, Ceph RBD, …), so a job
  can't fill a node disk; the admission policy caps each claim at `jobs.outbox.maxSize` and pins the
  class;
- **`mountOptions: [nosuid, nodev, noexec]`** — the controller blocks starts (`cluster_unhealthy`)
  while the class lacks one of them;
- **not a node-directory provisioner**: `rancher.io/local-path`, hostPath and no-provisioner
  classes are refused by release builds (they create world-writable node directories and ignore
  capacity; only kind CI uses local-path, with a test build);
- `ReadWriteOncePod` access (`jobs.outbox.accessMode`, the default): one pod at a time — the job,
  then the publisher. `ReadWriteOnce` only where the volume plugin lacks `ReadWriteOncePod`.

The publisher (P3) must mount an outbox read-only with `nosuid,nodev,noexec` and treat every file
as hostile.

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

**Credentials.** `proxy.authSecret` is the controller's. Jobs get their own,
`jobs.proxy.authSecret` (none by default): every job VM holds it in memory while it runs, so give
it a separate, narrowly scoped proxy account. The controller's credential never reaches a job.

**Image verification behind an authenticating proxy** is not supported yet: the controller's
Sigstore/registry fetches use `HTTPS_PROXY` without credentials. Allow the registry and Sigstore
hosts without authentication for the controller, or reach them directly
(`networkPolicy.platform`).

**RuntimeClass handlers.** Besides existing, each configured RuntimeClass must not use a
shared-kernel handler (`runc`, `crun`, `youki`, `runsc`/`gvisor`): release builds block starts
(`cluster_unhealthy`) otherwise, whatever the class is called.

Prefer an `https://` proxy when it takes credentials: over `http://` the `Proxy-Authorization`
header crosses your network in clear (as with any HTTP proxy). Jobs send `CONNECT host:port` by
name, so the proxy resolves the destination itself: kete-egress checks the addresses it resolves
(and refuses a name with none allowed), but **with a proxy, forbidden-range enforcement on the final
destination depends on your proxy's resolution and policy** (egress configuration v2, "DNS with an
upstream proxy"). A `407` pauses every job connection through the proxy for a minute instead of
retrying the credential.

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

## GitLab (self-managed) and publishing

Each job of a runtime repository (`gitlab:group/project`) clones from your GitLab with a **read**
credential the controller hands only to that job's root entrypoint, and — when the job asked for a
push — is published by a **publisher pod** that holds the only **write** credential. Kete's
platform stores the repository's name only; GitLab URLs, tokens, the source and the diff never
reach it (spec §3, §5).

### Bot user and tokens

Create a bot user (e.g. `kete-bot`) and, per repository:

| Credential | Where | Scopes / role | Used by |
|---|---|---|---|
| **Writer** (`writerSecret`, key `token`) | Secret in the **jobs** namespace | the bot's personal access token: `api`, `write_repository`; the bot is **Developer** on the project | publisher pods only: project and branch reads, the create-only push, the draft merge request |
| **Deploy token** (`cloneSecret`, keys `username`, `token`; `cloneMode: static`, **recommended, the default**) | Secret in the **release** namespace | a project deploy token with `read_repository` | the controller copies it into each job's Secret and checks it by resolving the job's base branch (no revocation: rotate it yourself) |
| **Minter** (`minterSecret`, key `token`; `cloneMode: minted`, needs `acceptMinterRisk: true`) | Secret in the **release** namespace | a token with `api` of a user who is **Maintainer** on the project (GitLab requires Maintainer to create project access tokens); use a **dedicated minter bot with no other role** | the controller: per job it creates a project access token `kete-job-<release>-<machine>` (scope `read_repository`, role Reporter, expiring the next day), checks it by resolving the job's base branch, puts it in the job's Secret, and revokes it when the job reports `clone_done`, again when the job pod ends, and in a sweep every 5 minutes (tokens left by a restart) |

> **Threat model: writer isolation holds against a compromised controller only with
> `cloneMode: static`.** A minter is a Maintainer token with scope `api` inside the controller; a
> compromised controller could use it to mint tokens that can write. The chart refuses `minted`
> unless you set `acceptMinterRisk: true`. In both modes the writer itself never reaches the
> controller or a job pod.

Use separate tokens for the minter and the writer even if one bot owns both: the writer must be
the identity that **can't** push to your base branches (below), and a Maintainer usually can.

```sh
kubectl -n kete-jobs   create secret generic gitlab-kete-writer --from-literal=token=glpat-…   # jobs namespace
kubectl -n kete-system create secret generic gitlab-payments-read --from-literal=username=gitlab+deploy-token-1 --from-literal=token=gldt-…   # release namespace
```

```yaml
repositories: ["gitlab:payments/api"]
repositorySources:
  - name: "gitlab:payments/api"
    url: "https://gitlab.corp/payments/api.git"
    cloneMode: static                            # recommended
    cloneSecret: gitlab-payments-read            # deploy token: keys username, token
    writerSecret: gitlab-kete-writer
    writerUsername: kete-bot
    # apiURL: https://corp.example/gitlab        # only for a relative URL root
publisher:
  caBundleSecret: corp-ca-publisher              # jobs namespace, key ca.crt (GitLab's / the proxy's CA)
  proxyAuthSecret: corp-proxy-publisher          # jobs namespace, key auth (username:password), with proxy.url
  egress: {cidrs: ["10.20.0.10/32"], ports: [3128]}   # the proxy, or GitLab's addresses on 443
proxy:
  noProxy: []                                    # e.g. [gitlab.corp] to reach GitLab directly
networkPolicy:
  repositories: {cidrs: [], ports: [443]}        # GitLab, when the controller reaches it directly
```

The controller and the publisher reach GitLab through `proxy.url` (the **controller's** proxy and
credential, never the jobs') unless the host is in `proxy.noProxy`; TLS is always verified (system
roots plus `caBundle` for the controller, plus `publisher.caBundleSecret` for publishers). URLs must
be `https`, without credentials; the project path comes from the clone URL.

### Protected branches

The publisher refuses to push (`base_unprotected`) unless **both the job's base branch and the
project's default branch are protected and the writer can't push to them** — GitLab's `can_push`
for the bot must be false. With a Developer bot the default protection ("Allowed to push:
Maintainers") is enough; if the bot is a Maintainer, set "Allowed to push and merge" to "No one" or
a group without it. A branch whose protection can't be read fails `protection_unknown`.

### GitLab CI and job branches

Job commits carry `[skip ci]` (unless `publisher.ciOnJobBranches`), which stops GitLab's branch
pipeline for the push. It does **not** stop merge request pipelines (`workflow:rules` on
`merge_request_event` when the draft MR opens), scheduled or manually triggered pipelines on the
branch, webhooks and integrations that act on every push or MR, or other CI systems watching the
project. The publisher refuses bundles that touch GitLab's CI configuration: `.gitlab-ci.yml`
(the validator), anything under `.gitlab/` and the project's custom `ci_config_path` when it is a
path in this repository (the publisher, stricter than the platform's validator). A job still
writes ordinary code that a later pipeline runs: protect your base branches and review the MR.

### What a publish does

When the job pod has exited and the platform's poll answer carries `publish.authorized: true` (the
platform accepted the job's `finish`; a job cancelled meanwhile is dropped and its outbox deleted,
never published), the controller deletes the job pod and starts `kete-publish-<machine>`. The
publisher, with nothing but its read-only mounts:

1. reads `manifest.json` (strict, this job, this repository and ref) and `bundle.tar.gz` (size and
   SHA-256 as the manifest says) from the outbox — all of it as hostile input;
2. validates the bundle with the Go port of the platform's validator (`internal/bundle`, held to
   the platform's own results on 226 bundles: `packages/kete-job-host/testdata/bundle-v1`):
   limits, tar entry types (no symlinks), protected and CI paths, case collisions, secret shapes;
3. checks that the job's recorded base commit is the commit the controller resolved for the job
   (the job clones exactly that commit) and is on the base branch, both branches' protection, and
   that the job branch `kete/job/<suffix>` doesn't exist (a branch already holding exactly this
   commit — a re-run — counts as published);
4. fetches the base commit's trees (git smart HTTP, protocol v2, `filter blob:none`, `deepen 1`) and
   refuses changes that collide with them (symlinks, submodules, case collisions, paths under files);
5. builds one commit whose only parent is the base (`[skip ci]` unless `publisher.ciOnJobBranches`,
   author `publisher.commitIdentity`) and pushes it with a single create-only command (old id zero:
   GitLab refuses it if the branch exists; never a force push);
6. opens a **draft** merge request (`Draft: Kete job <id>`, fixed text with a link to the job page)
   when the job asked for one and completed; an existing one is reused only if it is from and to
   this project, from the job branch into the base branch, a draft, opened by the writer;
7. writes its outcome — fixed codes only — as its termination message.

The controller reports the outcome on the machine (job-host-v2 `publish`: `created`, `no_changes`,
`refused` with `symlink`/`unreadable`/`bundle_invalid`/`base_unprotected`/`branch_exists`/
`push_rejected`, `failed` with `processes_alive`/`proxy_failed`/`provider_unavailable`/
`provider_error`/`protection_unknown`/`hold_expired`/`publisher_failed`), with the base and commit
SHAs and the merge request only when `boundary.publishRefs: send`, then deletes the publisher and
the outbox (a `failed` publish keeps the outbox until `jobs.outbox.holdHours` for inspection). A
machine whose authorization doesn't come within `jobs.outbox.holdHours` reports
`failed`/`hold_expired` and its outbox is deleted. Job pods never see the writer; publisher pods
never run repository code.

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

`.github/workflows/kete-runner.yml` runs all three on a two-node kind cluster with a local registry:

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
- `ci/e2e-publish.sh` (P3) installs a third release against a fake GitLab (REST API v4 and git smart
  HTTP through the real `git http-backend`, outside the cluster): a minted clone token checked,
  used and revoked at `clone_done`; a real job that exits into `publishing`, nothing pushed before
  the platform's go-ahead, then the publisher pod (its spec checked), a new branch on the base
  commit, a draft merge request and the outcome on the platform; refusals with outboxes rewritten
  as a compromised job could (two of the platform's bundle vectors, an unprotected base, an
  existing branch, a missing manifest) and a machine dropped while waiting; RBAC and admission
  around the writer Secret; no token in the controller's logs.

The `kete-test` RuntimeClass (runc) exists only in CI; only test builds of the runner and the
entrypoint accept it. GitHub's runners can't run Kata in kind, so CI proves the controller, the
pod, the entrypoint's control flow and the egress, not the VM boundary.
