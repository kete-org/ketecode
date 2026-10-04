# Result: Self-hosted job hosts P2: kete-job-host agent core with a fake driver

## What changed
- `packages/kete-job-host/` (new Go module, `go 1.26.0` / `toolchain go1.26.8`, `golang.org/x/sys v0.48.0`):
  - `cmd/kete-job-host/` — `enroll`, `run` (refuses: no real driver until P4/P5), `doctor`, `fingerprint`, `version`; exit codes 0/1/2/3; host facts (`host_linux.go`).
  - `internal/contract` — job-host-v1 wire types, limits, validation.
  - `internal/sig` — RFC 9421 signer/verifier (fixed profile), RFC 9530 digest, key hygiene (small-order/non-canonical keys, S < L, dummy key), fingerprint.
  - `internal/seal` — HPKE open/seal via stdlib `crypto/hpke`, binding `info`, `JobMachineConfig` (strict + canonical), config disk.
  - `internal/keys`, `internal/fsutil` — keys as root `0600` files in `0700` dirs, atomic private writes, permission/owner/symlink checks.
  - `internal/config` — strict `/etc/kete-job-host/config.json` (origin, driver rules, allowlists, public IPv4 resolvers).
  - `internal/state` — durable `state.json` (no configuration, token or key).
  - `internal/client` — signed HTTPS client (TLS verify on, no proxy, no redirects, 15 s, 1 MiB), `APIError`, backoff.
  - `internal/clock` — NTP status via `adjtimex`.
  - `internal/agent` — poll/report loop, response discard rules, desired-state apply, assignment checks, state machine, deadline killer, restart reconcile, halts.
  - `internal/enroll` — enrollment.
  - `internal/driver` (+ `driver/fake`), `internal/image`, `internal/phase`, `internal/fakeplatform`, `internal/vectors`.
  - `testdata/job-host-v1/{signatures,hpke,config-disk}.json` (byte-for-byte copies) + `SHA256SUMS`.
  - `packaging/kete-job-host.service`, `README.md`, `.gitignore`.
- `.github/workflows/kete-job-host.yml` — path-filtered CI (gofmt, vet incl. darwin, `go test -race`, build).
- `docs/platform/job-host-v1.md` — contract copy (platform `04d406a`).
- `docs/context/`: new `modules/job-host.md`; `INDEX.md`, `repo-map.md`, `commands.md`, `contracts.md` §6f, `modules/kete-tools-ci.md`.
- `docs/tasks/2026-10-03-job-host-agent/` spec, plan, result, handoff; `docs/tasks/metrics.md` row.

## Checks
| Check | Result |
|---|---|
| `gofmt -l` (empty), `go vet ./...`, `GOOS=darwin go vet ./...` (golang:1.26-bookworm) | pass |
| `go test -race -count=1 ./...` (golang:1.26-bookworm, arm64 Colima) | pass, 13 packages |
| Vector copies vs the platform's files (`KETE_PLATFORM_VECTORS`) | pass (byte-identical) |
| Mutation check: logging the opened config makes `TestNoSecretsLeak` fail | confirmed, reverted |
| actionlint (`rhysd/actionlint`) on `kete-job-host.yml` | pass |
| `bun run lint` | pass (0 warnings, 0 errors) |
| `upstream:check` | pass (no upstream file touched; leak scan skipped: nothing committed) |
| `card-check` | pass (27 cards) |
| CI run on GitHub | not run (nothing pushed, per the brief) |

## Acceptance criteria
- [x] AC1 — `sig`: `TestVectorKeys`, `TestVectorSign` (both requests byte for byte), `TestVectorVerify`, `TestVectorRefusals` (16/16 with reasons), `TestReferenceRFC9421B26`, `TestReferenceRFC9530B1`; `seal`: `TestVectorOpen`, `TestVectorKeyDerivation`, `TestVectorRefusals` (7/7), `TestReferenceRFC9180A11`, `TestVectorConfigDisk`; `vectors`: `TestVectorsMatchChecksums`, `TestVectorsMatchPlatform`.
- [x] AC2 — `TestLifecycle` (real TLS against the fake platform).
- [x] AC3 — `TestAssignmentRefusals` (14 cases), `TestNoFreeSlot`, `TestDedicatedGenerationMismatch`.
- [x] AC4 — `TestReplayAndStale`, `TestClockAndNonce`, `TestPhaseLinesResentAfterLostResponse`.
- [x] AC5 — `TestHostStates` (disabled, revoked, generation mismatch, signature_invalid).
- [x] AC6 — `image.Unconfigured` (fail closed) in `cmdRun`; `TestAssignmentRefusals/signature verifier refuses`, `image` tests; decision in handoff.
- [x] AC7 — `TestRestartReconcile`, `TestDeadlineKiller`, `TestMachineExits`, `TestMachineCrashes`, `TestRunLoop`.
- [x] AC8 — `TestNoSecretsLeak` (logs, state file, every request body, enroll output; file modes) with positive controls.
- [x] AC9 — checks table above (GitHub CI run pending a push).

## Cards updated
New `job-host`; `kete-tools-ci` (workflow, fourth go.mod pin); INDEX, repo-map, commands, contracts §6f. No scout used, so no "Docs enough: no" gaps.

## Metrics
- Agents used: one build agent (no subagents)
- Scout lookups: 0
- Tokens / cost: n/a
- Time: ~3 h

## Security review fixes (2026-10-03)
- Enrollment stages new keys and installs keys, then state, only after a validated 201; failures
  keep the old identity (`TestReplaceKeepsOldIdentityOnFailure`, `keys.TestStaged`).
- `fsutil`: `O_NOFOLLOW|O_CLOEXEC` + fstat, uid 0 owner, root-owned non-writable ancestors
  (`fsutil` tests); tests run as root under `internal/testroot`; CI uses `sudo` for `go test`.
- `config.Load` requires a root-owned, non-group/other-writable regular file; `doctor` reports it
  (`config.TestLoadFileRules`, `TestDoctorReportsConfigFile`).
- Supervise starts before reconcile; reconcile retries with backoff (`TestKillerRunsWhileReconcileFails`).
- Per-call driver timeouts, one worker per machine, no lock across driver calls; driver contract
  documented (`TestHangingDriver`, `TestHangingStart`).
- Durable halt at startup destroys every machine (`TestHaltedAtStartupDestroysAll`).
- Workflow checkout `persist-credentials: false`.
- E9 kept and documented (halted with machines → no reports until they end).
- New/changed files: `internal/fsutil/{fsutil,fsutil_test}.go`, `internal/testroot/testroot.go`,
  `internal/keys/{keys,keys_test}.go`, `internal/enroll/{enroll,enroll_test}.go`,
  `internal/config/{config,config_test}.go`, `internal/agent/{agent,harness_test,scenario_test,robustness_test}.go`,
  `internal/driver/{driver.go,fake/fake.go}`, `internal/state/state_test.go`,
  `cmd/kete-job-host/{main,main_test}.go`, `README.md`, `.github/workflows/kete-job-host.yml`,
  cards `job-host`, `kete-tools-ci`, `commands.md`.

| Check (re-run) | Result |
|---|---|
| gofmt, `go vet` (linux + darwin), `go test -race -count=1 ./...` (golang:1.26-bookworm, root) | pass, 14 packages |
| `go test -race -count=8` agent + enroll | pass |
| actionlint, `bun run lint`, `upstream:check`, `card-check` | pass |
