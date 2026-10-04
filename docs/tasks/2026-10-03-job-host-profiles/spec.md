# Spec: Self-hosted job hosts P1: entrypoint host profiles, host-boundary probe, kete-job-init, multi-arch signed image

- Task: `docs/tasks/2026-10-03-job-host-profiles` · Size: large · Created: 2026-10-03
- Status: built — approved (user, 2026-10-03: design + build all)

## Goal
Make the cloud job image runnable on hosts other than Fly without weakening Fly: phase P1 of the
self-hosted job hosts program (kete-code-platform ADR 0023 rules 13-17, `docs/tasks/2026-10-03-self-hosted-job-hosts/plan-overview.md` P1).
The entrypoint learns host profiles and a host-boundary probe, the image gains `kete-job-init`
(PID 1 for microVM and cloud-VM guests), and the release publishes a signed multi-arch image.

## Scope
Modules: `job-entrypoint`, `job-image`, `kete-tools-ci` (release workflow); contracts §6d.

1. **Host profiles** (`fly`, `microvm`, `dedicated`, `cloudvm`) selected by `KETE_JOB_HOST_PROFILE`
   (ADR rule 16): Fly signals (a `FLY_*` machine variable or `/.fly`) ⇒ the profile must be `fly`;
   unset ⇒ `fly` only when Fly signals are present, else exit 2; unknown ⇒ exit 2; each profile's
   required signals present and forbidden signals absent, else exit before `claim`. `fly` keeps
   today's Fly guard and isolation probe unchanged.
2. **Values from a config pipe** (`--config-fd <n>`, a pipe only) for `microvm`, `cloudvm` and
   `dedicated`; the environment for `fly` only. Same validation; the boot stage's handover follows.
3. **Host-boundary probe** (new phase step `host_boundary`), as root before the network guard, for
   every profile but `fly`: the default gateway's sample ports, metadata addresses, private-range
   samples, IPv6 samples; for `microvm` a present config disk; for `cloudvm` init's metadata drop.
4. **Per-profile isolation probe inputs**: guarded paths, private-network and gateway samples,
   metadata addresses and resolvers by profile; `fdaa::/16` and `[fdaa::3]` only in `fly`.
5. **`kete-job-init`** (Go, `cmd/kete-job-init` in the entrypoint module): PID 1 for `microvm` and
   `cloudvm`: mounts, overlay root on the scratch disk (microvm), loopback up and the kernel `ip=`
   network checked, resolvers from `/proc/net/pnp`, config disk read and removed (microvm) or
   provider user data read once (cloudvm: GCP, DigitalOcean, Hetzner, OCI) followed by the
   metadata drop, entrypoint started with the values on a pipe, orphans reaped, phase lines on
   the console, power-off when the entrypoint exits. In the image, unused on Fly.
6. **Release**: `linux/amd64` and `linux/arm64` images, one index, cosign keyless signing of the
   index and per-arch digests, verified in the same workflow before the release is published;
   index, per-arch digests and the signing identity in the notes and in a digest asset. Actions
   pinned by SHA. Fly keeps today's amd64 digest pinning. Manual runs push nothing.

## Out of scope
The host agent (P2), the platform adapter and contract (P2.0/P3), the Firecracker driver, guest
kernel and host table (P4), the dedicated driver and resets (P5), Packer images (P6). Real Fly,
KVM or cloud VM runs (no infrastructure in this task).

## Acceptance criteria
- [ ] AC1: Fly unchanged: every existing entrypoint unit and integration test and the image e2e pass
  without edits to their expectations (launch changes forced by ADR rule 16 are allowed and listed
  in handoff.md).
- [ ] AC2: Unit tests cover every row of the profile matrix: Fly signals with each non-`fly` profile
  → refused; unset with Fly signals → `fly`; unset without → exit 2; unknown → exit 2; each
  profile with a required signal missing or a forbidden one present → refused.
- [ ] AC3: Integration (privileged container): `dedicated` through a config pipe runs a whole job
  with the real binary; a profile mismatch aborts before claim; the microvm host-boundary probe
  catches a reachable gateway port, an RFC 1918 sample and a present config disk; cloudvm without
  init's metadata drop is refused and with it runs.
- [ ] AC4: `kete-job-init` unit tests: config-disk parsing (bad header, oversize, bad JSON, wrong
  field types, unknown field), each provider's user-data reader against a fake metadata server,
  the metadata drop installed before the entrypoint starts, power-off on entrypoint exit, reaping.
- [ ] AC5: The image contains `kete-job-init` (root 0755); `build.sh` + `e2e.sh kete-job:local
  --scenario all` pass.
- [ ] AC6: Release workflow builds both architectures, signs and verifies with cosign keyless on
  tags only, publishes index and per-arch digests; actionlint passes; actions pinned by SHA.
- [ ] AC7: README (Machine configuration, Host profiles), image README, cards and contracts §6d
  updated; `card-check`, `bun run lint`, `upstream:check` pass.

## Risks and constraints
- Security: the entrypoint is the most privileged code in a job. Every new guard fails closed and
  lands with a test. Nothing new may carry a secret on argv, env, cmdline or a log; the config
  disk and pipe are root-only.
- Contracts: the entrypoint gains an optional fifth variable and the config pipe (§6d); the
  config-disk/pipe JSON defined here is what P2.0 must adopt.
- Fly: the Fly adapter does not set `KETE_JOB_HOST_PROFILE` yet; unset + Fly signals keeps working.
- No real Fly/KVM/cloud run here; what only real hosts can verify is listed in the README.
