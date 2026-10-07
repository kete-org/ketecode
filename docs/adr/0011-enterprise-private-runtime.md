# 0011. Enterprise private runtime: a Kubernetes runner built on the job host agent

- **Status:** Proposed
- **Date:** 2026-10-07

## Context

Phase 8 (`docs/architecture.md` §8, §11, §64, §102) runs Kete Code's execution plane inside an
enterprise's own infrastructure. The maintainer decided on 2026-10-07: design the unattended runner
and interactive remote sessions together and build the runner first; the first target is a
Kubernetes Helm chart (EKS, AKS, GKE, OpenShift), with VMs keeping the existing self-hosted job host
agent; connectivity is outbound HTTPS only, through enterprise proxies with custom CA bundles
(air-gapped is out of scope); the first internal Git platform is GitLab self-managed, and source code
and Git credentials never pass through Kete.

Phase 7 already built most of an unattended runtime: the job entrypoint, egress proxy, root helper
and job image (ADR 0005: the runtime runs whole inside the sandbox), job mode in `kete`, the pull
model with signed polling (ADR 0006), job-scoped credentials (ADR 0007), fail-closed unattended
policy (ADR 0008), and the self-hosted host agent `kete-job-host` (platform ADR 0023) with
enrollment, RFC 9421-signed polls, HPKE-sealed machine configuration, an image digest allowlist with
cosign verification, an offline deadline killer and a `Driver` interface.

Two facts from the code constrain the design:

- The entrypoint needs real root in its own kernel (nftables, cgroup v2, `/proc` `hidepid=2`,
  sysctls) and exits before `claim` without it. Platform ADR 0023 rule 4 therefore rejects any
  container on a shared kernel, Kubernetes pods included.
- Job mode admits only the `kete` gateway provider, and the platform pushes the job's branch from an
  uploaded, validated bundle (platform ADR 0021). Both assume Kete can see the model traffic and the
  change. An enterprise runtime may allow neither.

Design and plan: `docs/tasks/2026-10-07-enterprise-runtime/spec.md`. Control-plane side: platform
ADR 0025.

## Decision

1. **The runner is `kete-job-host` with a `kubernetes` driver**, deployed by a Kete-owned Helm chart
   (`packages/kete-runner-chart`). One controller replica per host identity, guarded by a Kubernetes
   Lease; machine state is reconstructed from labelled Kubernetes objects; keys live in a Secret.
   Enrollment, signed polling, desired state, sealed configuration, image allowlist and signature,
   offline deadline killer and orphan reconciliation are reused, not rewritten. No second job
   system, no general-purpose Kubernetes operator: no CRDs until interactive sessions need one.
2. **One job, one VM-isolated pod.** A job runs in a pod whose `RuntimeClass` is on an allowlist of
   VM-isolated classes (Kata Containers and the managed equivalents). The chart installs an admission
   policy that rejects any other pod in the job namespace. Shared-kernel (`runc`) and gVisor pods
   remain unsupported, as ADR 0023 rule 4 says; a shared-kernel mode exists only in a test build for
   kind/k3d CI. Inside the pod the entrypoint, egress proxy, root helper, tool user and isolation
   probe work as on Fly and Firecracker, under a new host profile `kubevm` with a host-boundary probe
   for cluster networks (API server, nodes, pod/service CIDRs, metadata, IPv6).
3. **Enterprise credentials stay in the enterprise, and no write credential enters a job pod.**
   Repositories are registered in the runner by logical name; the platform stores only that name.
   The job pod gets a read-only Git credential (minted per job and revoked after the clone where the
   provider allows it). A separate publisher pod runs only Kete's own code: it validates the change
   bundle as hostile (a Go port of the platform's validator, held to the platform's test vectors),
   pushes create-only onto exactly the base commit and opens a draft merge request with a writer
   credential that only the controller and publisher can mount. ADR 0021's security model is kept;
   only where it runs changes. GitLab self-managed is the first `internal/repo` provider; other Git
   platforms are later implementations of the same interface.
4. **The runner enforces the data boundary.** What may leave — the result summary, denial details,
   merge request references — is set in the runner's configuration and applied before anything is
   sent; the platform can narrow it, never widen it. Source, diffs, bundles, full audit logs, proxy
   logs, Git credentials, model keys and (with private endpoints) model traffic never leave. Full
   audit logs go to an enterprise sink.
5. **Job mode gains an enterprise model allowlist** supplied by the runner (never by repository
   configuration or the platform): OpenAI-compatible (including Azure OpenAI) and Anthropic Messages
   endpoints first, under the existing request conformers (no provider-side tools, inline content,
   output clamp), with keys passed by descriptor and the budget enforced by the runtime. The Kete
   gateway is optional and needs both the organization and the runner to allow it.
6. **Outbound only, proxy- and CA-aware.** Every component honours the enterprise proxy and CA
   bundle; TLS verification is never disabled. The egress proxy gains an upstream proxy (CONNECT), a
   CA bundle and named internal hosts (egress config v2). The controller never listens for the
   platform; its optional metrics port is off by default and limited by NetworkPolicy.
7. **Interactive sessions use the same deployment, later:** one `kete serve` per user workspace in a
   session pod, reached through the enterprise's own ingress or VPN via a Kete session gateway that
   requires a Kete identity. Clients stay thin (HTTP + SSE, `--server`). A Kete-hosted relay is
   rejected while it would carry code through Kete.
8. **Contracts are versioned:** job-host-v2 for the runner's additions (driver, profile, publish
   report, repositories, boundary, image list), feature-negotiated additions to jobs v1, egress
   config v2 and the entrypoint configuration v2. Kete's own fleet keeps job-host-v1.

## Consequences

- The program starts with a spike: running the unchanged entrypoint in a Kata pod on each managed
  platform. If a platform can't, that platform gets a different VM-isolated driver (KubeVirt) or the
  VM-based host agent — never relaxed isolation.
- Enterprises must provide a VM-isolated RuntimeClass, etcd encryption at rest (per-job Secrets hold
  a claim token for minutes), and a Git bot account; the chart documents each prerequisite.
- The bundle validator exists in two languages; the platform's test vectors are the shared source of
  truth and a change to them is a contract change.
- The platform no longer sees enterprise diffs or full audit logs; the portal shows what the runner
  shares and labels it as reported by the runner.
- All code lands in Kete-owned paths (`packages/kete-*`, `packages/*/src/kete/`); upstream OpenCode
  files are not expected to change.
- Revisit air-gapped operation, other Git providers, multi-cluster runners and enterprise-side
  triggers when a customer needs them.
