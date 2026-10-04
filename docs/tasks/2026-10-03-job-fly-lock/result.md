# Result: Job entrypoint: fail closed on Fly guards; in-VM isolation check

## What changed
All in `packages/kete-job-entrypoint/` (Kete-owned; no upstream file touched) plus docs.
- `internal/setup/setup.go`, `setup_linux.go` — `LockFly(dir, onFly)` fails closed
  (`ErrFlyAPIMissing` when on Fly and `/.fly` or `/.fly/api` is missing; a `/.fly` without `api`
  counts as on Fly), locks `/.fly/api` root 0600 under the root 0700 dir, refuses a non-socket or
  symlink; `FlyAPISockets`, `FlySocketPaths`.
- `internal/bootenv/bootenv.go` — `Values.OnFly` from Fly's `FLY_*` variables (`FlyVars`), kept
  across the handover; values never read.
- `internal/isolation/` (new) — `isolation.go` (probe list `Build`/`FlyProbes`, `Check` over a
  `Net` interface with per-attempt and overall bounds, priority of reasons, `/proc/net/unix`
  parser, request/answer codecs, `LogFailure`), `probe_linux.go` (`SysNet`, `RunProbe`, `Run`
  launching the probe as the tool user, control `Listen`).
- `internal/phaselog/phaselog.go` — step `isolation`; codes `fly_api`, `helper_socket`,
  `unix_socket`, `kete_dir`, `metadata`, `sixpn`, `resolver`, `loopback`, `control`, `probe`.
- `internal/job/deps.go`, `job.go` — `Machine.CheckIsolation`, run after the helper and before
  claim; failure exits 1 with no callback.
- `internal/entry/entry_linux.go` — `flyGuard` (lock, then a tool-user probe of `/.fly/api`);
  `machine.CheckIsolation` (inputs from `/proc/net/unix`, interface addresses, resolvers; probe in
  a leaf `<tool>/isolation`, removed after).
- `internal/layout/layout.go` — `ProbeTimeout` (20 s).
- `cmd/kete-job-entrypoint/main.go`, `internal/itest/main_test.go` — dispatch
  `__isolation_probe`; `bootHook` for tests.
- Tests: `internal/isolation/isolation_test.go` (new, fakes), `internal/setup/setup_linux_test.go`
  (new, root), `bootenv_test.go` (`TestOnFly`), `job_test.go` (`TestRefuseClaimWithoutIsolation`),
  `internal/itest/isolation_test.go` (new, 8 integration tests).
- `README.md` — machine configuration note, steps 2 and 4, "Fly guard and isolation check"
  section, test list, "Not verified", **staging runbook**.
- `docs/context/modules/job-entrypoint.md`, `docs/context/contracts.md` §6d.

## Checks
| Check | Result |
|---|---|
| `gofmt -l .` (golang:1.26-bookworm) | clean |
| `go vet ./...`, `go vet -tags integration ./...` | pass |
| `go test -race ./...` | pass (14 packages with tests) |
| `scripts/integration.sh` (privileged, `--cgroupns=private`) | pass, 22/22 top-level tests (8 new) |
| `bun run lint` | 0 warnings, 0 errors |
| `bun run --cwd packages/kete-tools upstream:check` | passed (no upstream file in the diff) |
| `node scripts/agent/card-check.mjs` | clean |
| Image e2e (`packages/kete-job-image/scripts/e2e.sh`, real `kete`) | not run (see handoff) |
| `core`/`server` `bun run test` | not run: no TypeScript or engine package touched |

## Acceptance criteria
- [x] AC1 — `TestLockFlyAbsent`, `TestLockFlyMissingSocket`; integration `TestFlyGuardMissingAPISocket`
  (OnFly without `/.fly`, and `/.fly` without `api`, no Fly variable), `TestBinaryBootOnFly` (the
  real binary with `FLY_MACHINE_ID`): `setup_fly` `missing`, zero claims.
- [x] AC2 — `TestLockFlyLocks`; `TestFlyGuardLocks`: the real probe as the tool user reaches a
  world-open fake `/.fly/api` before the guard (`fly_api`), after it the dir is root 0700, the
  socket 0600, `setup_fly` and `isolation` ok, and the job completes.
- [x] AC3 — `isolation_test.go` (every reason, priority, control, dropped packets, deadline →
  `probe`, invalid requests → `probe`, parser, answers), `TestRefuseClaimWithoutIsolation`;
  integration `TestIsolationProbeDetects` (real probe, no firewall: loopback, kete dir, stray
  socket by path and abstract, Fly socket, resolver via the fake DNS, dead control),
  `TestIsolationStraySocket` (the finding: a world-connectable socket elsewhere stops the job at
  `isolation` `unix_socket` with no claim), `TestIsolationReadableKeteDir`.
- [x] AC4 — every existing integration scenario passes with the check in place;
  `TestIsolationFirewallRefuses` (root listeners on `127.0.0.1:700` and `[::1]:700` refused by the
  firewall); a full probe run took ~15-25 ms in the suite.
- [x] AC5 — README "Fly guard and isolation check" and "Staging runbook"; card quick answers,
  rules, testing and gotchas; contracts §6d.

## Cards updated
- `docs/context/modules/job-entrypoint.md` (README line map, step order, two new quick answers,
  runbook pointer, key files, rules, testing, changes, gotchas: the EBUSY tool-cgroup leaf and
  the fail-closed consequence of any world-connectable socket).
- `docs/context/contracts.md` §6d (Fly bit, pre-claim guard and check, codes).

## Metrics
- Agents used: reviewer (approve; 9 minors, 7 fixed, 2 documented — see handoff)
- Scout lookups: 0 (the card and README answered the lookups directly; read in-session)
- Tokens / cost (from /usage): n/a
- Time: ~2 h
