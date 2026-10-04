# Plan: Job entrypoint: fail closed on Fly guards; in-VM isolation check

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->
<!-- Autonomous mode: planned and built in one pass by the same agent; this records what was done. -->

## Cards read
- docs/context/modules/job-entrypoint.md (verified-at 34a10660f8, stale: no)
- docs/context/modules/egress.md (the nft ruleset: tool_out allows only 127.0.0.1:82 and loopback >= 1024; everything else rejects)

## Files
| File | Read / change | Why |
|---|---|---|
| `internal/setup/setup.go`, `setup_linux.go` | change | `LockFly(dir, onFly)`, `ErrFlyAPIMissing`, `FlyAPISockets`, socket lock |
| `internal/bootenv/bootenv.go` | change | `Values.OnFly` from `FlyVars`, kept across the handover |
| `internal/isolation/` (new) | add | probe list (`Build`, `FlyProbes`), `Check` with an injectable `Net`, `/proc/net/unix` parser, `Run` (launch as the tool user), `RunProbe`, `Listen` (control) |
| `internal/phaselog/phaselog.go` | change | `StepIsolation`, the reason codes |
| `internal/job/deps.go`, `job.go` | change | `Machine.CheckIsolation`, run after the helper, before claim |
| `internal/entry/entry_linux.go` | change | `flyGuard` (lock + tool-user probe), `machine.CheckIsolation` (inputs, probe leaf cgroup) |
| `internal/layout/layout.go` | change | `ProbeTimeout` |
| `cmd/kete-job-entrypoint/main.go`, `internal/itest/main_test.go` | change | dispatch `__isolation_probe` |
| `internal/launch/*`, `internal/cgroup/*`, kete-root-helper cgroup/launch | read | how the helper runs a tool; the tool cgroup holds no process directly |
| tests: `isolation_test.go`, `setup_linux_test.go`, `bootenv_test.go`, `job_test.go`, `itest/isolation_test.go` | add/change | unit fakes and integration scenarios |
| `README.md`, card, `contracts.md` §6d | change | docs and runbook |

## Steps
1. Fly guard fail-closed + socket lock + OnFly detection.
2. Isolation package and probe; wire into entry and job.
3. Unit tests (fakes), integration scenarios, docs.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1-AC3 (unit) | `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'` |
| AC1-AC4 (integration) | `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh` |
| AC5 | `node scripts/agent/card-check.mjs`; `bun run lint`; `bun run --cwd packages/kete-tools upstream:check` |

## Cards to update after the build
- docs/context/modules/job-entrypoint.md; docs/context/contracts.md §6d
