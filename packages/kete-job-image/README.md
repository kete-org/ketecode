# kete-job-image

The cloud job image (piece D of the container work; kete-code-platform `docs/jobs.md` §8 items
1-2, ADR 0019 rule 5). One container runs one job end to end: its root entrypoint
(`packages/kete-job-entrypoint`, the contract) sets up the machine, starts the egress proxy
(`packages/kete-egress`) and the root helper (`packages/kete-root-helper`), claims the job, clones,
runs `kete job run` with tools under the tool user, and reports. This package holds only the image
definition, its build and its end-to-end test, and the provider images built from it for
VM-per-job hosts ("Provider images (cloudvm)"); there is no Go or TypeScript code here.

| File | What |
|---|---|
| `Dockerfile` | the published image (built from a staged context, no build stage) |
| `gitconfig` | `/etc/gitconfig`: `safe.directory` for the job users' git |
| `test/Dockerfile.e2e` | the test layer: the image plus cargo, the fake platform and the asserter; never published |
| `scripts/build.sh` | compiles the Go binaries, stages the context, `docker build`s the image |
| `scripts/e2e.sh` | runs the image against the containerised fake platform and asserts the result |
| `packer/cloudvm.pkr.hcl` | the provider images (GCP, DigitalOcean, Hetzner, OCI) from a release's base disk |
| `packer/scripts/build-disk.sh`, `assemble-disk.sh` | the cloudvm base disk: signature check, root file system, GRUB, kernel, partitions |
| `packer/scripts/convert-disk.sh`, `oci-import.sh` | Packer's steps: manifest check and provider format; the OCI import |
| `packer/test/boot-test.sh`, `boot-test-inner.sh` | boots a disk under QEMU against a fake provider (DHCP, DMI, metadata service) |

## What is in the image

`debian:trixie-slim` pinned by digest, plus the distro's `git`, `ripgrep`, `nftables`,
`ca-certificates`, `nodejs`, `npm`, `python3`, `python3-venv` and `python3-pip` (D4; cargo only in
the test layer, for size). `/usr/local/bin/kete` (the Linux CLI), and
`/usr/local/libexec/kete/{kete-job-entrypoint,kete-job-init,kete-root-helper,kete-egress}`, all root
0755 (`kete-job-init` is PID 1 of self-hosted microvm and cloudvm guests, unused on Fly: the
entrypoint README's "kete-job-init"). The
users `kete`, `kete-tool` and `kete-proxy` and the group `kete-job` are created at build time and
verified by the entrypoint at boot (D5). Every setuid/setgid bit is stripped and a build step checks
none is left. OpenCode's `LICENSE` and Kete's `NOTICE` are in `/usr/share/doc/kete/`.
`ENTRYPOINT` is the entrypoint; there is no `USER` and no `CMD`. **No secret and no CA key is ever
in the image:** the proxy generates its CA per VM in memory, and every credential arrives after boot
(the entrypoint README's "Credentials").

A job can only use a model that is in the bundled models.dev snapshot of the `kete` it ships: the
entrypoint sets `KETE_DISABLE_MODELS_FETCH=1` and port A never allows models.dev, so a platform
agent pinned to a newer model fails the job. Hand that to the platform with each release.

## Build

No Go toolchain is needed on the host: the Go binaries are compiled in `golang:1.26-bookworm` with
the shared `kete-egress-gomod`/`kete-egress-gocache` volumes.

```sh
# 1. The Linux kete for the Docker host's architecture (Apple-silicon Colima: arm64).
(cd packages/cli && bun run build --target=kete-linux-arm64 --skip-web-ui)
# 2. The binaries, the staged context .build/ctx-<arch>/ and the image kete-job:local.
bash packages/kete-job-image/scripts/build.sh            # --arch amd64|arm64, --kete <path>, --tag, --no-image
```

`build.sh` uses a plain `docker build`, so `docker-buildx` isn't needed locally. The CLI build
runs `bun install` for the target's native packages, which may reorder `packages/cli/package.json`
(no content change); don't commit that.

## End-to-end test

```sh
bash packages/kete-job-image/scripts/e2e.sh kete-job:local                       # all scenarios
bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario no-agent   # fastest
```

Scenarios (one fake run and one job container each):

- `no-agent`: the spec names no agent. `kete job run` refuses (`refused`, 2) before any model
  request; the job still reports and finishes normally.
- `lifecycle` (AC1 with the real `kete`): claim, clone, the first sync with the gateway key (the
  synced agent and its skill), a scripted model that runs `id -un` through the shell tool (it must
  print `kete-tool`) and edits `README.md`, then (piece A3) has the tool user plant two symlinks
  into kete's home (`e2e-read` → `spec.json`, `e2e-write`), calls `read` and `write` through them
  (both must be refused, and the read result must hold nothing of the spec) and removes the links,
  heartbeats, result, uploads, finish. The bundle's
  manifest is exactly `[{"path":"README.md","mode":"100644"}]` with the edited file. Every model
  request carries the gateway key and the synced agent's `x-kete-agent-id`/`x-kete-agent-version`.
- `ac5` (AC5): the scripted model installs `is-number@7.0.0` with npm, `six==1.16.0` with pip in a
  venv, and fetches `itoa = "=1.0.11"` with cargo over the sparse index, all as the tool user
  through the proxy with its name-constrained CA. Needs network access (npm, PyPI, crates.io); a
  registry outage fails it, so retry once.

Every scenario also streams the stopped job container's `docker export` into a scan for the claim,
callback and clone tokens and the gateway key (`TestExportScan`); the exported filesystem is never
written to disk. The asserter (`packages/kete-job-entrypoint/internal/e2e`, build tag `e2e`) checks
the call order, the 60 s heartbeat rule, `kete_cgroup_extra` = 0, stdout phase lines only, no
contract error or credential leak recorded by the fake, the proxy log (agent-phase `kete` requests to
the platform and the gateway, no refused or failed `kete` request, no registry refusal) and the
audit log (`run ended` with the right reason, no credential; for `lifecycle`, an error `tool` line
for the refused `read`). The export scan also checks (piece A3) that kete's data dir holds no audit
log, that the refused write created nothing in kete's home, and that the entrypoint's root 0600
`/var/log/kete-job/kete.audit.jsonl` is byte-equal to the uploaded audit (empty when none was
uploaded).

How it runs (`scripts/e2e.sh`): a Docker network on the documentation range `198.51.100.0/24`
(Docker's bridge ranges are in the proxy's blocklist, and its embedded DNS is loopback, which the
proxy refuses). The fake (`packages/kete-job-entrypoint/cmd/kete-job-fake-platform`) runs from the
test image at `198.51.100.10`, serving `*.kete.test` over HTTPS with its own per-run test CA and DNS,
forwarding every other name to Docker's resolver. The job container runs the image's own
`ENTRYPOINT` as the **dedicated** host profile would (the entrypoint README's "Host profiles"):
`KETE_JOB_HOST_PROFILE=dedicated` and `--config-fd 0`, with the fake's `config.json` on stdin
(`docker run -i`: a pipe, so no token is in the host's argv or the container's environment),
`--privileged --cgroupns=private`, a bind-mounted `resolv.conf` naming the fake, and a bind-mounted
copy of the CA bundle with the fake's test CA appended (only the proxy verifies upstreams, with the
system roots). Since the entrypoint's host-boundary probe must find the host isolated, e2e.sh
installs a stand-in for the host agent's table on the Docker host (`inet kete_e2e_host`, from a
host-network container, removed on exit): every packet from the job container to the Docker host
itself is dropped, and forwarded traffic may reach only the fake and TCP 443 on public addresses
(private and special ranges dropped). The image's entrypoint sets `user.max_user_namespaces=0`, a host-wide value in
Colima's VM or on the CI runner; e2e.sh saves and restores it. State lands in
`.build/e2e-state/<scenario>/` (`E2E_STATE` to move it; `E2E_KEEP_LOGS=1` also copies the job's
`/var/log/kete-job`); it holds the test credentials (`tokens.json`, `config.json`, `job.env`), never
real ones.

CI: `.github/workflows/kete-job-image.yml` (path-filtered; linux-x64 kete, `build.sh --arch amd64`,
`e2e.sh`, the state minus the credentials as an artifact on failure). Release:
`.github/workflows/kete-release.yml`'s `image` job (`docs/release.md`): linux/amd64 (e2e) and
linux/arm64 (QEMU, smoke test) images, on tags pushed, joined into one index and signed with
cosign keyless signing; `build.sh` builds `--platform linux/<arch>`.

## Provider images (cloudvm)

kete-code-platform ADR 0023 rules 15, 18 and 21: a VM-per-job backend (B) boots one provider VM
per job from an image Kete builds from the release. Moved here from the platform's
`infra/packer/cloudvm/` reference template (P7), which had never run.

**What a disk is.** `packer/scripts/build-disk.sh` (Docker; cosign v3 on the host) builds one raw
GPT disk per architecture: (1) `cosign verify` of the job image's **index digest** against the
release identity (`kete-release.yml` on a `kete-v*` tag; CI narrows it to the exact tag) before
anything is pulled; (2) the cloudvm kernel (`packages/kete-job-host/kernel/build.sh --variant
cloudvm`) checked against its `.sha256` and its `.config` against `check-config.sh --variant
cloudvm`; (3) in the pinned Debian builder (container root, no privileges, no loop devices,
`assemble-disk.sh`): the image's linux/<arch> root file system by that digest (skopeo + umoci), with
`kete-job-init` and `nft` required; refused: an SSH server, cloud-init, any provider guest agent or
systemd at known paths, any file named like sshd, dropbear, cloud-init, `*guest-agent*`, `google_*`,
waagent or `authorized_keys` anywhere, `/etc/ssh` or `/etc/cloud`, and any account whose password
field isn't locked (`*`/`!`; empty or a hash refused; `/etc/passwd` only `x`); GRUB images with their
configuration built in (BIOS + UEFI on amd64, UEFI on arm64; no menu, no timeout, `halt` if the
kernel won't boot); and the partitions written into a sparse disk:

| # | GPT name | Content |
|---|---|---|
| 1 | `bios-boot` | GRUB's BIOS core image (amd64; boot.img in the protective MBR's code area) |
| 2 | `kete-efi` | FAT `KETE-EFI`: `EFI/BOOT/BOOTX64.EFI` or `BOOTAA64.EFI`, and `vmlinuz` |
| 3 | `kete-root` | the job image, ext4 without journal, mounted read-only |
| 4 | `kete-scratch` | empty ext4: kete-job-init's overlay upper layer (the rest of the disk) |

The kernel command line (in GRUB, not changeable from outside): `root=PARTLABEL=kete-root
rootfstype=ext4 ro rootwait init=/usr/local/libexec/kete/kete-job-init console=ttyS0,115200`
(arm64: also `console=ttyAMA0,115200`) `quiet panic=1 kete.net=dhcp kete.dns=<resolvers>`.
`quiet` keeps kernel messages from interleaving with the phase lines the GCP and OCI adapters read
from the serial console; `kete.net`/`kete.dns` are kete-job-init's (entrypoint README
"kete-job-init" step 3). Output: `kete-cloudvm-<arch>.raw` and `kete-cloudvm-<arch>.json`
(`format: "kete-cloudvm-disk v1"`, `test`, `job_image`, `job_image_digest`, `kernel_release`,
`kernel_sha256`, `cmdline`, `disk_gib`, `disk_sha256`). Layout and IDs are fixed (GUIDs, file
system UUIDs, hash seeds, FAT serial, timestamps from `SOURCE_DATE_EPOCH`); the disk is not checked
for bit-for-bit reproducibility.

**Provider images.** `packer/cloudvm.pkr.hcl` (Packer ≥ 1.11, plugins pinned exactly): per build,
`convert-disk.sh` refuses a test disk, another architecture or job image, or a disk whose SHA-256
no longer matches its manifest, then writes the provider's format. Every image records
`kete-job-image=<index digest>` where the platform's adapters check it before each create: the
description (GCP image, DigitalOcean custom image, Hetzner snapshot) or the free-form tag
`kete_job_image` (OCI). Image names: `kete-cloudvm-<arch>-<12 hex of the digest>`.

| Build | How | Architectures |
|---|---|---|
| `gcp` | tar.gz to the staging bucket, `googlecompute-import` (`UEFI_COMPATIBLE`, `VIRTIO_SCSI_MULTIQUEUE`, `GVNIC`) | amd64, arm64 |
| `digitalocean` | raw.gz through Spaces, `digitalocean-import`, distributed to `do_regions` | amd64 |
| `hetzner` | a temporary server in the rescue system (Packer's SSH is with the rescue system only), the disk written over its root disk, snapshot | amd64 (`cx22`), arm64 (`cax11`) |
| `oci` | QCOW2 to Object Storage, `oci compute image import` (paravirtualized), free-form tag | amd64, arm64 |

**CI.** `.github/workflows/kete-cloudvm-packer.yml` (pull requests, path-filtered): kernel
configurations, shell syntax, `packer fmt -check`, `packer init` and `packer validate` of every
build for both architectures with placeholders. `.github/workflows/kete-cloudvm-images.yml`
(called by `kete-release.yml`'s `cloudvm-images` job on tags, or run by hand from a tag with the
release's index digest): the cloudvm kernels, both base disks (signature checked against that
tag), then one job per provider, on `kete-v*` refs only, in the `cloudvm-images` environment
(restrict its deployment rule to the tag pattern `kete-v*`; each credential is in the env of only
the configured-check and import steps) that imports only when that provider's **image-builder** credential is there (never the
platform's launcher credential) and otherwise says so and does nothing:

| Provider | Secrets | Variables |
|---|---|---|
| GCP | `GCP_IMAGE_BUILDER_KEY` (service-account JSON) | `GCP_IMAGE_PROJECT`, `GCP_IMAGE_BUCKET` |
| DigitalOcean | `DO_IMAGE_BUILDER_TOKEN`, `DO_SPACES_ACCESS_KEY`, `DO_SPACES_SECRET_KEY` | `DO_SPACES_BUCKET`, `DO_SPACES_REGION`, `DO_IMAGE_REGIONS` (JSON list) |
| Hetzner | `HCLOUD_IMAGE_BUILDER_TOKEN` | `HCLOUD_IMAGE_LOCATION` (optional, `fsn1`) |
| OCI | `OCI_IMAGE_BUILDER_USER`, `_TENANCY`, `_FINGERPRINT`, `_KEY` | `OCI_IMAGE_REGION`, `OCI_IMAGE_COMPARTMENT`, `OCI_IMAGE_NAMESPACE`, `OCI_IMAGE_BUCKET` |

The job summary lists each image id with the digest: set the platform's `<PROVIDER>_JOBS_IMAGE`
and `KETE_JOB_IMAGE` together in one deploy (platform `docs/integrations/<provider>-jobs.md`).

**Local runs** (no Packer needed for the disk or the boot test):

```sh
# The cloudvm kernel for the Docker host's architecture (about 5 min on Apple silicon).
packages/kete-job-host/kernel/build.sh arm64 --variant cloudvm --out packages/kete-job-host/kernel/dist
# A test disk: a root file system tar with kete-job-init, kete-job-entrypoint and nft at their paths.
bash packages/kete-job-image/packer/scripts/build-disk.sh --arch arm64 --test-rootfs-tar <rootfs.tar> \
  --kernel-dir packages/kete-job-host/kernel/dist --out packages/kete-job-image/.build/disk --disk-gib 8
# Boot it on a Docker host with /dev/kvm (Colima profile kvmtest; the default context is unchanged).
DOCKER_CONTEXT=colima-kvmtest bash packages/kete-job-image/packer/test/boot-test.sh \
  --disk packages/kete-job-image/.build/disk/kete-cloudvm-arm64.raw --arch arm64 --provider gcp
# Validate the template (Docker).
docker run --rm --entrypoint sh -e HCLOUD_TOKEN=x -e DIGITALOCEAN_TOKEN=x -e DIGITALOCEAN_SPACES_ACCESS_KEY=x \
  -e DIGITALOCEAN_SPACES_SECRET_KEY=x -v "$PWD/packages/kete-job-image/packer:/src:ro" hashicorp/packer:1.16.1 -c \
  'cp -r /src /w && cd /w && packer init . && mkdir -p output && : > output/disk.raw.xz && packer validate \
   -var job_image=ghcr.io/kete-org/kete-job@sha256:$(printf "a%.0s" $(seq 64)) -var disk_dir=/x \
   -var gcp_project=p -var gcp_bucket=b -var do_spaces_bucket=s -var "do_regions=[\"lon1\"]" .'
```

`boot-test.sh` runs QEMU, dnsmasq and a fake metadata service inside one container (its own
network namespace; `/dev/kvm` and `/dev/net/tun` passed in): `--provider` sets the DMI fields, the
disk bus, the user-data endpoint and the lease's shape (gcp: /32 + option 121; hetzner: /32 +
off-link router 172.31.1.1; oci and digitalocean: a /24), `--firmware bios` boots an amd64 disk
through SeaBIOS (TCG on an arm64 host: about 2 minutes). It passes when the serial log shows
`init_root`, `init_mount`, `init_network`, `init_config`, `init_metadata_drop` ok,
`init_entrypoint` start and the entrypoint's `boot` and `setup_host`, in order, with exactly one
user-data request. A test root file system without the image's users then fails at `setup_users`,
which is expected.

**Not verified here** (kete-code-platform runbook `cloud-jobs-staging.md` R0-R2): a real import and
boot per provider; whether each provider's DHCP server behaves like the boot test's (DigitalOcean
in particular: its Droplets may rely on cloud-init's metadata network configuration and not offer
DHCP at all); GCP Secure Boot (the GRUB and kernel are unsigned: keep Shielded VM Secure Boot off);
the OCI arm64 shape-compatibility entries; growing `kete-scratch` to a provider disk larger than
`--disk-gib` (it stays at the built size).

## Disk

The image is about 1 GB on disk and the test layer about 1 GB more (cargo). Locally, build only the
host architecture; `e2e.sh` removes its containers and network on exit and keeps one tagged test
image (`kete-job-e2e:local`). If a build fails for space, remove images you built
(`docker image rm kete-job-e2e:local kete-job:local`), prune dangling images and the builder cache
you created, and on Colima run `colima ssh -- sudo fstrim -a`. Keep the Go cache volumes: they
save minutes.

## Not verified here

Everything the entrypoint README lists under "Not verified without a real host" and "Not verified
without a real Fly machine", the GHCR pull by digest from Fly, and whether Fly starts a machine
from the multi-arch index digest (until confirmed, Fly keeps pinning the linux/amd64 digest).
