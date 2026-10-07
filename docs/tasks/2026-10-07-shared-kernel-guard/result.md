# Result: shared-kernel guard for the job entrypoint

PR: kete-org/ketecode#19 (not merged).

## What changed
- `packages/kete-job-entrypoint/internal/hostprofile/kernel.go`: guard rules (`OwnKernel`, `DedicatedReaper`), nsfs constants, `ParseArgs`, `RuntimeMountIn`.
- `hostprofile/hostprofile.go`: `Signals.Kernel`; `Check` refuses `shared_kernel`.
- `hostprofile/signals_linux.go`: `GatherKernel` (read-only, injectable namespace reader).
- `layout/layout.go`: guard inputs. `entry/entry_linux.go`: `setup_host` first, kernel facts for non-fly.
- `guestinit/init_linux.go`: `ownKernel` (step `init_kernel`) first in both stages.
- `phaselog`: code `shared_kernel`, step `init_kernel`.
- Tests: `kernel_test.go`, `signals_linux_test.go`, itest (`testConfig`/`guestTree` facts, `TestBinaryBootSharedKernel` replacing `TestBinaryBootDedicated[Stdin]`), `e2e/reaper_test.go` (stand-in reaper).
- `packages/kete-job-host`: `InitArg` comment; `TestJobRunsAndExits` checks the reaper's guard facts.
- `packages/kete-job-image/scripts/e2e.sh`: job container under the stand-in reaper.
- READMEs (entrypoint, image), cards (job-entrypoint, job-host, job-image), contracts.md.

## Checks
| Check | Result |
|---|---|
| local (macOS): `go test ./...` entrypoint; `go vet` with GOOS=linux and tags integration/e2e/kvm; job-host driver tests | pass |
| CI kete-job-entrypoint (unit -race, integration incl. TestBinaryBootSharedKernel) | pass |
| CI kete-job-host (tests as root, kernel-config ×4) | pass |
| CI kete-job-image e2e (no-agent, lifecycle, ac5 under the stand-in reaper) | pass |
| CI kete-build (build, kete-checks) | pass |
| card-check | no new problems (the 177 reported are files absent from the sparse checkout, same before the change) |

## Acceptance criteria
- [x] AC1: `kernel_test.go`, `hostprofile_test.go` matrix.
- [x] AC2: `TestGatherKernel` (CI, linux).
- [x] AC3: `entry.Main`, `guestinit.Stage1/Stage2`.
- [x] AC4: `TestBinaryBootSharedKernel` passed in CI (fd 3 and stdin).
- [x] AC5: kete-job-host `internal/driver/dedicated` passed in CI as root (the run is not verbose, so whether `needHost` skipped `TestJobRunsAndExits` is not shown in the log; the package took 6.8 s).
- [x] AC6: all triggered workflows green.

Not run: real dedicated host / Firecracker guest with the real image (`kvm-test.sh`).

## Review round (commits c377dd3136, 50ee2cb272)
- Fixed: fly presence check before any write; kete-job-host `internal/hostguard` in both drivers'
  `Init` and `doctor`; `initarg_test.go` coupling test (+ kete-job-host.yml path trigger); nits
  (ppid 1, PID 1 not self, `container=` in PID 1's environment, systemd markers, nsfs statfs,
  console before `init_kernel`).
- CI at 50ee2cb272: kete-build, kete-job-entrypoint (unit + integration incl.
  `TestFlyGuardMissingAPISocket`, `TestBinaryBootSharedKernel`), kete-job-host (incl. `hostguard`,
  `driver/dedicated`), kete-job-image e2e: all pass. A first run failed on the unprivileged unit
  test reading `/proc/1/environ` (permission denied as non-root); the test now reads its own
  environment when not root (the entrypoint runs as root).
- Still not run: fly's own guard (follow-up), real dedicated host / Firecracker (`kvm-test.sh`).
- Card `kete-tools-ci` is stale against `.github/workflows/kete-job-host.yml` (this PR) and two
  workflows changed before it; not updated here.
