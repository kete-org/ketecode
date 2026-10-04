# Plan: Self-hosted job hosts P1: entrypoint host profiles, host-boundary probe, kete-job-init, multi-arch signed image

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

## Cards read
- docs/context/modules/job-entrypoint.md (verified-at 685f875850, stale: no)
- docs/context/modules/job-image.md, kete-tools-ci.md, contracts.md §6d

## Design

**Profiles** (`internal/hostprofile`, pure): `Resolve(explicit, flySignals)` is the boot rule
(unset → `fly` only with Fly signals, else error; unknown → error). `Check(profile, Signals)` is
the setup rule; codes:

| Code | Refused when |
|---|---|
| `fly_signals` | a `FLY_*` variable or `/.fly` exists and the profile isn't `fly` |
| `missing` | `fly` without any Fly signal (today's code) |
| `source` | values came from the environment for a non-`fly` profile, or from a pipe for `fly` |
| `init` | `microvm`/`cloudvm` and `/proc/1/exe` isn't `/usr/local/libexec/kete/kete-job-init` |
| `vsock` | `microvm` and a virtio device with id `0x0013` (vsock) exists |
| `dmi` | `cloudvm` and the firmware DMI field doesn't match `host_provider` (gcp: `product_name` "Google Compute Engine"; digitalocean: `sys_vendor` "DigitalOcean"; hetzner: `sys_vendor` "Hetzner"; oci: `chassis_asset_tag` "OracleCloud.com") |
| `generation` | `dedicated` without a reset generation |

**Values**: `--config-fd <n>` (must be a FIFO) carries one JSON object (strict, ≤ 4096 bytes):
`job_id`, `platform_url`, `claim_token`, `storage_host`, `host_profile` (`microvm` | `dedicated` |
`cloudvm`), `host_provider` (cloudvm only), `host_generation` (dedicated only). With the pipe, the
four `KETE_JOB_*` env vars must be unset and `KETE_JOB_HOST_PROFILE`, if set, must match. Without
it, the env path is today's plus the profile, which must resolve to `fly`. Invalid → exit 2. The
handover to `__run` carries profile, source, provider and generation (re-validated).

**Setup order**: boot → `setup_host` (signals) → users → sysctl → proc → `setup_fly` (fly only,
unchanged) **or** `host_boundary` (others) → dirs … unchanged.

**Host boundary** (root, in-process `isolation.Check` with `SysNet`, before any in-guest rule):
control (loopback TCP listener); the IPv4 default gateways (`/proc/net/route`) on TCP 22, 25, 53,
80, 111, 443, 2375, 2376, 3000, 4280, 5000, 6443, 8000, 8080, 8443, 9100, 10250 and DNS/UDP 53
(`gateway`); `169.254.169.254` 80/443, DNS 53, `169.254.169.253:53`, `[fd00:ec2::254]:80`,
`[fd20:ce::254]:80` (`metadata`); RFC 1918 / CGNAT / ULA samples on 22, 53, 80, 443
(`private_range`); public IPv6 samples on 443 (`ipv6`). Then: no block device starts with the
config-disk header (`config_disk`); cloudvm: init's table `inet kete_job_init` exists
(`metadata_drop`). Phase step `host_boundary`.

**Isolation probe per profile**: `Inputs.OffFly` drops `[fdaa::3]`, the 6PN samples and local
`fdaa::/16`; `Inputs.Extra` adds the profile's targets as the tool user (gateway, private, IPv6,
extra metadata; guarded files = every block device node, new kind `file`, code `guarded_path`;
dedicated: the agent's `/var/lib/kete-job-host` and `/etc/kete-job-host`). `fly` passes neither:
identical probe list to today.

**kete-job-init** (`cmd/kete-job-init`, `internal/guestinit`): stage 1 (PID 1 only): mount
proc/sys/devtmpfs, console fds, overlay root on an ext4 scratch disk labelled `kete-scratch` when
present (pivot_root, re-exec from the new root); stage 2: cgroup2, `/run`, `/dev/shm`, `lo` up,
wait for the kernel-`ip=` interface and default route, `/etc/resolv.conf` from `/proc/net/pnp`;
config: a block device with header `kete-job-config v1\n` → microvm (JSON then NUL padding, read ≤
64 KiB, unbind the device's driver, check it's gone), else cloudvm (provider by DMI, user data from
the provider's metadata endpoint, then the metadata drop `inet kete_job_init`, checked); start
the entrypoint with `--config-fd 3`; forward SIGTERM/SIGINT; reap; on exit kill all, sync,
`reboot` (microvm: RESTART, which Firecracker treats as exit; cloudvm: POWER_OFF). Every failure
powers off. Deps behind an interface for tests.

**Image**: `kete-job-init` at `/usr/local/libexec/kete/kete-job-init` (0755); `build.sh` builds
it and passes `--platform linux/<arch>`. **e2e**: runs as `dedicated` via `docker start -i` with
the fake's `config.json` on stdin (`--config-fd 0`) and a host-side nft table in the Docker VM
mimicking ADR rule 7 (job IP → host dropped; private/special ranges dropped; only TCP 443 and the
fake out).

**Release**: image job builds amd64 (e2e) and arm64 (QEMU, smoke), then on tags pushes both,
creates the index (`buildx imagetools create`), installs cosign (pinned installer, cosign v3.0.6),
signs index + both digests keyless, verifies each against
`https://github.com/<repo>/.github/workflows/kete-release.yml@refs/tags/<tag>` /
`https://token.actions.githubusercontent.com`. Publish records index, per-arch digests and the
identity in the notes and a new keyed asset `kete-job-image.digests`; `kete-job-image.digest`
stays the single amd64 line Fly pins today.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/kete-job-entrypoint/internal/hostprofile/* | new | profiles, signals, boundary targets, drop ruleset, DMI table |
| packages/kete-job-entrypoint/internal/bootenv/* | change | profile var, config pipe decode, handover fields |
| packages/kete-job-entrypoint/cmd/kete-job-entrypoint/main.go | change | `--config-fd` |
| packages/kete-job-entrypoint/internal/entry/entry_linux.go | change | `setup_host`, `host_boundary`, per-profile isolation inputs |
| packages/kete-job-entrypoint/internal/isolation/* | change | `OffFly`, `Extra`, kind `file`, new codes |
| packages/kete-job-entrypoint/internal/phaselog/phaselog.go | change | steps/codes |
| packages/kete-job-entrypoint/internal/layout/layout.go | change | InitBin and signal paths |
| packages/kete-job-entrypoint/internal/guestinit/*, cmd/kete-job-init/* | new | init |
| packages/kete-job-entrypoint/internal/itest/* | change | harness default profile, new tests |
| packages/kete-job-entrypoint/cmd/kete-job-fake-platform/main.go | change | writes `config.json` |
| packages/kete-job-image/{Dockerfile,scripts/build.sh,scripts/e2e.sh,README.md} | change | init, platform, dedicated e2e |
| .github/workflows/kete-release.yml, kete-job-image.yml | change | multi-arch, cosign; config.json removal |
| READMEs, docs/release.md, cards, contracts §6d | change | docs |

## Steps
1. hostprofile + phaselog + layout + isolation changes, unit tests.
2. bootenv config pipe + main `--config-fd`, unit tests.
3. entry wiring; itest harness default + new integration tests; run the suite.
4. guestinit + cmd, unit tests.
5. Image + e2e changes; build + e2e.
6. Release workflow; actionlint.
7. Docs, cards, card-check, lint, upstream:check; result, handoff, metrics.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1, AC2, AC4 | `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go vet -tags e2e ./... && go test -race ./...'` |
| AC1, AC3 | `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh` |
| AC5 | `bash packages/kete-job-image/scripts/build.sh && bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario all` |
| AC6 | `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` |
| AC7 | `node scripts/agent/card-check.mjs`, `bun run lint`, `bun run --cwd packages/kete-tools upstream:check` |

## Cards to update after the build
- job-entrypoint, job-image, kete-tools-ci, contracts.md §6d
