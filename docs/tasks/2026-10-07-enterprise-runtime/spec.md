# Spec: Phase 8 — Enterprise private runtime (Kubernetes runner first, interactive sessions after)

- Task: `docs/tasks/2026-10-07-enterprise-runtime` · Size: program (both repos) · Created: 2026-10-07
- Status: **approved** (maintainer, 2026-10-07: "use the colima vm and proceed"; open questions take the recommendations; ADR 0011 stays Proposed until spike S0 confirms VM-isolated pods) <!-- draft → approved → built → closed -->
- Decisions already taken by the maintainer (2026-10-07): D-M1 runner + interactive sessions designed
  together, runner built first; D-M2 first target is a Kubernetes Helm chart (EKS, AKS, GKE,
  OpenShift), VMs keep `kete-job-host`; D-M3 outbound HTTPS only, through enterprise proxies with
  custom CAs, air-gapped out of scope; D-M4 first Git platform is GitLab self-managed, credentials
  and source never pass through Kete.
- ADRs drafted with this spec: kete-code `docs/adr/0011-enterprise-private-runtime.md`,
  kete-code-platform `docs/adr/0025-enterprise-runtime-control-plane.md` (both Proposed).

## Goal
Let an enterprise run Kete Code's execution plane inside its own Kubernetes cluster: unattended
jobs triggered from the portal, API, Slack or Harness run in the enterprise's network against its
self-managed GitLab and its own model endpoints, and only operational metadata reaches Kete. The
same deployment later serves interactive sessions for developers' IDEs and CLI. Build the smallest
thing that reuses Phase 7 (cloud jobs, self-hosted job hosts, job mode) instead of a second stack.

## Reading guide (15–20 minutes)
§1 what exists and what we reuse · §2 the design in one picture · §3 data boundary · §4 runner on
Kubernetes · §5 GitLab · §6 model access · §7 policy and offline behaviour · §8 interactive sessions
· §9 security and threat model · §10 phased plan · §11 open questions · §12 risks, out of scope.
Appendices A–C (contract changes, Helm values sketch, Kubernetes objects) are skimmable.

---

## 1. Today (from the code, 2026-10-07) and what Phase 8 reuses

| Exists | Where | Phase 8 use |
|---|---|---|
| Job API v1: create, claim (single-use claim token), events/heartbeat, result, uploads, finish, clone-done; sweeper | platform `docs/jobs.md`, `docs/contracts/jobs-v1.md`, `apps/portal/lib/jobs/*` | **Reused unchanged** for lifecycle; additive `features` for runtime-side repos and runtime-side publishing (Appendix A) |
| Self-hosted host agent `kete-job-host`: enroll (single-use token, fingerprint approval), RFC 9421-signed poll, desired state, HPKE-sealed machine config, image digest allowlist + cosign verify, deadline killer that works offline, reconcile/orphan kill, `Driver` interface (`firecracker`, `dedicated`, fake) | kete-code `packages/kete-job-host`, platform ADR 0023, `docs/contracts/job-host-v1.md` | **The runner controller is `kete-job-host` with a new `kubernetes` driver.** Same contract, versioned additions |
| `selfhosted` backend over `job_host_machines`; hosts are Kete's only (ADR 0023 rule 3); one backend takes new jobs per environment (rule 1) | platform `apps/portal/lib/jobs/host/selfhosted`, `registry.ts` | Hosts gain an **owning organization**; enterprise jobs are routed by org, not by `KETE_JOB_HOST` (platform ADR 0025 amends rules 1 and 3) |
| Job entrypoint (Go, root): host profiles `fly`/`microvm`/`dedicated`/`cloudvm`, host-boundary probe, nftables + `kete-egress` proxy per phase, root helper (tool user), isolation probe, claim, hardened clone, pristine copy, safe bundle, uploads | `packages/kete-job-entrypoint`, `kete-egress`, `kete-root-helper`, `kete-job-image` | **Reused.** New profile `kubevm`, a local config file source, a local repository source, a local outbox instead of Kete Storage uploads |
| Job mode in `kete` (`KETE_JOB_MODE=1`): no project config/plugins, MCP off, **only the `kete` gateway provider**, request conformers on gateway routes, key via fd 3, audit sink fd | `packages/{util,core,server,cli}/src/kete/job-*` (card `job-mode`) | Extended: an **enterprise model allowlist** (private endpoints) under the same conformers; budget enforced locally |
| `RuntimeType` incl. `enterprise_private`, config `kete.runtime.type` / `KETE_RUNTIME_TYPE`; registration `PUT /api/v1/runtimes/{id}` (off in job mode) | `util/src/kete/runtime-registration.ts`, `schema/src/config/kete.ts` | Reported by session pods (P5); jobs keep registration off (the host identity is the registration) |
| Sync v1 (agents, skills, MCP, policies; cached; fail-closed guard when no cache; offline keeps cache) | card `sync`, `docs/platform/sync-v1.md` | Unchanged; jobs sync with the job key, sessions with a user-bound key (P5) |
| Repository seams: `JobRepoAccess` dispatch (`github`, `harness`), `FinishRepoProvider` (platform pushes from a validated hostile bundle, ADR 0021 rules 5–9) | platform `apps/portal/lib/jobs/repo-access/*`, `lib/jobs/push/*`, `lib/jobs/bundle` | A third provider kind, **`runtime`**: the platform holds a repo *name* only; prepare-clone, target checks, bundle validation, push and MR move into the runner (§5) |
| Harness step `run` mode: `kete job run` in the customer's pipeline with BYOK/`model_url` providers, pushes a new branch itself | `packages/kete-harness-plugin` | Precedent for enterprise-side Git and model credentials; its safe-publish git rules are reused by the publisher |
| Thin clients: CLI `--server <url>`; VS Code/JetBrains spawn a local `kete serve`; server password auth + `KeteLocalGuard` Host/Origin checks, `KETE_SERVER_ALLOWED_HOSTS` | `cli/src/commands/commands.ts`, `server/src/kete/local-guard.ts` | Interactive sessions (P5) connect to an in-cluster `kete serve` through a Kete session gateway |

**Hard constraint found in the code.** ADR 0023 rule 4 makes any container on a shared kernel —
Kubernetes pods included — unsupported, because the entrypoint needs real root in its own kernel
(nftables, cgroup v2, `/proc hidepid=2`, sysctls) and exits before `claim` otherwise. A plain `runc`
pod can't run a job safely. **This spec keeps that rule:** the Kubernetes driver runs each job in a
**VM-isolated pod** (a Kata Containers `RuntimeClass`: AKS Pod Sandboxing, OpenShift sandboxed
containers, Kata on EKS bare-metal or nested-virtualisation nodes, Kata on GKE nested-virtualisation
node pools). Whether the unchanged entrypoint runs in a Kata pod on each platform is the program's
biggest unknown, so it is spike S0, first (§10).

---

## 2. Design in one picture

```text
 Kete control plane (SaaS, Vercel + Supabase)                Enterprise network (outbound HTTPS only, via proxy)
 ┌───────────────────────────────────────┐                   ┌──────────────────────────────────────────────────────────┐
 │ portal / API / Slack / Harness        │                   │ namespace kete-system                                    │
 │   POST /api/v1/jobs (repo = name)     │  signed poll      │  kete-runner (kete-job-host, driver=kubernetes, 1 replica)│
 │ jobs, job_hosts (org-owned),          │◄──────────────────┤   enrolls, polls, opens sealed config, owns pods,        │
 │ job_host_machines, policies, sync     │  desired state    │   repo registry, deadline killer, reports phases+publish │
 │ sweeper                               ├──────────────────►│                                                          │
 │                                       │                   │ namespace kete-jobs (PSA privileged + admission policy)  │
 │ /api/v1/jobs/{id}/claim, events,      │◄──── claim ───────┤  job pod (RuntimeClass kata): kete-job image, profile    │
 │ result (summary per boundary), finish │◄──── heartbeats ──┤   kubevm; egress → enterprise proxy only; clones from    │
 │ /api/v1/sync (job key)                │◄──── sync ────────┤   GitLab (read token), models → private endpoint         │
 │ gateway (optional per org)            │◄ - - optional - - ┤   writes bundle + audit to per-job outbox volume         │
 └───────────────────────────────────────┘                   │  publisher pod (trusted code only): validates the        │
                                                             │   bundle as hostile, pushes create-only, opens draft MR  │
                                                             │                                                          │
                                                             │ GitLab self-managed · model endpoints · registries mirror │
                                                             │ enterprise logging / object store (audit sink)            │
                                                             └──────────────────────────────────────────────────────────┘
```

The platform never connects in (ADR 0018 rule 6, kete-code ADR 0006). Everything the enterprise
must keep — source, Git credentials, model keys and traffic, full audit logs, bundles, diffs —
stays right of the line.

---

## 3. Data boundary

**Principle: the runner enforces the boundary, the platform can only narrow it.** The settings come
from the runner's Helm values (the enterprise's configuration), not from the platform's sealed
configuration, so a compromised or misconfigured control plane can't widen what leaves. The org's
setting on the platform can make it stricter; the stricter wins (CLAUDE.md §5). The runner reports
its effective settings in every poll so the portal can show them.

| Data | Crosses to Kete? | Setting (default) |
|---|---|---|
| Job metadata: id, agent slug, model id, repo *name*, base ref, branch name, status, timings, exit code, outcome | yes (required to run the lifecycle) | — |
| Prompt | yes — jobs are created on the platform today (portal/API/Slack/Harness) | — (enterprise-side prompts: future) |
| Usage: tokens and cost per model, no content | yes | — |
| Phase lines (operations only, ADR 0023 rule 19) | yes | — |
| Result summary (`text`, ≤ 4 KB model output; may quote code) | configurable | `summary: none \| redacted \| full` (**none**) |
| Denials (action + first resource, may be a path or command) | configurable | `denials: count \| actions \| full` (**actions**: action names and counts, no resources) |
| MR URL / iid, commit SHA, base SHA | configurable | `publishRefs: omit \| send` (**send**: SHAs and the MR URL are needed for the job page; internal hostnames are visible) |
| Audit summary rows (`audit_events` milestones with the metadata above) | yes, within the settings above | — |
| Full audit JSONL, proxy log, bundle, diff, file contents, command output | **never** — to the enterprise sink only | `audit.sink: stdout \| s3 \| azureBlob \| gcs` |
| Git credentials, model keys, enterprise CA keys, Kubernetes credentials | **never** | — |
| Model traffic | **never**, when private endpoints are used | Kete gateway is opt-in per org **and** per runner (`models.gateway: false`) |

Downward (Kete → runtime): job spec, synced agents, skills, policies, job key, claim token. Skill
files are Kete-hosted content; the enterprise can restrict which skills an agent may carry through
existing agent management.

What changes in code: the entrypoint already forwards `result` verbatim (contract §6d); in the
`kubevm` profile it applies the runner's boundary settings to `text` and `denied` before sending,
and `uploads` is replaced by the outbox (§4.5). The platform accepts an empty `summary_text` and
denials without resources (additive; Appendix A).

---

## 4. Runner on Kubernetes

### 4.1 Components

| Component | What | Built from |
|---|---|---|
| Helm chart `kete-runner` | Namespaces, controller Deployment, RBAC, NetworkPolicies, admission policy, values schema | new `packages/kete-runner-chart/` (Kete-owned) |
| Controller | `kete-job-host` with `driver: kubernetes`, 1 replica + a `coordination.k8s.io` Lease (never two pollers on one key), runs non-root under PSA `restricted` | `packages/kete-job-host` + `internal/driver/kubernetes` |
| Job pod (one per job) | The released `kete-job` image by digest, entrypoint profile `kubevm`, `runtimeClassName` from an allowlist of VM-isolated classes | `kete-job-image`, `kete-job-entrypoint` |
| Per-job Secret | The opened machine config (claim token…), the repository entry (clone URL + read credential), model endpoint config + key, egress additions, boundary settings | written by the controller, owner-referenced to the pod, deleted when the pod reports running (like the config disk's unlink) |
| Per-job outbox volume | PVC (generic, `ReadWriteOnce`, small) that outlives the job pod; holds result, audit JSONL, proxy log, bundle | controller creates; deleted after publishing and sink shipping |
| Publisher pod (one per job with changes) | Runs trusted code only (`kete-job-host publish`): bundle validator, create-only push, draft MR, audit shipping. Mounts the outbox read-only and the GitLab writer credential; never runs repo code | same Go binary/image as the controller |

The controller keeps every `kete-job-host` rule that still applies: never listens for the platform,
never exposes an API to jobs, signed requests only, image allowlist + cosign, offline deadline
killer, destroy undesired/unknown machines. Machine state is **reconstructed from labelled
Kubernetes objects** (`kete.dev/machine-id`, `kete.dev/job-id`, `kete.dev/deadline`) instead of
`/var/lib/kete-job-host/state.json`; keys live in a Secret created by the enrollment Job.

Deliberate deviations for Kubernetes (recorded in ADR 0011): an optional metrics port (off by
default; NetworkPolicy to the monitoring namespace only); liveness/readiness by `exec` probe, no
port; clock check by `adjtimex` reading the node kernel's sync status (to verify in S0).

### 4.2 Per-job isolation (the decision that matters)

- **VM-isolated pods only.** The chart's values carry `jobs.runtimeClassNames` (e.g. `kata`,
  `kata-qemu`, `kata-cc`, AKS `kata-mshv-vm-isolation`, OpenShift `kata`). A
  `ValidatingAdmissionPolicy` in `kete-jobs` (Kubernetes ≥ 1.30) rejects any pod without one of
  them, with `hostNetwork`/`hostPID`/`hostIPC`, a `hostPath` volume, a service-account token, or an
  image not by digest. The controller also refuses to start if the configured RuntimeClass doesn't
  exist, and the entrypoint's `kubevm` profile refuses to claim unless it sees VM signals (virtio
  devices, a hypervisor DMI vendor, its own kernel distinct from the node's — exact signals fixed in
  S0) **and** the host-boundary probe passes.
- **Inside the pod, nothing changes:** root entrypoint, nftables default-deny, `kete-egress`, root
  helper, tool user, cgroups, isolation probe before `claim` — all as on Fly/Firecracker. The pod
  needs `NET_ADMIN`, `SYS_ADMIN`, `SETUID`, `SETGID`, `KILL`, `CHOWN`, `DAC_OVERRIDE` inside its
  guest (capabilities, not `privileged`, if Kata allows it; S0 decides). These are granted only in
  `kete-jobs`, and only because the kernel is the pod's own.
- **`kubevm` host-boundary targets:** the Kubernetes API (from the `KUBERNETES_SERVICE_*` values,
  read for the probe only), node IPs, sample pod and service CIDR addresses, cloud metadata
  (`169.254.169.254`, `fd00:ec2::254`), IPv6, the kubelet ports on the gateway. Any reachable →
  exit before `claim` (`host_boundary`).
- **Not supported:** `runc` pods (ADR 0023 rule 4 stands), gVisor (ADR 0023 rejected it: no nftables
  /cgroup control as the entrypoint needs). A `shared-kernel` mode exists **only** behind a
  test build flag for kind/k3d CI, refused by the release build (Q2).
- **Alternative driver, not v1:** KubeVirt (OpenShift Virtualization) running the existing
  `cloudvm`/`microvm` guest — a fallback if Kata proves unworkable somewhere (Q1).

### 4.3 Namespaces, RBAC, NetworkPolicy, secrets

- **`kete-system`** (PSA `restricted`): controller. ServiceAccount `kete-runner` with a **Role in
  `kete-jobs` only**: pods (create, delete, get, list, watch), pods/log (get —
  phase lines), secrets and persistentvolumeclaims (create, delete, get, list), events (list).
  Cluster-scoped: `get` on `runtimeclasses` (startup check). No `pods/exec`, no cluster-wide
  secrets, no nodes.
- **`kete-jobs`** (PSA `privileged` + the admission policy above): job pods only,
  ServiceAccount `kete-job` with no RBAC and `automountServiceAccountToken: false`,
  `enableServiceLinks: false`.
- **Publisher pods** run in `kete-jobs` too (same outbox PVC, same admission policy and Kata
  RuntimeClass, ServiceAccount `kete-publish` with no RBAC). The GitLab writer Secret exists in
  `kete-jobs` but the admission policy allows only pods labelled `kete.dev/role=publish` *and*
  running the runner image digest to mount it; job pods can't read Secrets through the API (no
  token) and can't create pods. (Considered: a separate restricted namespace for publishers —
  cleaner, but a PVC can't be shared across namespaces without re-binding volumes.)
- **NetworkPolicy** (default deny both ways in `kete-jobs`): job pods → cluster DNS, the enterprise
  proxy (or, without one, the allowlisted CIDRs/ports for platform, GitLab, model endpoints,
  registry mirrors); nothing else (no API server, no other namespaces). Publisher pods → GitLab and
  the audit sink only. Controller → proxy/platform and the API server. Ingress to all: none. The
  in-pod nftables + `kete-egress` remain the per-user boundary; NetworkPolicy is the outer one.
- **Secrets:** enterprise-held credentials are referenced, never created by the chart:
  `existingSecret` names for the GitLab writer token, read tokens, model keys, proxy credentials,
  CA bundle; works with External Secrets Operator or the Secrets Store CSI driver. The enrollment
  token is passed once through a Helm hook Job's stdin-equivalent (a Secret deleted after
  enrollment). The chart documents etcd encryption at rest as a prerequisite (per-job Secrets carry
  a claim token for minutes; ADR 0023 rule 14 precedent).

### 4.4 Mapping onto job-host-v1

The poll/desired-state/sealed-config protocol fits unchanged: a machine is a pod. Additions (all
contract changes, Appendix A; versioned as **job-host-v1 additive** where an old agent can ignore
them, otherwise **job-host-v2**):

1. `JobHostDriver` += `kubernetes`; facts: `runtime_class`, Kubernetes version, `reset: none`,
   slots up to **128** (today ≤ 32; ≤ 128 machines per report already).
2. `JobMachineConfig.host_profile` += `kubevm`.
3. Report `machines[].publish`: `{ status: created | no_changes | refused | failed, reason?, branch?,
   commit_sha?, base_sha?, mr?: { iid, url } }` (fields omitted per the boundary).
4. Report `repositories`: the repo names this runner serves (names only, opt-in), and `boundary`:
   the effective data-boundary settings; `images`: the job image digests in its allowlist (so the
   platform names one the runner accepts — today a single pinned `KETE_JOB_IMAGE` would break every
   runner on upgrade).
5. Run machine `repository: { name, base_ref }` so the controller can pick the registry entry and
   check it before starting a pod.
6. `JobHostStartsBlocked` += `cluster_unhealthy`, `runtime_class_missing`; machine reasons +=
   `pod_unschedulable`, `image_pull_failed`, `repository_unknown`.
7. Enrollment by **org admins** for org-owned hosts (platform side, ADR 0025): host row gains
   `organization_id`; poll/enroll wire shape unchanged except the token kind.

Recommendation: ship 1–6 as **job-host-v2** (new tag `kete-job-host-v2`, new Zod module, same
routes with a version field), because 3 changes when the platform may consider a job finished, and
keep v1 for Kete's own fleet. (Q3.)

### 4.5 Job flow in the cluster

1. Platform places a machine on an active host of the job's org (§7, ADR 0025) and seals the config.
2. Controller polls, checks image digest/allowlist/cosign (existing), opens the config, looks up
   `repository.name` in its registry (unknown → `failed repository_unknown`, job refused), mints or
   loads the read credential (§5), creates the outbox PVC, the per-job Secret and the pod.
3. Entrypoint (`kubevm`): setup, boundary probe, firewall, proxy, helper, isolation probe, `claim`
   (platform), clone from GitLab with the local credential, record `base_sha`, phase `clone_done`
   (the controller sees it in pod logs and revokes a minted token), `kete job run`, result to the
   platform (bounded by the boundary), bundle + audit + proxy log to the outbox, `finish` with
   `{ outbox: true }`.
4. Controller sees the pod exit, starts the publisher pod: validate the bundle as hostile (port of
   the platform's validator, same limits and test vectors), check base branch protection, build one
   commit on exactly `base_sha`, push `kete/job/<suffix>` create-only, open a draft MR for a
   succeeded job, ship audit + proxy log to the sink, report `publish` in the next poll.
5. Platform records `push_status` from the report and moves the job terminal; the sweeper's
   `finalizing` timeouts apply as today. Publishing waits for the platform's acknowledgement of
   `finish` (a job cancelled meanwhile is never pushed).

### 4.6 Images, upgrades, observability

- **Provenance:** the job image and the runner image are released by `kete-release.yml` as multi-arch
  indexes, cosign keyless-signed (ADR 0023 rule 17). The chart pins both **by digest**; the controller
  verifies the job image signature before creating a pod (existing `image.Sigstore`) and accepts
  mirrored images (`registry.internal/…@sha256:…`) as long as the digest and a mirrored signature
  (`cosign copy`) verify. Sigstore's TUF root is fetched through the proxy and cached (existing,
  one-day cache). Optional cluster-level enforcement (Sigstore policy-controller, Kyverno) documented.
- **Upgrades:** `helm upgrade` replaces the controller (Recreate strategy; running job pods are
  unaffected — they don't depend on the controller until publishing, which resumes after restart
  from the labelled objects). The platform's accepted-versions list (ADR 0023 rule 11) stops
  placing on outdated runners; a security fix ships within 7 days as today.
- **Observability:** controller logs as JSON to stdout (cluster logging), never a token or config;
  optional Prometheus metrics (jobs by state, poll latency, pod start time, publish outcomes);
  Kubernetes Events on the job pods; the full audit JSONL to the configured sink; the platform
  sees phase lines and outcomes only.

---

## 5. GitLab self-managed adapter

- **Repository registry (runner-side, Helm values):** entries keyed by a logical name,
  e.g. `gitlab:payments/api` → `{ url: https://gitlab.corp/payments/api.git, project_id,
  credentials: { writer: <secretRef>, clone: minted | <secretRef of a deploy token> },
  protectedBranches: required }`. The platform's `project_repositories` row stores
  `provider = 'runtime'`, `full_name = gitlab:payments/api`, and nothing else. A name the runner
  doesn't serve fails the job at placement (`repository_unknown`).
- **Clone credential (job pod, read-only):** default **minted per job**: a GitLab project access
  token, scope `read_repository`, expiring the next day (GitLab's granularity), revoked by the
  controller on `clone_done` and again on pod end (Harness precedent, ADR 0024). Fallback
  **static**: a read-only deploy token the enterprise rotates. Either way it reaches only the root
  entrypoint (heap, `http.extraHeader`), and the egress allowlist names the GitLab host only in the
  clone phase.
- **Writer credential (publisher + controller only, never the job pod):** a bot account's token with
  `api` + `write_repository` (Developer for push to non-protected branches; Maintainer only if
  minting project access tokens). Used for: resolving and checking `base_ref`, protection check
  (ADR 0021 rule 8 equivalent: base and default branch protected for push jobs), minting/revoking
  read tokens, the create-only push, the draft MR.
- **Push:** the publisher builds the commit in a fresh repo from the validated bundle on exactly
  `base_sha` (the Harness step's safe-publish rules: no repo config read, pinned `-c` keys, no hooks)
  and pushes with `--force-with-lease=refs/heads/<branch>:` (create-only). `[skip ci]` per the
  existing rule unless the org opted in.
- **MR and status:** draft MR `kete/job/<suffix>` → base, title from the job, description with the
  (local, unredacted) summary and a link to the portal job. Status reporting to Kete = the `publish`
  report fields allowed by the boundary. No GitLab webhooks (no inbound); triggers stay portal / API
  / Slack / Harness. Polling GitLab for MR comments as a trigger is future.
- **Platform `lib/jobs/repo-access` for `runtime` repos:** the dispatcher gets a `runtime` provider
  whose `checkTarget` only checks the name is advertised by an active runner of the org (or accepts
  any name when advertising is off), whose `prepareClone` returns "no clone" (the claim response
  omits `clone` and carries `repository: { provider: 'runtime', name }` under the feature
  `runtime_repo`), and whose `FinishRepoProvider` is replaced by recording the runner's `publish`
  report. GitHub and Harness are unchanged. Moves runtime-side: ref resolution, target checks,
  clone credentials, bundle validation, commit/push, PR/MR.
- **Seam for other providers:** `internal/repo` in the runner with a `Provider` interface
  (`ResolveRef`, `CheckProtected`, `CloneCredential`, `RevokeCloneCredential`, `Push`,
  `OpenChangeRequest`); GHES, Bitbucket DC, Azure DevOps are later implementations.

---

## 6. Model access

- Job mode today removes every non-`kete` model and only knows gateway routes
  (`core/src/kete/job-plugin.ts`, `job-request.ts`). For `enterprise_private` jobs, the runner
  supplies an **enterprise model allowlist** through the per-job Secret (never repository config,
  never the platform): provider id, protocol family, base URL, model ids, key reference, optional
  prices or token caps. Job mode admits exactly those models in addition to (or instead of) `kete`.
- First families: OpenAI-compatible chat/responses (vLLM, Ollama, LiteLLM-style internal gateways,
  Azure OpenAI with `api-key`), Anthropic Messages (Anthropic-compatible proxies). The existing
  conformers (no provider-side tools, inline content only, output clamp, one candidate) apply by
  family; the gateway-specific strict schemas don't. Bedrock (SigV4) and Vertex (Google
  credentials) come later or through the enterprise's own OpenAI/Anthropic-compatible proxy (Q6).
- Keys reach `kete` like the gateway key today: root entrypoint → pipe fd, never env; `kete` keeps
  them in memory. Endpoints are added to port A's allowlist for the agent phase only.
- **Budget:** without the gateway, the cap is the runtime's (`kete.budget.session`, required for
  unattended runs, ADR 0008), priced from the allowlist's prices or, without prices, a token cap.
  The platform's `cost_usd` cross-check against gateway spend doesn't apply; usage is reported as
  "reported by the runner".
- **Kete gateway:** optional; allowed only when both the org setting and the runner's
  `models.gateway` are on; the claim then mints the job key with gateway rights as today, else a
  job key that authorises sync only.

---

## 7. Policy, config, and the control plane being unreachable

- **Precedence** unchanged: platform → org → project → user → workspace, stricter wins for
  security. Jobs: org policies + agent rules + job spec, compiled on the platform (docs/jobs.md §5),
  applied by the runtime's unattended mode (ADR 0008). The runner adds **local ceilings** that the
  platform can't lift: allowed RuntimeClasses, egress allowlist, model allowlist, boundary settings,
  max job duration and resources, which repos exist. Interactive sessions: synced policies + the
  runner's ceilings, cached like today.
- **Reaching the runtime:** jobs via sync with the job key at start (existing `KeteJobSync.first`);
  runner-level settings via Helm values (the enterprise's GitOps); sessions via periodic sync.
- **Platform placement:** a project (or org default) gets an execution target `kete_cloud` |
  `enterprise_private` (+ optional runner pool label). Enterprise jobs go only to active hosts of the
  same org; Kete's fleet never receives them and an org-owned host never receives another org's job
  (ADR 0025).
- **Control plane unreachable:**
  - New jobs: none can arrive (pull). The controller keeps reporting when it can; nothing starts
    without a fresh desired state (fail closed).
  - Running jobs: continue within their deadline and budget, both enforced locally (deadline killer
    offline, runtime budget). Heartbeats fail; the platform's sweeper marks the job `lost` after 5
    min, so the runtime's late `result`/`finish` get 404 and the entrypoint stops (existing rule).
    **Recommendation (Q5):** keep this — no publishing without the platform's acknowledgement; a
    job lost to an outage is re-run, which is cheaper than designing offline reconciliation.
  - Publishing waiting on acknowledgement: outbox kept up to `publish.holdHours` (default 24), then
    deleted and reported.
  - Interactive sessions: keep working with the cached policy (existing); if no policy was ever
    loaded, the existing fail-closed guard (edit/shell/webfetch ask). Proposed: a `policyMaxAge` for
    `enterprise_private` (default 7 days) after which the guard applies too.

---

## 8. Interactive sessions (designed now, built in P5)

**Recommended: per-user session pods behind a Kete session gateway, reached through the
enterprise's own ingress or VPN.**

```text
IDE / kete CLI ──HTTPS (enterprise ingress/VPN, enterprise TLS)──► kete-session-gateway (kete-sessions ns)
     │  --server https://kete.corp/u/…     authenticates the developer (Kete identity, optional IdP)  │
     │                                     creates/looks up the user's session pod (KeteSession CR)    │
     └────────────── HTTP + SSE proxied ─────────────────────────────────────────────► session pod: kete serve
                                                                                       (one user, one DB, own PVC workspace)
```

- **Thin client unchanged:** clients already speak HTTP + SSE to `kete serve`; the CLI has
  `--server <url>`. VS Code and JetBrains need a "remote runtime" setting (URL + sign-in) instead of
  spawning a local `kete serve` — not built today (verified: the extension only reports a local
  server URL).
- **One runtime per user workspace** (keeps ADR 0005's single-owner database): a session pod runs
  `kete serve` in normal (not job) mode with `kete.runtime.type = enterprise_private`, a PVC
  workspace, the same image family, a Kata RuntimeClass (recommended: the user's tools run repo code),
  egress via NetworkPolicy + proxy, model allowlist as in §6. Idle pods scale to zero; the PVC stays.
- **Authentication (recommended, Q4):** the session gateway requires a **Kete identity** (the user's
  `kete login` key, verified through the platform's `/api/v1/me` and cached minutes) so org
  membership and RBAC stay in one place, behind the enterprise's network control (ingress
  allowlist/VPN, optionally their OIDC proxy). Enterprise IdP as the *only* identity comes when the
  platform has SSO (out of platform scope today). The gateway forwards to the pod with a per-pod
  server password (upstream auth) and sets `KETE_SERVER_ALLOWED_HOSTS`; the pod is reachable only
  from the gateway (NetworkPolicy).
- **Platform credential for a session pod:** a short-lived, user-bound session key minted by a new
  platform route the runner calls (signed with its host key, naming the verified user) — sync and
  registration then work as for a laptop. Contract addition in P5.
- **Git in sessions:** the developer's own GitLab identity (a GitLab OAuth application the
  enterprise registers; tokens kept in-cluster per user), so MRs are attributable and permissions are
  the user's. The job publisher's bot credential is not used for sessions.
- **Alternatives rejected:** (a) a **Kete-hosted relay** (runtime dials out, IDE connects to Kete):
  works with no enterprise ingress, but code, diffs and prompts would transit Kete (breaks §3) and
  Vercel can't hold long-lived connections; revisit only with end-to-end encryption for customers who
  accept it. (b) **IDE-local runtime with remote tools** (upstream `WorkspaceDriver`): incomplete
  upstream (ADR 0005) and puts the repository on laptops. (c) **one shared multi-user `kete serve`**:
  the server is single-user by design; isolation and audit would have to be rebuilt.

---

## 9. Security

### 9.1 Identity, tokens, least privilege

| Credential | Holder | Lifetime / rotation |
|---|---|---|
| Runner Ed25519 + X25519 keys | Secret in `kete-system`, controller only | until re-enrollment (rotation = re-enroll, existing) |
| Enrollment token | org admin → Helm hook Secret | single use, 1 h (existing), deleted after use |
| Claim token | per-job Secret → entrypoint heap | single use, ≤ 10 min to claim (existing); Secret deleted at `running` |
| Job key (sync; gateway only if enabled) | entrypoint → `kete` fd | until result/deadline (existing) |
| Callback token | entrypoint heap | deadline (existing) |
| GitLab read token | per-job Secret → entrypoint heap | minted per job, revoked at `clone_done`/pod end; or static deploy token rotated by the enterprise |
| GitLab writer token | enterprise Secret, controller + publisher pods | enterprise-rotated; never in a job pod |
| Model keys | enterprise Secret → per-job Secret → `kete` fd | enterprise-rotated |
| Session key (P5) | session pod | short-lived, user-bound, refreshed by the gateway |

### 9.2 Network
Outbound only. Every Kete component honours `HTTPS_PROXY`/`NO_PROXY` and a CA bundle
(`SSL_CERT_FILE`-style, plus Go's and Bun's trust stores); TLS verification is never disabled. The
in-pod `kete-egress` chains to the enterprise proxy with CONNECT and trusts the enterprise CA bundle
for upstream verification while keeping its per-pod CA toward `kete`/tools (contract change: egress
config v2 — upstream proxy, CA bundle, internal hosts and non-443 ports allowed by name/CIDR, which
today's private-range blocklist refuses). Egress allowlists per phase as today, plus enterprise
hosts.

### 9.3 Redaction and audit
Existing redactors apply (`KeteRedact`, the audit redactor, the platform's secret-shape rules for
anything that reaches it). The publisher adds GitLab token shapes (`glpat-`, `gldt-`) to redaction.
Audit: full JSONL + proxy log to the enterprise sink; milestones to the platform's `audit_events`
within the boundary; controller actions (pod create/delete, token mint/revoke, push, MR) logged as
structured JSON with `job_id`, `machine_id`, `request_id`, never a token.

### 9.4 Threat model

| Threat | What it reaches | Mitigation |
|---|---|---|
| **Compromised control plane** | can create jobs for registered repos, send prompts, place machines, issue claim tokens | runner checks platform origin, image digest allowlist + signature (no arbitrary code); boundary settings are local (can't exfiltrate source or widen data); only registry repos exist; writer token never leaves the runner; local ceilings on RuntimeClass, egress, models, duration. Residual: a malicious prompt can make the agent write bad code into an MR → draft MR + protected base + human review |
| **Compromised job pod** (tool escapes to root in the guest) | its own VM: claim/callback tokens, read token, model key, the repo | Kata VM boundary; NetworkPolicy outer egress; no SA token; short-lived job credentials; no write token; host-boundary probe proves isolation before claim. Residual: Kata/hypervisor escape (same class as Firecracker) |
| **Compromised controller** | runner keys, writer token, per-job Secrets in `kete-jobs` | non-root, restricted PSA, namespace-scoped Role, no exec; enterprise can scope the writer token to chosen projects; host revocation on the platform |
| **Malicious repository** (prompt injection, hostile files, git tricks) | agent behaviour within policy; bundle content | unattended fail-closed policy (ADR 0008); repo config ignored in job mode; hardened clone; bundle validated as hostile by the publisher (symlinks refused, limits, exact base); create-only push; draft MR |
| **Malicious MCP server** | — | no MCP in jobs (D12 unchanged). Sessions: MCP is a trust boundary (CLAUDE.md §9), only org-allowed servers, egress allowlist |
| **Insider (cluster admin)** | everything in the cluster, by definition | out of Kete's control; audit sink, Kubernetes audit logs; Kete never needs cluster-admin after install |
| **Insider at Kete** | job metadata, prompts, summaries per boundary | boundary defaults to minimum; no source, creds or model traffic ever reach Kete |
| **Network attacker / enterprise proxy MITM** | TLS via enterprise CA | signed, replay-protected requests; sealed configs; a proxy that sees plaintext sees only what crosses the boundary |
| **Stolen enrollment token** | could enroll a rogue runner | single use, 1 h, fingerprint approval by an org admin (existing) |

---

## 10. Phased build plan

Each piece is a separate PR in one repo, mergeable on its own, behind flags (`KETE_FLAG_ENTERPRISE_RUNTIME`
on the platform; the `kubernetes` driver and `kubevm` profile are inert until configured). Contracts
first. "Real infra" = needs accounts or hardware the maintainer must provide.

| # | Repo | Piece | Acceptance (summary) | Tested without customer infra | Needs real infra |
|---|---|---|---|---|---|
| **S0** | kete-code | **Spike: entrypoint in a Kata pod** (throwaway branch, findings doc only) | Unchanged entrypoint (dedicated-like config via file) passes setup, firewall, helper, isolation probe in a Kata pod; record required capabilities vs `privileged`, VM signals, secret-volume unmount, adjtimex | k3s + Kata on a KVM-capable VM or bare-metal box | yes: one KVM host; then AKS Pod Sandboxing, OpenShift sandboxed containers, EKS metal, GKE nested-virt (one each, short-lived) |
| **P0a** | both | ADR 0011 (kete-code), ADR 0025 (platform) accepted | maintainer approval | — | — |
| **P0b** | platform | `job-host-v2` contract + test vectors; jobs-v1 additive features `runtime_repo`, `runtime_publish`; egress config v2 doc | Zod schemas, standalone copies, vectors; consistency tests | unit tests | — |
| **P0c** | kete-code | contract copies + Go types (`internal/contract` v2), egress config v2 parser | vectors pass byte for byte | `go test` | — |
| **P1** | kete-code | Helm chart + controller with **fake driver** on Kubernetes: Lease, state from labels, Secret-held keys, non-root, proxy/CA support | `helm install` on kind; enroll against fake platform; poll; fake machines start/stop; orphan + deadline kill; chart lint + `kubeconform`; admission policy rejects runc pods | kind/k3d in CI (`kete-runner.yml`), fake platform (existing `fakeplatform`) | — |
| **P2** | kete-code | `kubernetes` driver + entrypoint `kubevm` profile + config-file source + outbox; egress upstream-proxy/CA | job pod lifecycle on kind (test-only shared-kernel build flag; CI defines a `kete-test` RuntimeClass mapped to runc, which only that build accepts) with the fake platform: claim → fake model → bundle in outbox; boundary probe codes unit-tested; release build refuses shared-kernel | kind in CI; fake model (existing e2e fixtures) | Kata acceptance run on the S0 host; one managed cluster |
| **P3** | kete-code | GitLab provider + publisher: registry, minted/static read tokens, revoke on `clone_done`, Go bundle validator (platform vectors), create-only push, draft MR, protection check | fake GitLab (HTTP API + git smart-HTTP via `git http-backend`) in CI; validator passes the platform's bundle vectors; push refuses existing branch; token never in logs (scan) | CI with fake GitLab | GitLab self-managed CE in a container (can be CI; real enterprise GitLab for acceptance) |
| **P4a** | platform | org-owned hosts: `job_hosts.organization_id`, RLS + org functions, `runtimes.manage` permission, enrollment by org admins, placement by org, per-org scoping of ADR 0022 rule 2 | pgTAP: org isolation; enterprise job never placed on Kete fleet or another org's host | local Supabase CI | — |
| **P4b** | platform | `runtime` repo provider, claim without clone, `publish` report → `push_status`, boundary-aware result/denial storage, execution target per project | route tests with fakes; existing GitHub/Harness tests unchanged | CI | — |
| **P4c** | platform | portal: Settings → Runtimes (create enrollment token, approve fingerprint, status, versions, slots, advertised repos, effective boundary), project execution target, job page labels ("reported by runner", omitted fields) | page tests | CI | staging |
| **P4d** | kete-code | job mode: enterprise model allowlist, direct families under the conformers, local budget; sync-only job key | core/cli Kete tests; e2e with fake OpenAI-compatible endpoint | CI | a vLLM/Azure OpenAI endpoint for acceptance |
| **P4e** | both | end-to-end: portal → runner on kind → fake GitLab → MR, against local platform | scripted e2e, documented | CI (nightly, kind) | staging + one managed cluster with Kata (pilot) |
| **P5** | both | interactive sessions: session gateway, `KeteSession` CRD, session pods, user-bound session key route, CLI `--server` sign-in, VS Code/JetBrains remote runtime | spec + plan of its own after P4e; kind e2e with fake IdP/platform | CI | pilot cluster |
| **P6** | both | docs/runbooks: install (EKS/AKS/GKE/OpenShift), proxy/CA, GitLab setup, data boundary, upgrades, incident response (revoke runner, rotate tokens), cards `kubernetes-runner`, `gitlab-provider` | reviewed by maintainer | — | pilot feedback |

Order: S0 ∥ P0 → P1 → P2 → P3 ∥ P4a–c → P4d → P4e → (pilot) → P5 → P6 (docs grow with each piece).
If S0 fails on a platform, P1 still holds (the controller is driver-agnostic); the fallback driver
for that platform is decided then (Q1).

---

## 11. Open questions (with recommendations)

1. **Q1 — Kata everywhere?** GKE offers gVisor (unsupported) natively; Kata needs nested-virt node
   pools there, and EKS needs metal or nested-virt instances. *Recommend:* require a VM-isolated
   RuntimeClass for v1 on all four; document per-platform setup; if S0 shows a platform can't run
   it, offer KubeVirt (OpenShift) or "use `kete-job-host` on VMs" for that platform rather than
   relaxing isolation.
2. **Q2 — Allow a shared-kernel (`runc`) mode for evaluation clusters?** *Recommend:* no in release
   builds (ADR 0023 rule 4); test-only flag for CI.
3. **Q3 — job-host-v2 vs additive v1?** *Recommend:* v2 for the runner (publish report changes job
   completion semantics); v1 stays for Kete's fleet.
4. **Q4 — Session identity:** Kete identity (recommended now) vs enterprise IdP (needs platform SSO).
   *Recommend:* Kete identity behind enterprise network controls for P5; add OIDC when platform SSO
   is scheduled.
5. **Q5 — Outage behaviour:** publish without platform acknowledgement? *Recommend:* no; jobs lost
   in an outage are re-run.
6. **Q6 — First model families:** *Recommend:* OpenAI-compatible (incl. Azure OpenAI) and Anthropic
   Messages first; Bedrock/Vertex native later.
7. **Q7 — Boundary defaults:** `summary: none`, `denials: actions`, `publishRefs: send`. *Recommend:*
   as listed; the portal shows "not shared by your runtime" where empty.
8. **Q8 — Clone credential default:** minted per-job project access token (needs Maintainer on the
   bot) vs static deploy token. *Recommend:* minted default, static allowed and labelled.
9. **Q9 — Billing/entitlement:** enterprise jobs on private models use no Kete credits. *Recommend:*
   gate by plan entitlement, record usage metadata, no credit debit; pricing is a business decision
   outside this spec.

## 12. Risks, out of scope, upstream

**Risks.** (1) Kata feasibility and capability set per managed platform (S0). (2) Duplicating the
security-critical bundle validator in Go — mitigated by the platform's test vectors as the shared
source of truth, as job-host-v1 does. (3) Enterprise proxies that break SSE or long polls
(controller polls are short; sessions use SSE through the enterprise's own ingress, not the
proxy). (4) Per-job Secrets put a claim token in etcd for minutes — etcd encryption is a stated
prerequisite. (5) Image mirroring breaking signature verification — documented `cosign copy`.
(6) Scope creep into a general Kubernetes operator — no CRDs until P5. (7) Platform ADR 0022 rule 2
(stop job creation while sweeps fail) must be scoped per org, or one enterprise's broken runner
stops everyone's jobs.

**Out of scope.** Air-gapped installs; GHES, Bitbucket DC, Azure DevOps (seam only); OpenShift SCC
tuning beyond a provided SCC for `kete-jobs`; multi-cluster and runner pools across clusters
(one runner = one host identity; several runners per org work but aren't load-balanced beyond the
platform's placement); enterprise-side prompts/triggers (GitLab webhooks, MR-comment polling);
enterprise VMs as org-owned `kete-job-host` hosts (falls out of P4a cheaply; a later task);
platform SSO; billing design.

**Upstream mergeability.** Everything lands in Kete-owned paths: `packages/kete-job-host`,
`kete-job-entrypoint`, `kete-egress`, `kete-job-image`, new `packages/kete-runner-chart`, and
`packages/*/src/kete/` for job mode. Expected upstream edits: none; if job mode's model filter needs
a hook it doesn't have, one marked line in `plugin/internal.ts`'s existing guarded block, recorded
in `docs/upstream-patches.md`. Client remote-runtime work is in Kete-owned extensions and the CLI's
existing `--server`.

---

## Appendix A — Contract changes (all need versioning)

| Contract | Change | Version |
|---|---|---|
| job-host (platform `packages/shared/src/api/v1/job-hosts.ts`, copy in both repos) | driver `kubernetes`; facts `runtime_class`, `kubernetes_version`; slots ≤ 128 for `kubernetes`; profile `kubevm`; run `repository {name, base_ref}`; report `publish`, `repositories`, `boundary`, `images`; new blocked reasons and machine reasons | **job-host-v2** (recommended) |
| jobs-v1 claim | request `features += runtime_repo, runtime_publish`; response may omit `clone` and carry `repository {provider:'runtime', name}`; `gateway_key` may be a sync-only job key | additive v1 (feature-negotiated, `clone_revoke_callback` precedent) |
| jobs-v1 result / finish | `text` may be empty, denial resources may be absent (boundary); finish `{ outbox: true }` (no uploads, no `push_error`) | additive v1 under `runtime_publish` |
| entrypoint machine config (`bootenv.Config`) | profile `kubevm`; `--config-file` source; local section (repository, clone credential, models, egress additions, boundary, outbox path) — local section never from the platform | in-repo contract v2 (contracts.md §6d) |
| egress config | upstream proxy (CONNECT), CA bundle, internal hosts/CIDRs and ports | egress config v2 (contracts.md §6c) |
| job mode ↔ entrypoint | model allowlist + key fds | in-repo (contracts.md §6) |
| sync / registration | none for jobs; P5 adds a user-bound session key route | P5 |

## Appendix B — Helm values sketch (illustrative)

```yaml
platform: { url: https://portal.kete.example }           # never hard-coded in the chart
proxy: { https: http://proxy.corp:3128, noProxy: [".svc", ".cluster.local", "gitlab.corp"], caBundleSecret: corp-ca }
images: { runner: registry.corp/kete/runner@sha256:…, job: registry.corp/kete/job@sha256:… }
jobs:
  runtimeClassNames: [kata]
  maxConcurrent: 16
  resources: { cpu: "4", memory: 4Gi, scratch: 20Gi }
  maxDurationMinutes: 120
repositories:
  - name: gitlab:payments/api
    url: https://gitlab.corp/payments/api.git
    projectId: 1234
    writerSecret: gitlab-kete-writer
    clone: minted                                        # or { deployTokenSecret: gitlab-payments-read }
models:
  gateway: false
  providers:
    - id: azure-openai
      family: openai-chat
      baseURL: https://corp-openai.openai.azure.com/openai/v1
      keySecret: azure-openai-key
      models: [{ id: gpt-5, priceInPerMTok: 1.25, priceOutPerMTok: 10 }]
boundary: { summary: none, denials: actions, publishRefs: send }
audit: { sink: stdout }                                  # or s3 / azureBlob / gcs with a secret
metrics: { enabled: false }
```

## Appendix C — Kubernetes objects per job

Pod `kete-job-<machine>` (RuntimeClass from the allowlist, image by digest, capabilities per S0,
`automountServiceAccountToken: false`, `enableServiceLinks: false`, requests = limits = job size,
`activeDeadlineSeconds` = deadline + 5 min as a second deadline killer), Secret
`kete-job-<machine>` (owner: pod; deleted at `running`), PVC `kete-outbox-<machine>` (owner: none;
deleted by the controller after publish/sink or `publish.holdHours`), Pod `kete-publish-<machine>`
(started after the job pod has terminated; Kata RuntimeClass like every pod in `kete-jobs`,
label `kete.dev/role=publish`, runner image by digest, writer Secret + outbox mounted read-only,
no capabilities). All labelled
`kete.dev/machine-id`, `kete.dev/job-id`, `kete.dev/deadline`; the controller's reconcile deletes
anything labelled that the desired state doesn't hold.

---

## S0 findings: binding amendments (2026-10-07)

Spike S0 ([s0-report.md](s0-report.md), artefacts in [s0/](s0/)) ran the released `kete-v0.2.5` job
entrypoint in a Kata 4.2 pod (k3s, arm64, nested KVM) with capabilities only, no `privileged`: every
pre-claim check passed and a no-agent job finished. Verdict: **proceed with the VM-isolated design**,
with these changes, which override the sections they touch:

1. **Capabilities (§4.2):** 10, not 7: add `SYS_RESOURCE`, `FOWNER`, `FSETID`; keep `KILL` until a
   timeout path is tested; add `NET_BIND_SERVICE` (or document the containerd
   `ip_unprivileged_port_start=0` dependency). The jobs namespace runs at Pod Security `privileged`,
   so the admission policy carries every rule.
2. **VM detection:** virtio/DMI signals are useless (a runc pod on a VM node looks the same; arm64
   Kata guests have no DMI). The entrypoint compares its boot ID with the node's: the controller
   reads `Node.status.nodeInfo.bootID` after scheduling and writes it into the job Secret (kubelet
   waits for the Secret); the controller needs `get nodes`. Mismatch required; equal → refuse
   `shared_kernel` **before any write**.
3. **`dedicated` profile gap (existing code):** today's `dedicated` profile has no shared-kernel
   check; a privileged runc pod ran a full job and changed a node sysctl. The boot-ID/shared-kernel
   guard must also protect `dedicated` (fix ahead of P2, as its own PR).
4. **Clock:** the Kata guest is never NTP-synced; offset stayed within ±0.3 s. Keep the `adjtimex`
   check in the controller (node); the entrypoint may compare with the platform's `Date` at claim.
5. **NetworkPolicy race:** policies can be enforced after a pod starts. Require a CNI that enforces
   before start (Calico/Cilium, verified per platform) **or** retry `host_boundary` for up to ~30 s
   (nothing secret exists before claim).

Also: `kubevm` remounts `/proc/sys` and `/sys/fs/cgroup` read-write itself (`setup_kubevm`); the
Secret volume unmounts inside the guest; `kubectl exec` into job pods fails once cgroups are set up
(no exec probes); guest memory needs explicit sizing (default 2 GiB) and the RuntimeClass overhead is
≈390 MB, not 160Mi; `enable_mem_prealloc` must stay off. **Not proven:** a real `kete` agent job to
completion inside Kata (k5 was cut off at 20 min under nested-virt slowdown) — rerun on non-nested
or x86 KVM before P2 acceptance; nothing ran on AKS/OpenShift/EKS/GKE or x86 yet.
