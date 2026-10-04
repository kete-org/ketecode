# Handoff: Self-hosted job hosts P1: entrypoint host profiles, host-boundary probe, kete-job-init, multi-arch signed image

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-03 build agent (spec, plan, build in one session; coordinator-delegated, user approved design + build)

Done: spec.md (approved status per the user's 2026-10-03 "design + build all"), plan.md, the build
(see result.md for files and checks).

### Decisions (none changes the security posture beyond ADR 0023; each is stricter or neutral)

- **D1 config disk "must be present" (ADR rule 16 table, microvm).** kete-job-init reads the config
  disk and then removes it (ADR rule 15, task brief), so the entrypoint can't see it. Interpreted
  as: the values must arrive on init's pipe (`source`), PID 1 must be kete-job-init (`init`), and
  the disk must be **gone** by the time the entrypoint runs (`host_boundary` `config_disk`: any
  block device still starting with the header refuses the job). Stricter than reading the row
  literally.
- **D2 config pipe format.** `--config-fd <n>` (must be a FIFO; files, sockets, ttys refused) carries
  one strict JSON object `{job_id, platform_url, claim_token, storage_host, host_profile,
  host_provider (cloudvm), host_generation (dedicated)}`, ≤ 4096 bytes, no unknown field. The same
  object follows `kete-job-config v1\n` on the config disk (then only NUL padding) and is the cloudvm
  user data. The ADR's sealed configuration also has `network`; that is for the agent to build the
  kernel `ip=` argument and is **not** on the disk or pipe. P2.0 (plat contract) must adopt this
  shape or this task's parsers change with it.
- **D3 dedicated's "reset generation"** travels in the pipe payload (`host_generation`, pattern
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), not a new env var: the env stays at the four values + the
  profile. `KETE_JOB_HOST_PROFILE=dedicated` from the agent's env must match the payload.
- **D4 values in both places refused.** With `--config-fd`, any of the four `KETE_JOB_*` env vars
  set is exit 2 (ambiguous). Env path + a non-fly profile is exit 2 (values must come from a pipe).
- **D5 exit codes.** Boot-detectable errors (unknown profile, unset without Fly signals, wrong
  source, bad payload) exit 2 with `boot invalid`; machine-signal mismatches exit 1 at `setup_host`
  (new step, first after `boot`, in every profile including fly — one extra `setup_host` start/ok
  pair of phase lines on Fly; no other Fly change).
- **D6 cloudvm "DMI matches provider"** uses the fields cloud-init's datasources check (gcp
  `product_name` "Google Compute Engine", digitalocean/hetzner `sys_vendor`, oci
  `chassis_asset_tag` "OracleCloud.com"); exactly one provider may match. To verify on real VMs (P6).
- **D7 metadata drop table** `inet kete_job_init`, `hook output priority -150`, drops
  `169.254.0.0/16`, `fd00:ec2::254`, `fd20:ce::254`. The entrypoint confirms it with `nft list table`
  (`metadata_drop`) and the root probe (`metadata`).
- **D8 init network.** Per the brief, the uplink is the kernel's own `ip=` (static from the agent,
  `ip=dhcp` on cloud VMs); init only brings `lo` up, waits for the uplink + default route, and writes
  resolv.conf from `/proc/net/pnp` minus link-local/loopback resolvers (none left = fail). No DHCP
  client in init. GCP's DHCP resolver is the metadata server, so cloudvm images must pass public
  resolvers as `ip=`'s dns0/dns1 (the kernel prefers them) — a P6 item.
- **D9 init power.** microvm ends with `reboot(RESTART)` (Firecracker exits on a guest reboot; it
  has no x86 power-off), cloudvm and any failure before the mode is known with `POWER_OFF` (never a
  boot loop). Mode is decided by the config found (config disk → microvm, else cloudvm).
- **D10 overlay root.** Stage 1 builds the overlay only when a block device has an ext4 label
  `kete-scratch` (the agent formats the scratch disk; P4 must do so), then pivots and re-execs
  `kete-job-init __guest` so `/proc/1/exe` is the overlay path the entrypoint checks.
- **D11 guarded paths off Fly.** The tool-user isolation check adds every block device node
  (`guarded_path`, new probe kind `file`) and, on dedicated, the agent's
  `/var/lib/kete-job-host` and `/etc/kete-job-host`. `fly`'s probe list is unchanged (Build with
  zero-value `OffFly`/`Extra` is byte-for-byte today's).
- **D12 release assets.** `kete-job-image.digest` keeps its one-line format and meaning (the
  linux/amd64 digest the Fly adapter pins today, per platform `docs/integrations/fly.md` "use that
  exact string"); the new `kete-job-image.digests` carries `index`, `linux/amd64`, `linux/arm64`,
  `cosign-identity`, `cosign-issuer`; the notes list everything. This keeps Fly's pinning working
  while the "does Fly resolve an index" check is outstanding. Per-arch tags `<tag>-linux-<arch>`.
- **D13 arm64 in the release** is built under QEMU on the amd64 runner (no assumption of a free
  arm64 runner) and smoke-tested (entrypoint `boot invalid` exit 2, init refuses off PID 1); the full
  e2e runs on amd64 only. cosign v3.0.6 via `sigstore/cosign-installer` v4.1.2; the index and both
  per-arch digests are signed and each verified against the tag identity before publish.
- **D14 test launch changes forced by rule 16** (allowed by AC1, expectations unchanged):
  `TestBinaryBoot` now has a world-open `/.fly/api` (the env path is Fly's; without a Fly signal it
  would exit 2 — that case is `TestBinaryBootRefusals/no profile, no fly`); the in-process harness
  defaults a run with no profile to `fly` (Fly signal) or `dedicated` (`defaultProfile`); `e2e.sh`
  runs the job as `dedicated` over `docker run -i` stdin with a host-side nft table standing in for
  the agent's table (else the host-boundary probe rightly finds the Docker host reachable). The
  isolation unit test fake gained `OpenFile`.

### Open issues / for later phases

- **P2.0 (plat):** adopt D2's JSON (field names, limits) for the config disk, agent pipe and user
  data; the agent must also set `KETE_JOB_HOST_PROFILE=dedicated` and pass `--config-fd`.
- **P3 (plat):** the Fly adapter may set `KETE_JOB_HOST_PROFILE=fly` once this image is pinned
  (not required: unset + Fly signals = fly).
- **P4:** format the scratch disk ext4 with label `kete-scratch`; config disk = header + JSON + NUL
  padding, root-owned in guest; kernel needs `CONFIG_IP_PNP`, overlayfs, virtio-blk unbind; verify
  stage 1 (mounts, pivot, re-exec), Firecracker exit on reboot, and that `/proc/1/exe` reads the
  overlay path.
- **P5 (dedicated):** if the agent starts the entrypoint as PID 1 of a new PID namespace, nothing
  reaps orphans and zombie job-uid processes would make `Reap` report `processes_alive`; the agent
  should launch it under a reaper (e.g. a `kete-job-init` reaper mode) or not as PID 1.
- **P6:** verify DMI fields, user-data endpoints and OCI's base64, that no provider gateway answers a
  host-boundary sample port (e.g. Hetzner's 172.31.1.1 is also a private sample), and `ip=dhcp` +
  public dns0/dns1 on each cloud kernel.
- **Real Fly (staging):** confirm a machine starts from the index digest; until then Fly pins the
  amd64 digest (D12). Confirm the extra `setup_host` phase lines are harmless to the platform's log
  handling.
- **Release:** the multi-arch/cosign path runs only on a tag; a manual dispatch exercises build,
  e2e and the arm64 smoke but not push/sign/verify. First real run is the next `kete-v*` tag.

### Addendum (same session): bug found by the image e2e

- `docker run -i` delivers the config on fd 0. After `ReadConfigFD` closed fd 0, `Handover`'s
  `os.Pipe()` reused fd 0 and `__run 0` was refused (`boot invalid`). Fixed: `ReadConfigFD` parks
  `/dev/null` on a closed stdio fd and `Handover` moves its pipe to fd ≥ 3. Regression test
  `TestBinaryBootDedicatedStdin`. The e2e then passed all three scenarios.

## 2026-10-03 build agent — security review fixes (coordinator relay; no blockers)

1. **MAJOR, panics in init:** `guestinit.Run` recovers a panic (phase line `init_poweroff`
   failed, `Shutdown(PowerOff)`, entrypoint never started); `Stage1`/`Stage2` defer
   `powerOffOnPanic`. Test `TestRunPanic` (a Deps call panics before and after the mode is known:
   both power off). **P4 requirement: the guest kernel command line carries `panic=1`** (a panic in
   another goroutine still kills PID 1; the kernel then reboots, which ends a Firecracker VM; on a
   cloud VM the reboot finds the claim token used and powers off). Recorded in the entrypoint README
   ("kete-job-init" step 6); the platform plan overview's P4 section should list it too.
2. `host_boundary` fails `probe` when no IPv4 default gateway exists (every non-fly profile). The
   integration netns now has an on-link default route via `198.51.100.1` (`integration.sh`;
   nothing answers there) and `guestTree` writes the same gateway; new case
   `TestHostBoundaryMicrovm/no default gateway`.
3. Release split: `image` (build, amd64 e2e, arm64 QEMU smoke) has `contents: read` only and on tags
   saves both images (`docker save | gzip`, artifact `kete-job-images`, 1-day retention, SHA-256 as
   a job output); new tag-only `image-publish` (no checkout, no build; the only job with
   `packages: write` and `id-token: write`) verifies the checksum, loads, pushes, indexes, signs and
   verifies; `publish` takes its outputs.
4. The notes gain "linux/amd64 passed the full end-to-end test; linux/arm64 was smoke-tested under
   QEMU only"; `kete-job-image.digests` gains `tested linux/amd64=e2e linux/arm64=qemu-smoke-only`;
   the "tested" comment now says which test each image passed.
5. `docs/release.md`: `kete-job-image.digest` is the linux/amd64 platform-manifest digest resolved
   from the registry; it may differ in form from earlier releases' pin (the pushed repo digest).
6. The metadata drop is checked by content: `hostprofile.VerifyMetadataDrop` over `nft -j list
   table inet kete_job_init` (exactly one chain filter/output/-150/accept and exactly the two drop
   rules). Used by init's `ApplyMetadataDrop` and by the entrypoint's cloudvm `host_boundary`.
   Tests: `TestVerifyMetadataDrop` (real nft 1.0.6 JSON plus nine tamperings) and
   `TestCloudvmMetadataDrop` now also refuses a table with an extra `accept` rule.
7. `hostprofile.PrivateSamples` comment says to re-verify the list per provider in P6.

Checks after the fixes: gofmt/vet (plain, integration, e2e)/`go test -race` pass; integration 28/28;
image build + e2e all three scenarios pass (images removed, fstrim run); actionlint clean;
`bun run lint`, `upstream:check`, `card-check` pass.
