# Plan: shared-kernel guard for the job entrypoint

## Cards read
- docs/context/modules/job-entrypoint.md, job-host.md, job-image.md

## Files
| File | Read / change | Why |
|---|---|---|
| packages/kete-job-entrypoint/internal/hostprofile/kernel.go | new | rules, constants, parsers |
| packages/kete-job-entrypoint/internal/hostprofile/hostprofile.go | change | `Signals.Kernel`, `Check` |
| packages/kete-job-entrypoint/internal/hostprofile/signals_linux.go | change | `GatherKernel` |
| packages/kete-job-entrypoint/internal/layout/layout.go | change | guard inputs |
| packages/kete-job-entrypoint/internal/entry/entry_linux.go | change | order; gather for non-fly |
| packages/kete-job-entrypoint/internal/guestinit/init_linux.go | change | `ownKernel` in both stages |
| packages/kete-job-entrypoint/internal/phaselog/phaselog.go | change | code, step |
| packages/kete-job-entrypoint/internal/{hostprofile,itest,e2e}/*_test.go | change/new | AC1-AC4, AC6 |
| packages/kete-job-host/internal/driver/dedicated/{dedicated.go,driver_linux_test.go} | change | AC5 |
| packages/kete-job-image/scripts/e2e.sh | change | stand-in reaper |
| READMEs, cards, contracts.md | change | docs |

## Steps
1. Pure rules and parsers + unit tests; 2. Linux gatherer + test; 3. wire into entry and
guestinit; 4. itest fakes and the real-path refusal test; 5. e2e stand-in reaper; 6. job-host
reaper facts test; 7. docs.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `go test ./internal/hostprofile/` (entrypoint) |
| AC2 | CI `go test -race ./...` (linux) |
| AC3 | review of `entry.Main`, `guestinit.Stage1/Stage2` |
| AC4 | CI kete-job-entrypoint integration (`scripts/integration.sh`) |
| AC5 | CI kete-job-host `sudo go test -race ./...` |
| AC6 | CI kete-job-entrypoint, kete-job-host, kete-job-image |

## Cards to update after the build
- job-entrypoint, job-host (verified-at)
