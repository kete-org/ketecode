# Result: Self-hosted job hosts P4: Firecracker driver, guest kernel, host nftables, image verification

## What changed
- `packages/kete-job-host/`:
  - `internal/driver/firecracker/` (new) — `render.go` (jailer args, VM config, kernel command line),
    `driver_linux.go` (`Init`: host table, cgroup parent, stray taps; `Start`/`Status`/`Stop`/`List`/
    `Logs`; `Prepare`; `StartsBlocked`), tests + golden files.
  - `internal/hostnet/` (new) — host table `inet kete-job-host` (render, apply, canonical-listing
    check), /30 slots, `ip=`, MAC, uplink, forwarding; taps via `ip` (`tap_linux.go`); goldens.
  - `internal/image/verify.go` (new) — `Sigstore` verifier (sigstore-go, cosign v3 bundles,
    `ReleaseIdentity`, TUF trusted root); `store.go` (new) — fetch by digest, whole-blob and diff_id
    checks, `os.Root` unpacking with whiteouts, `mkfs.ext4 -d`, per-digest cache, prune; tests.
  - `internal/driver/driver.go` — optional `Preparer` and `Blocker`.
  - `internal/agent/agent.go` — signature check, sealed-config checks, `Prepare` and `Start` in the
    machine's worker off `a.mu` (`checkCheap`, `checkSealed`, `prepare`, `waitFast`); driver block
    in `startsBlocked`; `prepare_test.go` (new); harness `wrap`.
  - `internal/config/config.go` — `firecracker` section, ≤ 2 resolvers; tests.
  - `cmd/kete-job-host/` — firecracker driver and sigstore verifier wired, driver `Init` before
    reconcile, firecracker `doctor` checks (`host_linux.go`), `host_other.go`; test updated.
  - `internal/kvmtest/` (new, tag `kvm`) — KVM acceptance tests and the guest probe; `scripts/kvm-test.sh`.
  - `kernel/` (new) — `kete.fragment`, `config-amd64`, `config-arm64`, `check-config.sh`, `build.sh`.
  - `packaging/kete-job-host.service` (`KillMode=mixed`), `packaging/install.sh` (new).
  - `testdata/sigstore/` (new) — Sigstore trusted root and a real cosign v3 bundle.
  - `go.mod`/`go.sum` — go-containerregistry v0.22.1, sigstore-go v1.3.0; `README.md`; `.gitignore`.
- `packages/kete-job-entrypoint/internal/fakeplatform/fakeplatform.go` — 64-hex claim tokens;
  `internal/isolation/isolation.go` — control probes get up to 3 attempts (`ControlAttempts`;
  `TestCheckControlRetried`), found by the KVM tests.
- `.github/workflows/kete-job-host.yml` — nftables/e2fsprogs, kernel config check, `vet -tags kvm`,
  KVM test compile; `.github/workflows/kete-release.yml` — `kernel`, `kernel-publish`, kernel assets
  in `publish`.
- Docs: `docs/release.md`; `docs/context/modules/job-host.md`, `modules/kete-tools-ci.md`,
  `commands.md`, `repo-map.md`, `INDEX.md`; task folder; `docs/tasks/metrics.md`.

## Checks
| Check | Result |
|---|---|
| `gofmt -l` (empty), `go vet ./...`, `go vet -tags kvm ./...`, `GOOS=darwin go vet ./...` (golang:1.26-bookworm) | pass |
| `go test -race -count=1 ./...` as root, `--privileged`, nftables installed (golang:1.26-bookworm, arm64) | pass, all 16 packages with tests |
| `go test -race -count=8 ./internal/agent/` | pass |
| `kete-job-entrypoint`: gofmt, vet (incl. `-tags integration`), `go test -race ./...`, `scripts/integration.sh` (privileged) | pass |
| `kernel/check-config.sh` (both configs) | pass |
| Kernel build arm64 on kvmtest, twice | same SHA-256 (`sha256:b88c1cf4…3735`), ~5 min |
| Kernel build amd64 (cross, on kvmtest) | built, `sha256:762e9cdd…e5db5` (not booted: no amd64 KVM here) |
| Reviewer subagent on the diff | 4 major + 7 minor findings; all majors and 6 minors fixed (handoff "review fixes") |
| KVM `TestGuestIsolation` (kvmtest, aarch64, Firecracker v1.17.0, kernel 6.18.55-kete.1) | pass |
| KVM `TestRealJob` | pass (`setup_host`, `host_boundary`, `isolation`, `claim` ok; on to `agent start`) — with the image's entrypoint once, then (after the control-probe finding) with this checkout's entrypoint in 3 consecutive runs |
| KVM `TestLifecycle` | pass |
| `doctor` on kvmtest (firecracker section) | all driver checks ok (keys/enrollment fail as expected: not enrolled) |
| `packaging/install.sh` on kvmtest (then removed) | pass; a wrong SHA-256 is refused; `systemd-analyze verify` ok |
| actionlint on `kete-job-host.yml`, `kete-release.yml` | pass |
| `bun run lint` | pass (0 warnings, 0 errors) |
| `upstream:check` | pass (no upstream file touched) |
| `card-check` | pass (27 cards) |
| CI on GitHub | not run (nothing pushed, per the brief) |

## Acceptance criteria
- [x] AC1 — `internal/hostnet`: `TestRenderGolden`, `TestRenderRefusals`, `TestRenderParses` (`nft -c`), `TestApplyAndCheck` (missing, changed), `TestCanonicalStripsHandles`.
- [x] AC2 — `internal/driver/firecracker`: `TestRenderGolden`, `TestRenderedSafety`, `TestConfigDiskRoundTrip`, `TestKernelNotAllowlisted`, `TestLogsListStop`.
- [x] AC3 — `internal/image`: `TestRootfsConversion`, `TestRootfsRefusals`, `TestRootfsTamperedBlob`.
- [x] AC4 — `internal/image`: `TestVerifyBundle`, `TestVerifyFromRegistry` (real bundle; Kete's identity refuses it).
- [x] AC5 — `kernel/check-config.sh` in CI and in `build.sh`.
- [x] AC6 — `internal/agent`: `TestSlowVerifyOffTheLock`, `TestStopWhileVerifying`, `TestImageUnavailableAndPrepare`, `TestDriverBlocksStarts`.
- [x] AC7 — KVM `TestRealJob`.
- [x] AC8 — KVM `TestGuestIsolation` (host gateway TCP 443/22/ICMP, uplink address, other guest, 10/8, 100.64/10, 169.254.169.254, 192.168/16, 172.16/12, IPv6 global and link-local, TCP 80 and UDP 5353 out: blocked; TCP 443 and UDP 53 to the resolver: open).
- [x] AC9 — KVM `TestLifecycle` (+ `TestGuestIsolation`, `TestRealJob` residue checks): jail confinement (uid/gid, seccomp 2, no caps, own PID ns, cgroup limits), restart re-adoption, deadline kill offline, withdraw cleanup, deleted table blocks starts.
- [x] AC10 — see Checks.

## Addendum: fail closed on lost host isolation (coordinator decision)
- `driver.IsolationGuard`, `Driver.CheckIsolation`, `Agent.CheckIsolation` on its own 5 s loop in
  `Run`; every live machine destroyed with `host_isolation_lost` (+ phase line), starts blocked
  until restart. New reason added to kete-code's contract only — the platform must adopt it.
- Checks re-run: gofmt, vet (incl. `-tags kvm`, darwin), `go test -race` (all 16 packages with tests) (privileged,
  nftables); agent `-race -count=8`; KVM on kvmtest: `TestLifecycle` (extended) and
  `TestGuestIsolation` pass (Firecracker and kernel re-staged; the arm64 kernel rebuilt a third
  time to the same SHA-256); actionlint, `bun run lint`, `upstream:check`, `card-check` pass.

## Open issues
See handoff.md "Open issues" (the table-vanishes issue is resolved by the addendum): Docker on hosts, the platform adopting `host_isolation_lost`, the first
signed release (kernel jobs and a real Kete bundle), amd64 boot on a real KVM host, platform P3.
