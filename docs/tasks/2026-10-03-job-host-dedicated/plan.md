# Plan: Self-hosted job hosts P5: dedicated driver and reset verification (agent side)

## Cards read
- docs/context/modules/job-host.md (verified-at 38ca312eb2, stale: no)
- docs/context/modules/job-entrypoint.md (host profiles, kete-job-init, cgroup setup)

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/kete-job-host/internal/config/config.go` (+ test) | change | `dedicated` section, refusals |
| `packages/kete-job-host/internal/contract/contract.go` | change | `BlockedGenerationSpent` |
| `packages/kete-job-host/internal/state/state.go` (+ test) | change | `generation_spent_by` |
| `packages/kete-job-host/internal/agent/agent.go` | change | spend at start, refuse, report |
| `packages/kete-job-host/internal/agent/dedicated_test.go` | new | AC2, AC3 |
| `packages/kete-job-host/internal/enroll/enroll.go` (+ test) | change | token file, spent refusal |
| `packages/kete-job-host/internal/fakeplatform/fakeplatform.go` | change | rebuild tokens |
| `packages/kete-job-host/internal/reset/` | new | R2 interface, refusal |
| `packages/kete-job-host/internal/hostnet/tap_linux.go` | change | veth into a netns |
| `packages/kete-job-host/internal/driver/dedicated/` | new | driver, reaper, loop/mount helpers, tests |
| `packages/kete-job-host/cmd/kete-job-host/*.go` | change | `__dedicated-init`, `newDriver`, doctor, `--token-file` |
| `packages/kete-job-host/internal/kvmtest/dedicated_test.go`, `scripts/kvm-test.sh` | new/change | AC7 |
| `packages/kete-job-host/packaging/*` | change/new | enroll unit, install |
| `packages/kete-job-host/README.md`, `docs/context/*` | change | docs |

## Steps
1. Contract/state/config changes with tests.
2. Agent spend logic + scenario tests (fake driver), enroll token file, fake platform rebuild
   tokens, R1 cycle test.
3. `internal/reset`.
4. Dedicated driver + reaper + unit tests (Docker, privileged).
5. CLI wiring, doctor, packaging.
6. kvmtest dedicated real job on Colima `kvmtest`.
7. Docs, cards, result, handoff (platform requirements), metrics.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1, AC4, AC5 | `go test ./internal/config/ ./internal/enroll/ ./internal/reset/` (Docker, root) |
| AC2, AC3 | `go test -race -run 'Dedicated|R1' ./internal/agent/` |
| AC6 | `go test ./internal/driver/dedicated/` (Docker `--privileged`) |
| AC7 | `colima ssh -p kvmtest -- sudo scripts/kvm-test.sh <dir> TestDedicated` |
| AC8 | the job-host Docker command in `docs/context/commands.md`; actionlint; `bun run lint`; `upstream:check`; `card-check` |

## Cards to update after the build
- job-host (dedicated driver, reset, generation spent), contracts.md §6f, commands.md (kvm-test).
