# Spec: Self-hosted job hosts P4: Firecracker driver, guest kernel, host nftables, image verification

- Task: `docs/tasks/2026-10-03-job-host-firecracker` · Size: large · Created: 2026-10-03
- Status: built (approved by the user, 2026-10-03: design + build all)

## Goal
Give `kete-job-host` (P2) its first real driver so a Kete-operated KVM server can run cloud jobs:
one jailed Firecracker microVM per job, booted from the signed, allowlisted release image with
Kete's guest kernel, confined by a host nftables table (kete-code-platform ADR 0023 rules 7, 12,
13, 15, 17, 21; plan-overview P4), and packaged so an operator can install it.

## Scope
Module `packages/kete-job-host` (card `job-host`), plus CI and the release workflow (card
`kete-tools-ci`).

1. **Driver `firecracker`** (`internal/driver/firecracker`), honouring `driver.Driver`'s rules:
   - Jailer per VM: its own uid/gid (a fixed base + slot index), chroot under the state directory,
     Firecracker's default seccomp filters, a new PID namespace, cgroup v2 `cpu.max`,
     `memory.max` (job size + VMM overhead) and `pids.max` from the run's resources, under the
     parent cgroup `kete-job-host-vms` (outside the agent unit's cgroup).
   - Disks: the read-only base rootfs per image digest (from the image store, hard-linked into
     the jail, `is_read_only`), a per-job sparse ext4 scratch disk labelled `kete-scratch`
     (`scratch_gib`), and the read-only config disk from `seal.ConfigDisk` (jail uid `0600`,
     unlinked once Firecracker holds it open). No vsock, MMDS off (no `mmds-config`, no API
     socket: `--config-file` + `--no-api`), drive and network rate limiters.
   - Network: one tap (`kjh<slot>`, owned by the jail uid, IPv6 disabled) and one /30 per VM from
     a configured IPv4 pool; kernel command line `console=ttyS0 reboot=k panic=1 pci=off
     init=/usr/local/libexec/kete/kete-job-init root=/dev/vda ro ip=<guest>::<gw>:<mask>::eth0:off:<dns0>:<dns1>`.
   - Guest kernel: the configured file, hashed at every start and refused unless its SHA-256 is
     in `kernel_allowlist`.
   - Serial console to a root-only file; `Logs` returns new complete lines (bounded per call,
     offset persisted, file truncated when consumed); the agent filters them to phase lines.
   - `Start`/`Stop`/`Status`/`List`/`Logs` with contexts; per-machine state (`vm.json`, no
     configuration) so machines are re-adopted after an agent restart; `Stop` kills via
     `cgroup.kill` and removes the cgroup, tap, jail and state — nothing left; `List` reports
     every machine any of those still holds. Status `exited` when Firecracker logged a clean exit
     (guest reboot), else `crashed`.
2. **Host nftables table** `inet kete-job-host` (`internal/hostnet`), rendered from the
   configuration, applied at driver start with `nft -f`, checked (its `nft -j` listing must equal
   the listing taken right after applying), re-checked before each start and every 30 s; missing
   or changed → starts blocked (`host_table`) and reported. Drops guest → host (input, every
   protocol), guest → guest, every IPv6 packet from a guest, and destinations in RFC 1918,
   `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`, `192.0.0.0/24`,
   `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`; allows only TCP 443 and DNS (UDP/TCP 53) to the
   configured resolvers, out of the uplink only; masquerades guest traffic on the uplink.
3. **Images** (`internal/image`): fetch by digest from the allowlist with go-containerregistry
   (index → the host architecture's manifest; every blob downloaded whole and checked against its
   digest and size before use), flatten (whiteouts) into a directory through `os.Root` (no path
   escape; devices skipped), `mkfs.ext4 -d` into a read-only rootfs cached per manifest digest;
   cache pruned to the allowlist. **cosign keyless verification** with sigstore-go: the Sigstore
   bundle referrer of the index digest (`sha256-<hex>` fallback tag), DSSE in-toto subject = the
   index digest, Fulcio certificate SAN `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v<semver>`,
   issuer `https://token.actions.githubusercontent.com`, SCT + Rekor/timestamps from the Sigstore
   trusted root (TUF, cached under the state directory). Verification and fetch run in the
   machine's worker, **outside the agent lock**, each with its own timeout.
4. **Guest kernel**: `kernel/` with the pinned 6.18 LTS (Firecracker v1.16.1+ supports it; 6.1's
   support ended 2026-09-02), `kete.fragment` (requirements), resolved `config-amd64` and
   `config-arm64` (Firecracker's validated guest config + fragment, modules off),
   `check-config.sh`, and a reproducible `build.sh`; the release workflow builds both, signs them
   with cosign `sign-blob` and publishes them with their `sha256:` allowlist lines.
5. **Packaging**: systemd unit (`KillMode=mixed`; VMs live in their own cgroups, so an agent
   restart or stop leaves them running and reconcile re-adopts or kills them), `doctor` checks
   for the firecracker driver (`/dev/kvm`, cgroup v2 controllers, `nft`, the host table,
   Firecracker and jailer versions = `versions.firecracker`, kernel SHA in the allowlist, IP
   forwarding, `mkfs.ext4`, `ip`, disk space), and `packaging/install.sh`.

Agent changes: optional driver interfaces `Preparer` (image fetch/convert, `image_unavailable`)
and `Blocker` (starts blocked: `host_table`, `driver_unhealthy`); the assignment's signature
check, configuration checks, prepare and start move into the machine's worker (state
`preparing`), keeping the contract's reason order; `run` wires the firecracker driver and the
sigstore verifier.

## Out of scope
The dedicated driver (P5), cloud VM images (P6), platform routes (P3), TPM keys, publishing a
release (tags are a maintainer's), GitHub-hosted KVM CI.

## Acceptance criteria
- [ ] AC1 (CI): the rendered host table matches golden files for sample configurations and parses
  with `nft -c`; the table check detects a missing or changed table.
- [ ] AC2 (CI): config disk round trip through the driver; jailer arguments, Firecracker config and
  kernel command line for a sample machine match golden files (no secret in any of them).
- [ ] AC3 (CI): rootfs conversion from a test image (whiteouts, opaque dirs, hard and symbolic
  links, path escapes refused) with `mkfs.ext4 -d`; blob digest/size mismatch refused; the cache
  is keyed and pruned by digest.
- [ ] AC4 (CI): the verifier accepts a real cosign v3 keyless bundle for the right identity and
  refuses a wrong identity, issuer, digest or tampered bundle (checked-in test data, offline).
- [ ] AC5 (CI): `kernel/check-config.sh` passes for both configs; an option off or a module fails it.
- [ ] AC6 (CI): agent: verify/prepare/start run without the agent lock (a hung verifier doesn't
  block reports or other machines); `image_unavailable` and `starts_blocked` (`host_table`) paths.
- [ ] AC7 (KVM, kvmtest): a real job image boots under the driver from the agent and reaches
  `setup_host ok`, `host_boundary ok`, `isolation ok` and a successful claim against the in-repo
  fake platform.
- [ ] AC8 (KVM): from a guest-root probe, the host, another VM, RFC 1918, CGNAT,
  `169.254.169.254` and IPv6 are unreachable while TCP 443 and DNS to the resolver work; two
  concurrent VMs can't reach each other.
- [ ] AC9 (KVM): kill (`Stop`) and the deadline killer leave no tap, disk, process, cgroup or
  jail; an agent restart re-adopts a running VM; a hand-deleted host table blocks starts.
- [ ] AC10: gofmt/vet/race in `golang:1.26-bookworm`, the new CI steps, actionlint, `bun run
  lint`, `upstream:check`, `card-check`.

## Risks and constraints
Security-critical (host isolation, image trust). No contract change (the agent config file is
operator-local; new optional fields only). Dependencies: go-containerregistry and sigstore-go are
large; justified in `plan.md` and `handoff.md` against CLAUDE.md's dependency bar. Anything that
would weaken ADR 0023's posture stops for the user.
