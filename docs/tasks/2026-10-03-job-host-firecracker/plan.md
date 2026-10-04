# Plan: Self-hosted job hosts P4: Firecracker driver, guest kernel, host nftables, image verification

<!-- Written by the build agent from spec.md and the cards (coordinator-delegated: spec, plan and
build in one session, user approved design + build all on 2026-10-03). -->

## Cards read
- docs/context/modules/job-host.md (verified-at 60243f8c6e, stale: no)
- docs/context/modules/job-entrypoint.md, job-image.md, kete-tools-ci.md (for kete-job-init's
  needs, the image build and the release workflow)
- kete-code-platform docs/adr/0023-self-hosted-job-hosts.md rules 7, 12, 13, 15, 17, 21;
  plan-overview P4; P1 and P2 handoffs

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/kete-job-host/internal/driver/driver.go` | change | optional `Preparer`, `Blocker` |
| `packages/kete-job-host/internal/agent/agent.go` | change | verify/config/prepare in the worker, off `a.mu`; driver block in `startsBlocked`; `waitFast` |
| `packages/kete-job-host/internal/config/config.go` | change | optional `firecracker` section, ≤ 2 resolvers |
| `packages/kete-job-host/internal/image/{verify,store}.go` | new | sigstore-go verifier; fetch, verify, unpack, `mkfs.ext4 -d`, cache, prune |
| `packages/kete-job-host/internal/hostnet/{hostnet,tap_linux}.go` | new | host table, taps, /30s, uplink, forwarding |
| `packages/kete-job-host/internal/driver/firecracker/{render,driver_linux}.go` | new | the driver |
| `packages/kete-job-host/cmd/kete-job-host/{main,host_linux,host_other}.go` | change | driver + verifier wiring, `Init`, doctor checks |
| `packages/kete-job-host/kernel/*` | new | fragment, resolved configs, check and build scripts |
| `packages/kete-job-host/packaging/{kete-job-host.service,install.sh}` | change/new | `KillMode=mixed`; installer |
| `packages/kete-job-host/internal/kvmtest/*`, `scripts/kvm-test.sh` | new | KVM acceptance tests, guest probe, runner |
| `packages/kete-job-host/testdata/sigstore/*` | new | trusted root + a real cosign v3 bundle |
| tests in `internal/{agent,image,hostnet,driver/firecracker,config}`, `cmd/kete-job-host` | new/change | CI coverage (AC1–AC6) |
| `packages/kete-job-entrypoint/internal/fakeplatform/fakeplatform.go` | change | 64-hex claim tokens (the contract's shape) so the agent accepts the fake's job |
| `.github/workflows/kete-job-host.yml`, `kete-release.yml` | change | CI steps; kernel build + sign jobs |
| README, cards, `docs/release.md` | change | docs |

## Steps
1. Driver interfaces and agent restructure (verify, checkSealed, Prepare, Start in the worker; reason
   order kept; reports never wait for slow work).
2. Image store and verifier (go-containerregistry, sigstore-go); tests with an in-process registry,
   a real public cosign v3 bundle and a tampering registry.
3. Host table and taps; golden files; `nft -c`/apply/check in a privileged container.
4. Firecracker driver; golden files for jailer args, VM config, boot args; config disk round trip.
5. Guest kernel: Firecracker v1.17.0's 6.18 configs + fragment, `--regen-config` on kvmtest, build
   arm64 there, rebuild to check reproducibility.
6. KVM acceptance on Colima `kvmtest` (aarch64): isolation probe, real job to claim, lifecycle.
7. Packaging, doctor, CI and release workflows, docs, cards.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `go test ./internal/hostnet/` (privileged container with nft) |
| AC2 | `go test ./internal/driver/firecracker/` |
| AC3 | `go test -run Rootfs ./internal/image/` (root, mkfs.ext4, debugfs) |
| AC4 | `go test -run Verify ./internal/image/` |
| AC5 | `packages/kete-job-host/kernel/check-config.sh` |
| AC6 | `go test -race ./internal/agent/` |
| AC7 | `sudo scripts/kvm-test.sh <dir> TestRealJob` on kvmtest |
| AC8 | `sudo scripts/kvm-test.sh <dir> TestGuestIsolation` |
| AC9 | `sudo scripts/kvm-test.sh <dir> TestLifecycle` |
| AC10 | gofmt/vet/race in golang:1.26-bookworm; actionlint; `bun run lint`; `upstream:check`; `card-check` |

## Cards to update after the build
- job-host, kete-tools-ci, commands.md, repo-map.md, INDEX.md; docs/release.md.
