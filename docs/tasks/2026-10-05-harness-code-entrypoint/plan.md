# Plan: Job entrypoint: Harness Code clones (jobs-v1 additive fields, clone-done revoke)

<!-- Brief: one build agent followed the platform's runtime handover directly. -->

## Cards read
- docs/context/modules/job-entrypoint.md (verified-at 372482f656, stale: no)
- docs/context/modules/egress.md (verified-at 6d8972321a, stale: no)
- kete-code-platform: ADR 0024, `docs/tasks/2026-10-05-harness-code-repos/{spec,result,handoff}.md`,
  `docs/contracts/jobs-v1.md` (diff vs main), `docs/contracts/test-vectors/jobs-v1/claim-harness-code.json`

## Files
| File | Read / change | Why |
|---|---|---|
| `internal/platform/claim.go` | change | `clone.provider`/`clone.username`, `CloneAPIHost`, storage-host check |
| `internal/platform/platform.go` | change | claim `features`, `CloneDone` |
| `internal/gitops/{gitops,ops}.go` | change | `BasicHeader(username, token)`, `Scrub(stderr, username, …)`, `Clone` username |
| `internal/job/{job,deps}.go` | change | revocation per provider, `failClone`, clone allowlist |
| `internal/phaselog/phaselog.go` | change | step `clone_done` |
| `internal/fakeplatform/{fakeplatform,sync}.go`, `testdata/jobs-v1/` | change | Harness git host, `clone-done`, features, vector copy + SHA256SUMS |
| `*_test.go` (platform, gitops, job, fakeplatform, itest, e2e) | change | tests below |
| `README.md`, `docs/platform/jobs-v1.md`, `docs/context/contracts.md`, cards | change | contract docs |

## Steps
1. Claim parsing and validation (raw JSON so `null`/non-strings are refused, not defaulted).
2. Claim request body with `features`; `CloneDone` via the existing `expect` (≤ 3 tries, 5xx and
   network retried, 404 → `ErrGone`, other 4xx not retried).
3. gitops header and scrub; `Clone` takes the username.
4. `afterClaim`: allowlist from `CloneAPIHost` (empty for Harness); Harness → `cloneDone` instead of
   `Revoke`; GitHub → `Revoke` then best-effort `cloneDone`; `failClone` on CheckBranch, clone and
   verify failures (Harness calls clone-done first).
5. Fake platform and tests; apply the platform's contract diff with `patch`.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1–AC5 | CI `kete-job-entrypoint.yml` unit step: `go test -race ./...` (`TestValidateClaimProvider`, `TestClaimSuccessAndStatuses`, `TestHarnessCodeVector`, `TestCloneDone`, `TestBasicHeader`, `TestScrubBasicValue`, `TestHarness*`, `TestGitHubCloneDoneBestEffort`, fakeplatform `TestHarness*`) |
| AC6 | CI integration step: `scripts/integration.sh` (`TestHarnessCodeLifecycle`, `TestHarnessCodeWrongCommit`) |
| AC7 | `patch` applied the platform's hunks cleanly (no rejects) |
| all | root `bun run lint`, `bun run --cwd packages/kete-tools upstream:check`, `node scripts/agent/stale-cards.mjs`, `node scripts/agent/card-check.mjs` |

## Cards to update after the build
- job-entrypoint, egress, contracts.md §6d/§6e
