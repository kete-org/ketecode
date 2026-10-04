# Result: Self-hosted job hosts P5: dedicated driver and reset verification (agent side)

## What changed
All in `packages/kete-job-host` unless noted (Kete-owned paths; no upstream file touched).
- `internal/driver/dedicated/` (new): `dedicated.go` (InitSpec, CgroupLimits, names), `driver_linux.go`
  (the driver), `init_linux.go` (the reaper `RunInit`), `mount_linux.go` (loop mounts, unmount),
  `dedicated_test.go`, `driver_linux_test.go` (real launches).
- `internal/agent/agent.go`: generation spent at `starting` (dedicated), `startsBlocked` blocks everything once spent,
  `generation_spent` in reports, free slots 0; `internal/agent/dedicated_test.go` (new, incl. the R1
  cycle with a fake provider).
- `internal/state/state.go` (+test): optional `generation_spent_by`.
- `internal/contract/contract.go`: `BlockedGenerationSpent` (`generation_spent`).
- `internal/config/config.go` (+test): `dedicated` section (`parseDedicated`, `parsePool`), clearer
  `measured_boot` refusal.
- `internal/enroll/enroll.go` (+test): `TokenFile` (R1 boot enrollment), spent-generation refusal,
  `active` message, source-neutral token errors.
- `internal/reset/` (new): R2 `Attestor`, `Quote`, `Detect` (refuses) + tests.
- `internal/hostnet/tap_linux.go`: `IP.CreateVeth`, `IP.Path`.
- `internal/fakeplatform/fakeplatform.go`: `AddRebuildToken` (R1 auto-approval model).
- `internal/driver/driver.go`: package doc.
- `cmd/kete-job-host/`: `newDriver` builds dedicated, `hidden` (`__dedicated-init`), doctor
  `driverChecks` split (`firecrackerChecks`, `hostChecks`, dedicated checks), `--token-file`;
  `main_test.go` expectation for dedicated.
- `internal/kvmtest/dedicated_test.go` (new): `TestDedicatedRealJob`, `TestDedicatedLifecycle`,
  TestMain reaper dispatch; `scripts/kvm-test.sh` runs `TestDedicated*` without KVM artifacts.
- `packaging/kete-job-host-enroll.service` (new), `packaging/install.sh` (`--driver dedicated`),
  `packaging/kete-job-host.service` (comments).
- `README.md`: status, config, files, commands, "Dedicated driver", "Dedicated hosts", install, tests.
- `.github/workflows/kete-job-host.yml`: `iproute2`, header.
- `docs/context/`: `modules/job-host.md`, `contracts.md` §6f, `commands.md`, `INDEX.md`.

## Checks
| Check | Result |
|---|---|
| gofmt, `go vet ./...`, `-tags kvm`, `GOOS=darwin` (Docker golang:1.26-bookworm, default context) | pass |
| `go test -race ./...` (Docker `--privileged`, nftables + iproute2) | pass (6 full runs; one earlier run had a `TestHangingDriver` timing flake, see handoff) |
| `go test -race -count=25 ./internal/agent/` | pass |
| dedicated driver tests static (`CGO_ENABLED=0`) and race (dynamic, libs copied) | pass |
| kvmtest `TestDedicatedRealJob` (aarch64, job image built from this checkout) | pass: `setup_host` … `host_boundary` … `isolation`, `claim` … `finish ok`; second assignment `starts_blocked`; no residue (14 s) |
| kvmtest `TestDedicatedLifecycle` | pass: probe only reaches TCP 443 + DNS to the resolver; restart re-adoption; deadline kill offline; table loss → `host_isolation_lost` + `host_table` (85 s) |
| `install.sh --driver dedicated` on kvmtest, `systemd-analyze verify` both units (then removed) | pass |
| actionlint `kete-job-host.yml` | pass |
| `bun run lint` | pass (0 warnings) |
| `bun run --cwd packages/kete-tools upstream:check` | pass |
| `node scripts/agent/card-check.mjs` | pass (27 cards) |
| firecracker KVM tests | not re-run (no Firecracker/kernel staged; firecracker code unchanged, unit tests pass) |

## Acceptance criteria
- [x] AC1 — `TestParseDedicatedSection`, `TestParseRefusals`, `TestConfigRefusesMeasuredBoot`; `run`
  refuses a dedicated config without resolvers (`TestRunRefusesWithoutDriver`).
- [x] AC2 — `TestDedicatedOneJobPerGeneration`, `TestDedicatedSpentOnlyByAStart`, `TestDedicatedReplayedSpender`,
  `TestDedicatedGenerationMismatch` (unchanged, passes).
- [x] AC3 — `TestDedicatedR1Cycle` (rebuild → auto-approved boot enrollment → job → spent → second
  refused → revoked/halt → rebuild → new identity runs a job; old identity `host_revoked`;
  mismatched generation stays `pending`).
- [x] AC4 — `TestTokenFile` (accepted, refused, network error kept + retry, malformed, loose mode,
  symlink), `TestEnrollRefusesSpentGeneration`.
- [x] AC5 — `internal/reset` `TestDetectRefuses`, `TestConfigRefusesMeasuredBoot`.
- [x] AC6 — `TestCgroupLimits`, `TestInitSpecValidate`, `TestJobRunsAndExits`,
  `TestOneAtATimeStopAndCrash`, `TestStartFailureCleansUp`, `TestReaperRefusesOutsideItsNamespace`.
- [x] AC7 — kvmtest runs above.
- [x] AC8 — checks above.

## Cards updated
- `job-host` (quick answers for the dedicated driver, the reaper, one job per generation,
  `generation_spent`, R1/R2; key files; rules; testing; changes; gotchas; stale line refs fixed),
  `contracts.md` §6f (pending `generation_spent`), `commands.md` (iproute2, dedicated real job),
  `INDEX.md`.

## Metrics
- Agents used: one build agent, reviewer.
- Scout lookups: 0 (cards read directly).
- Tokens / cost (from /usage): n/a.
- Time: ~3 h 30 min.
