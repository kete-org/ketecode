# Result: Self-hosted job hosts P1: entrypoint host profiles, host-boundary probe, kete-job-init, multi-arch signed image

## What changed
- `packages/kete-job-entrypoint/internal/hostprofile/` (new): profiles, `Resolve`, `Check`, DMI provider table, boundary/isolation targets, `DefaultGateways`, `MetadataDropRuleset`; Linux `Gather`, `BlockDevices`, `FindConfigDisk`; tests.
- `internal/bootenv/`: `KETE_JOB_HOST_PROFILE`, `Config` (strict config-pipe JSON), `FromEnv`/`FromConfig`, handover fields, `ReadConfigFD` (FIFO only), fd ≥ 3 handover; `config_test.go`.
- `cmd/kete-job-entrypoint/main.go`: `--config-fd <n>`.
- `internal/entry/entry_linux.go`: `setup_host`, `host_boundary`, per-profile isolation inputs.
- `internal/isolation/`: `OffFly`, `Extra`, kind `file`, extended `Priority`; `profile_test.go`; fake gains `OpenFile`.
- `internal/phaselog/`: steps `setup_host`, `host_boundary`, `init_*`; new codes; `Exited`.
- `internal/layout/`: `InitBin` and signal paths.
- `internal/guestinit/`, `cmd/kete-job-init/` (new): kete-job-init (stage 1/2, `Run` over `Deps`, config disk, user-data readers for gcp/digitalocean/hetzner/oci, metadata drop, reap, power) and tests.
- `internal/itest/`: `defaultProfile` harness, `profiles_test.go` (6 new top-level tests), TestBinaryBoot given a Fly signal.
- `cmd/kete-job-fake-platform/main.go`: writes `config.json`.
- `packages/kete-job-image/`: Dockerfile (kete-job-init), `build.sh` (init, `--platform`), `e2e.sh` (dedicated over stdin pipe, host-side nft table), README.
- `.github/workflows/kete-release.yml`: amd64 + arm64 images, QEMU, index, cosign keyless sign + verify (tags), `kete-job-image.digests`; `kete-job-image.yml`: deletes `config.json` on failure.
- Docs: entrypoint README (Machine configuration, Host profiles, kete-job-init, tests, not-verified), `docs/release.md`, contracts §6d, cards job-entrypoint / job-image / kete-tools-ci, metrics row.

## Checks
| Check | Result |
|---|---|
| gofmt, go vet (plain, integration, e2e tags), `go test -race ./...` (golang:1.26-bookworm) | pass |
| Integration suite (privileged, `scripts/integration.sh`) | 28/28 top-level tests pass (22 existing + 6 new) |
| Image: `build.sh` (arm64, Colima) + `e2e.sh kete-job:local --scenario all` | pass (no-agent, lifecycle, ac5; `setup_host`, `host_boundary`, `isolation` ok as dedicated) |
| actionlint (kete-release, kete-job-image, kete-job-entrypoint workflows) | pass |
| `bun run lint` | pass |
| `upstream:check` | pass (no upstream file touched) |
| `card-check` | pass |
| Release workflow run (manual dispatch / tag) | not run: needs GitHub; push/sign/verify runs only on a tag |

## Acceptance criteria
- [x] AC1 — all pre-existing unit and integration tests and the e2e pass; launch changes forced by rule 16 listed in handoff D14.
- [x] AC2 — `hostprofile` `TestResolve`, `TestCheckMatrix`; `bootenv` `TestFromEnv`, `TestFromConfig`, `TestParseConfig`.
- [x] AC3 — `TestBinaryBootDedicated(Stdin)`, `TestProfileMismatch`, `TestHostBoundaryMicrovm` (gateway, RFC 1918, CGNAT, metadata, IPv6, config disk), `TestCloudvmMetadataDrop`.
- [x] AC4 — `guestinit` `TestParseConfigDisk`, `TestUserDataReaders`, `TestUserDataFailures`, `TestRunMicroVM`, `TestRunCloudVM`, `TestRunFailures`, `TestReap`.
- [x] AC5 — image build + e2e all scenarios.
- [~] AC6 — workflow written, SHA-pinned, actionlint clean; not yet executed on GitHub (first tag run).
- [x] AC7 — docs, cards, contracts; card-check, lint, upstream:check.

## Cards updated
job-entrypoint, job-image, kete-tools-ci, contracts.md §6d (no "Docs enough: no" gaps: no scout used).

## Metrics
- Agents used: one build agent, no subagents
- Scout lookups: 0
- Tokens / cost: n/a
- Time: ~3 h

## Security review fixes (2026-10-03)
Panic recovery in init (`Run`, both stages; `panic=1` as a P4 requirement), `host_boundary` refuses
no default gateway, the release image job split into a read-only `image` and a tag-only
`image-publish` (artifact + checksum), arm64 "QEMU smoke only" stated in notes and
`.digests`, the amd64 digest's form documented, the metadata drop verified by content
(`VerifyMetadataDrop`), the P6 note on private samples. Re-run checks: unit (gofmt, vet ×3, race)
pass; integration 28/28; e2e all scenarios pass; actionlint, lint, upstream:check, card-check pass.
New tests: `TestRunPanic`, `TestVerifyMetadataDrop`, `TestHostBoundaryMicrovm/no default gateway`,
tampered-table step in `TestCloudvmMetadataDrop`.
