# Handoff: Self-hosted job hosts P7: cloud-VM kernel and images, Packer in kete-code, docs

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-04 build agent (coordinator-delegated)

Done: everything in spec.md scope; checks in result.md. Not committed (as instructed). The other
agent's CLI-distribution work in `kete-release.yml` is untouched: this task adds only the
`cloudvm-images` job (before `publish`) and three header comment lines; everything else is in new
files.

Decisions:
- **D1 Kete's own cloudvm kernel**, not a distribution kernel (P6 handoff): same 6.18.55 source,
  pins and builder as microvm; `config-cloudvm-<arch>` = Firecracker base + `kete.fragment` +
  `cloudvm.fragment` + `cloudvm-<arch>.fragment`, so it only **adds** options to the microvm
  configuration (verified by diff: no hardening option changes). Drivers for GCP (virtio-scsi,
  NVMe, virtio-net legacy+modern, gVNIC), DigitalOcean (virtio-blk), Hetzner (virtio-scsi), OCI
  paravirtualized (virtio-scsi/blk, virtio-net; no iSCSI). arm64 rebuilt bit-identical.
- **D2 kete-job-init gets its own DHCP client** (`internal/dhcp`), selected by the image's kernel
  command line (`kete.net=dhcp kete.dns=…`). Reading the kernel's `net/ipv4/ipconfig.c`:
  `ic_setup_routes` refuses a gateway outside the leased subnet ("Gateway not on directly connected
  network"), which is exactly what GCP (/32 + option 121) and Hetzner (/32 + off-link 172.31.1.1)
  lease, and `/proc/net/pnp` doesn't carry the gateway, so init couldn't repair it. Strict
  validation, packet socket, netlink, no renewal; resolvers only from `kete.dns` (public IPv4).
  microvm unchanged. Not a security-posture change (rule 15 says "DHCP on a cloud VM"); it is new
  root code parsing network input before anything else runs, so it's bounded and unit-tested.
- **D3 Disk layout kept from the platform's reference** (rule 15: read-only image + scratch overlay):
  GPT 1 bios-boot, 2 ESP (GRUB + kernel; the root file system stays exactly the image), 3
  `kete-root` ext4 read-only (no journal), 4 `kete-scratch`. `root=PARTLABEL=kete-root` (no
  initramfs: `root=LABEL=` doesn't exist without one). Scratch discovery already scanned
  `/sys/class/block` (partitions included): no change needed.
- **D4 Rootless, loop-free disk build** in the pinned Debian builder (skopeo + umoci by digest,
  mkfs.ext4 -d, mkfs.fat + mtools, grub-mkimage with the configuration built in, the BIOS boot
  sector patched as grub-bios-setup does). Runs the same on a CI runner, Docker Desktop/Colima and
  kvmtest. cosign verification stays on the host, before anything is pulled; CI pins the identity to
  the exact tag.
- **D5 `quiet` on the cloudvm command line**: without it the boot backlog on the slow serial console
  interleaved with init's phase lines mid-line (seen in the first boot test), which would break the
  GCP/OCI adapters' phase-line parsing (rule 19).
- **D6 CI split**: PR checks in `kete-cloudvm-packer.yml`; release builds in the reusable
  `kete-cloudvm-images.yml` (also manual, from a tag) called by one job in `kete-release.yml`; no
  secrets passed from the release — provider jobs read image-builder credentials from the
  `cloudvm-images` environment and skip with a notice when absent. `publish` doesn't wait for it.
- **D7 Images per architecture** (`kete-cloudvm-<arch>-<12 hex>`): the platform pins one image id
  per provider, so the arch must match the configured machine type. DigitalOcean amd64 only.

Open items / follow-ups:
- **Platform (plat) — remove the old template**: delete `infra/packer/cloudvm/` (content now in
  `packages/kete-job-image/packer/`, reworked); update `docs/integrations/{gcp,digitalocean,hetzner,oci}-jobs.md`
  "Image build" to point at kete-code's template, `kete-cloudvm-images.yml`, the `cloudvm-images`
  environment's secret/variable names (job-image README table) and the new image names; gcp-jobs.md's
  line about `build-disk.sh` checking `IP_PNP_DHCP` (the kernel is now Kete's; DHCP is init's own);
  runbook §2.5 R0 "Build it with `infra/packer/cloudvm/`" → kete-code's workflow, and mention
  `boot-test.sh` as the pre-check; plan-overview P6/P7 status.
- **Platform — ADR 0023 amendment (proposed wording)**. Rule 21, replace "`cloudvm` images use the
  distribution's cloud kernel, rebuilt by the Packer job on the same terms." with: "`cloudvm` images
  use Kete's cloudvm kernel: the same pinned Linux LTS and reproducible build as the microvm kernel,
  its checked-in configuration plus the firmware, disk, network, clock and console drivers of the
  supported providers, all built in (no initramfs, no loadable modules — `kete-job-init` has no module
  loader, so a distribution cloud kernel, which builds these as modules, can't boot it). It goes only
  into the provider images; a kernel security fix affecting guest isolation ships as new provider
  images within 7 days, and the platform then moves each `<PROVIDER>_JOBS_IMAGE`." Rule 18: "the
  guest kernel of the provider's choice for `cloudvm` (rule 21)" → "Kete's cloudvm kernel (rule
  21)". Rule 15 (optional precision): "DHCP on a cloud VM" → "DHCP by its own client on a cloud VM
  (the kernel's can't install the off-link gateways GCP and Hetzner lease)".
- **Platform — GCP adapter**: `nicType: 'VIRTIO_NET'` can't run on machine types that require gVNIC
  (C3/C4/N4, every Axion arm64 type); the image declares `GVNIC` and the kernel has it, so the
  adapter (or its configuration) must pick `GVNIC` there. Keep Shielded VM Secure Boot off (GRUB and
  kernel are unsigned; the adapter doesn't set it today).
- **Real providers (U3, runbook R0-R2)**: DigitalOcean's DHCP is the biggest unknown — if Droplets
  without cloud-init get no DHCP lease, DigitalOcean can't be a cloudvm provider as built (it would
  need init to read the network from DO's metadata over a link-local address first: a design
  change). Also confirm Hetzner's `snapshot_name` lands in the snapshot description, OCI arm64 shape
  compatibility (and UEFI firmware) for the imported image, GCP arm64 serial console device
  (ttyAMA0 assumed; ttyS0 also listed), and the P1 tables (DMI, user-data endpoints) on real VMs.
- **Not re-run**: the firecracker KVM acceptance tests (P4) — `Machine.Network` now reads
  `/proc/cmdline` first on microvm too (no `kete.net` → unchanged path); unit and integration tests
  pass, but no Firecracker boot was staged this time.
- `kete-scratch` doesn't grow to a provider disk larger than the built 20 GiB; GCP/DO/Hetzner/OCI
  disks for the job size must be ≥ 20 GiB (as the platform's `*_DISK_GB` already require).

## 2026-10-04 build agent — security review fixes (7 minors)
Done, in the working tree (not committed):
1. `internal/dhcp`: `unicast4` also refuses 0/8 and 240/4 (addresses, routers, next hops);
   classless-route destinations overlapping 0/8 (except the default route), 127/8, 224/4 or 240/4
   are refused (`routable`); a classless next hop equal to the leased address is refused (option 3's
   router already was). Tests in `TestLeaseRefuses`.
2. `CheckAck` (new, used by the exchange): the ACK's server id is required and must equal the
   offer's; the address must match. `TestCheckAck`.
3. `assemble-disk.sh`: every `/etc/shadow` password field must start with `*` or `!` (empty or a hash
   refused); `/etc/passwd` password fields must be `x` or locked.
4. `assemble-disk.sh`: a `find` by name anywhere (sshd, `sshd-*`, dropbear, cloud-init,
   `*guest-agent*`, `*guest_agent*`, `google_*`, waagent, `authorized_keys[2]`), and `/etc/ssh`,
   `/etc/cloud` must be absent. Checked for false positives against the job image's package set
   (trixie-slim + git, ripgrep, nftables, nodejs, npm, python3, venv, pip, its users): passes; an
   empty password field is refused.
5. `build-disk.sh --resolvers`: the same public-IPv4 rule as `ParseCmdline`. Decision: both now also
   refuse 0/8 and 240/4 (Go's `IsGlobalUnicast` lets those through), so the two rules are identical:
   not 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4, 240/4; canonical
   decimal only (no leading zeros). `TestParseCmdline` gained the cases.
6. `kete-cloudvm-images.yml`: no job-level env in provider jobs; each provider's secrets and
   variables are in the env of only its "Credentials" (configured?) step and its import step
   (checkout, artifact download, Packer install and the OCI CLI install never see them).
7. Provider jobs: `if: startsWith(github.ref, 'refs/tags/kete-v')`; the header and the job-image
   README document the environment's deployment rule (Selected, tag pattern `kete-v*`).
Docs: entrypoint README (DHCP validation, kete.dns rule), job-image README (refusals, CI), job-image
card. Checks re-run: result.md "Review fixes".
