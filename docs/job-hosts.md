# Self-hosted cloud job hosts: operator guide

Cloud jobs run on Fly by default. kete-code-platform ADR 0023 adds hosts Kete operates itself.
This guide is the kete-code side for the people who run them: what each release publishes, how
to set up and upgrade each kind of host, and which document covers each step. The platform side
(enrollment, approval, backends, configuration) is in kete-code-platform; links below are to that
repository unless they start with `packages/` or `docs/` here.

Hosts are **Kete's only**, never a customer's: a host's operator can read the claim token and guest
memory of every job on it (ADR 0023 rules 3, 22).

## Which host

| Kind | ADR 0023 | Runs a job in | kete-code parts | Platform setup |
|---|---|---|---|---|
| **firecracker** (A) | rules 6, 7, 9-13 | a Firecracker microVM, many per server with KVM | `kete-job-host` agent, guest kernel (microvm), job image | `docs/integrations/selfhosted-jobs.md` |
| **dedicated** (A) | rule 8 | the server itself, one job per verified reset | `kete-job-host` agent (`--driver dedicated`), job image | not built on the platform yet (P5 platform side) |
| **cloudvm** (B) | rules 14, 18, 20, 21 | one provider VM per job (GCP, DigitalOcean, Hetzner, OCI) | provider images (`packages/kete-job-image/packer`), cloudvm kernel, `kete-job-init` | `docs/integrations/{gcp,digitalocean,hetzner,oci}-jobs.md` |

Every kind runs the same signed job image; inside it the entrypoint's host profile
(`microvm`, `dedicated`, `cloudvm`; `packages/kete-job-entrypoint/README.md` "Host profiles")
refuses to start on the wrong kind of host.

## What a release publishes

A `kete-v*` tag runs `.github/workflows/kete-release.yml` (`docs/release.md`):

| Artifact | Where | Used by |
|---|---|---|
| Job image index (linux/amd64 + linux/arm64), cosign keyless signature | `ghcr.io/kete-org/kete-job@sha256:<index>`; release asset `kete-job-image.digests` (index, per-arch digests, signing identity) | every host: `image_allowlist` (A), the image build (B), `KETE_JOB_IMAGE` (platform) |
| microvm guest kernels, `.sha256`, `.sigstore.json` | release assets `kete-guest-kernel-<release>-<arch>` | firecracker hosts: `firecracker.kernel`, `kernel_allowlist` |
| cloudvm provider images | the providers' image stores, built by `kete-cloudvm-images.yml` from the same index digest (needs each provider's image-builder credential) | the platform's `<PROVIDER>_JOBS_IMAGE` |

The signing identity is `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/<tag>`
with issuer `https://token.actions.githubusercontent.com`. To check by hand:

```sh
cosign verify --certificate-identity "https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-vX.Y.Z" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/kete-org/kete-job@sha256:<index>
cosign verify-blob --bundle kete-guest-kernel-<release>-amd64.sigstore.json --certificate-identity "…same…" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com kete-guest-kernel-<release>-amd64
```

The agent itself verifies the image's signature before every first use of a digest
(`packages/kete-job-host/README.md` "Security model"); the cloudvm image build verifies it before
pulling anything.

## Firecracker hosts

1. **Server.** Linux with `/dev/kvm`, cgroup v2, nftables, a public IPv4, outbound TCP 443, NTP,
   root; at least 8 vCPU / 16 GB for two slots (platform `selfhosted-jobs.md` "Adding a host"; ADR
   0023 rule 5 for which providers' machines qualify). Unattended security updates on the host OS.
2. **Install** (`packages/kete-job-host/README.md` "Installing a host"): `packaging/install.sh`
   with the agent, Firecracker and jailer (pinned versions, SHA-256), and the release's microvm
   kernel with its `sha256:` line. It never enrolls, starts anything or downloads.
3. **Configure** `/etc/kete-job-host/config.json` (README "Configuration"): `platform_url`,
   `driver: firecracker`, `slots`, `resolvers`, `image_allowlist` (the release's index line),
   `kernel_allowlist`, `versions`, the `firecracker` section.
4. **Enroll and approve**: a token from `/admin/job-hosts`, `kete-job-host enroll` (token on
   stdin), compare fingerprints, approve (platform `selfhosted-jobs.md` steps 1-4).
5. **Check**: `kete-job-host doctor`, then `systemctl enable --now kete-job-host`. The host page
   shows a fresh report, versions and slots.

**Each release:** add the new index digest to `image_allowlist` (keep the old one until the
platform's `KETE_JOB_IMAGE` moved), install the new kernel and add its digest to
`kernel_allowlist`, and restart the agent; then the platform accepts the new versions and drops the
old ones. A guest-kernel or Firecracker fix affecting isolation ships within 7 days (rule 21);
hosts that don't update stop receiving jobs once the platform drops the old versions.

## Dedicated hosts

The agent side is built (`packages/kete-job-host/README.md` "Dedicated driver", "Dedicated hosts":
`install.sh --driver dedicated`, R1 `provider_rebuild` resets, one job per generation). The
platform doesn't place jobs on dedicated hosts until its side (rebuild orchestration,
auto-approval, generation tracking) exists.

## VM-per-job (cloudvm) providers

No agent: the platform's adapter creates one VM per job from a Kete-built image and passes the
job's values as user data; `kete-job-init` (PID 1) configures the network with its own DHCP client,
reads the user data once, drops the metadata service for every user and starts the entrypoint
(`packages/kete-job-entrypoint/README.md` "kete-job-init").

1. **Provider project.** One dedicated project/team/compartment per provider with the deny-inbound
   firewall, no service account or role on VMs, a launcher credential for the portal and a
   separate **image-builder** credential for CI (platform `docs/integrations/<provider>-jobs.md`,
   "Setup"). Set a billing alert first.
2. **Images.** In this repository's GitHub settings, create the environment `cloudvm-images`
   (deployment tags `kete-v*` only) with that provider's image-builder secrets and variables
   (`packages/kete-job-image/README.md` "Provider images (cloudvm)", CI table). Each release then
   builds the images; for an existing release run `kete-cloudvm-images.yml` by hand from its tag
   with its index digest. Images record `kete-job-image=<index digest>`, which the adapters check
   before every create.
3. **Platform.** Set `<PROVIDER>_JOBS_IMAGE` (from the workflow's summary) and `KETE_JOB_IMAGE` to
   the same release in one deploy (platform `<provider>-jobs.md` "Platform configuration").
4. **Staging.** Platform `docs/runbooks/cloud-jobs-staging.md` §2.5 R0-R9 and the provider's
   checks, before turning the backend on in production.

**Each release:** the images build with the release (for every provider whose credential is
configured); move `<PROVIDER>_JOBS_IMAGE` and `KETE_JOB_IMAGE` together. Old images can be deleted
once no job uses them (providers bill image storage).

**The cloudvm kernel.** Kete builds it from the same pinned 6.18 LTS source as the microvm kernel
(`packages/kete-job-host/kernel/`, `--variant cloudvm`): the microvm configuration plus the
firmware, disk, NIC, clock and console drivers of the supported providers, all built in (no
initramfs, no modules). A distribution cloud kernel can't boot `kete-job-init`: it builds those
drivers as modules. A kernel fix ships the same way as for microvm, within 7 days, as new images.

**Before a provider goes live** (verified only under QEMU so far,
`packages/kete-job-image/packer/test/boot-test.sh`): its real DMI fields, user-data endpoint and
DHCP lease (DigitalOcean may not offer DHCP without cloud-init; then it can't be a cloudvm provider
as built), serial-console phase lines (GCP, OCI), Secure Boot off (GCP Shielded VM: unsigned GRUB
and kernel), and OCI arm64 shape compatibility.

## Incidents

- **A host is compromised or lost**: revoke it on `/admin/job-hosts`, then *Declare lost* so its
  jobs finish (platform `selfhosted-jobs.md` "Operating hosts"); rebuild the server before
  re-enrolling with a new token. A compromised firecracker host could read the claim tokens of jobs
  it ran; those are single-use and short-lived.
- **A signing or release problem** (a bad image or kernel): remove its digest from every host's
  allowlist and move the platform to the previous release; for cloudvm, point
  `<PROVIDER>_JOBS_IMAGE` back to the previous image.
- **A provider credential leaks**: rotate it at the provider; the launcher credential is portal
  configuration only, the image-builder credential only in the `cloudvm-images` environment.

## Where things are

| Topic | Document |
|---|---|
| Design and rules | platform `docs/adr/0023-self-hosted-job-hosts.md` |
| The agent (security model, configuration, drivers, install, tests) | `packages/kete-job-host/README.md` |
| Guest kernels (microvm, cloudvm) | `packages/kete-job-host/README.md` "Guest kernel"; `packages/kete-job-host/kernel/` |
| The job image and the provider images | `packages/kete-job-image/README.md` |
| `kete-job-init` and host profiles | `packages/kete-job-entrypoint/README.md` |
| Agent ↔ platform contract | `docs/platform/job-host-v1.md` (copy of platform `docs/contracts/job-host-v1.md`) |
| Platform setup per backend | platform `docs/integrations/selfhosted-jobs.md`, `{gcp,digitalocean,hetzner,oci}-jobs.md` |
| Staging and go-live | platform `docs/runbooks/cloud-jobs-staging.md` |
| Releases | `docs/release.md` |
