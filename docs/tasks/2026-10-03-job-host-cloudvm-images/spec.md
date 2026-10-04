# Spec: Self-hosted job hosts P7: cloud-VM kernel and images, Packer in kete-code, docs

- Task: `docs/tasks/2026-10-03-job-host-cloudvm-images` · Size: large · Created: 2026-10-03
- Status: built (approved: user, 2026-10-03: design + build all)

## Goal
VM-per-job (B) backends (kete-code-platform ADR 0023 rules 14, 15, 18, 21) get bootable provider
images built by kete-code from a release: Kete's own cloudvm kernel (distribution cloud kernels
can't boot `kete-job-init`), the Packer template moved here from the platform repository with a CI
job, a local boot test, and one operator guide for every kind of self-hosted host.

## Scope
- `job-host` module, `kernel/`: a `cloudvm` variant of the 6.18 LTS build — `cloudvm.fragment` +
  `cloudvm-<arch>.fragment` merged over Firecracker's base and `kete.fragment` (so every microvm
  hardening term holds): EFI/EFI stub, GPT, ACPI/PCI, `IP_PNP_DHCP`, virtio-pci (legacy too)
  blk/scsi/net, `sd`, NVMe, gVNIC, RTCs, virtio-rng, 8250/PL011 consoles; ext4, overlayfs,
  nftables already built in; no modules. `config-cloudvm-{amd64,arm64}`, `check-config.sh
  --variant/--arch` (default: all four configs), `build.sh --variant cloudvm` (bzImage/Image,
  `.sha256`, `.config`), reproducible for both arches.
- `job-image` module: `packer/` — `cloudvm.pkr.hcl` (gcp, digitalocean, hetzner, oci; content from
  platform `infra/packer/cloudvm/`, reworked), `scripts/build-disk.sh` + `assemble-disk.sh` (cosign
  verify of the index digest, skopeo/umoci rootfs, refusals, GRUB BIOS+UEFI with built-in config,
  rootless partition assembly, manifest), `convert-disk.sh`, `oci-import.sh`; `test/boot-test.sh`
  (QEMU + dnsmasq + fake metadata service per provider, in one container).
- `job-entrypoint` module: found while booting the design on paper — the kernel's `ip=dhcp` can't
  install GCP's or Hetzner's off-link gateways (/32 leases), so `kete-job-init` gets its own DHCPv4
  client (`internal/dhcp`) selected by the image's command line (`kete.net=dhcp kete.dns=…`,
  `guestinit.ParseCmdline`); microvm unchanged (no `kete.net` → the kernel's `ip=`).
- CI: `kete-cloudvm-packer.yml` (PR: check-config, shell syntax, packer fmt/init/validate both
  arches), `kete-cloudvm-images.yml` (reusable + manual: cloudvm kernels, base disks, per-provider
  imports gated on image-builder credentials in the `cloudvm-images` environment), one
  `cloudvm-images` job in `kete-release.yml`, composite action `kete-cloudvm-setup`.
- Docs: `docs/job-hosts.md` (operator guide), READMEs (job-host "Guest kernel", job-image "Provider
  images (cloudvm)", entrypoint "kete-job-init"), cards, contracts, commands.

## Out of scope
- Real provider accounts and imports (U3; platform runbook R0-R9).
- Deleting the platform's `infra/packer/cloudvm/` and amending ADR 0023 rule 21 (platform repo:
  handoff).
- Growing `kete-scratch` to a larger provider disk; Secure Boot signing; OCI arm64 shape entries.

## Acceptance criteria
- [x] AC1: `check-config.sh` passes all four configs; cloudvm configs only add options to the
  microvm ones (diff); both cloudvm kernels build; arm64 rebuild is bit-identical.
- [x] AC2: `build-disk.sh` builds amd64 and arm64 disks (test rootfs) with the manifest; refuses an
  undigested image, a kernel not matching its `.sha256` or failing check-config, and images holding
  sshd/cloud-init/agents/systemd/authorized_keys/password hashes.
- [x] AC3: `boot-test.sh` passes arm64 (KVM) for gcp, hetzner, oci, digitalocean and amd64 (TCG)
  BIOS/hetzner and UEFI/gcp: init steps ok in order, entrypoint started and `setup_host` ok, one
  user-data request.
- [x] AC4: `internal/dhcp` and `ParseCmdline` unit tests (provider lease shapes, refusals, packets,
  netlink messages); entrypoint gofmt/vet/race and integration suite pass.
- [x] AC5: `packer fmt -check` and `packer validate` (both arches, all builds) pass; an undigested
  `job_image` fails validation; images carry `kete-job-image=<digest>` exactly as the adapters'
  `IMAGE_DIGEST_MARKER` / OCI `freeformTags.kete_job_image` expect.
- [x] AC6: actionlint passes on the new and changed workflows; lint, upstream:check, card-check pass.

## Risks and constraints
- Security: no change to ADR 0023's posture. The DHCP client parses network input as root before
  anything else runs: strict validation, bounded, no renewals; resolvers fixed by the image (public
  only). Images still contain no SSH/agent/cloud-init; the disk build verifies the signature before
  pulling. Image-builder credentials live only in a tag-restricted environment; the release passes
  no secrets to the reusable workflow.
- Contracts: new kernel parameters `kete.net`/`kete.dns` (image ↔ init) and the disk manifest
  `kete-cloudvm-disk v1` (build-disk ↔ Packer); both Kete-internal, recorded in `contracts.md`.
- ADR 0023 rule 21 says cloudvm uses "the distribution's cloud kernel": the wording amendment is
  proposed to the platform (handoff), not changed here.
