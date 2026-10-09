# Result: Automated PR review — runtime side (`review_v1`)

## What changed
- `kete-job-entrypoint/internal/fakeplatform/testdata/jobs-v1/review.json` (byte copy) + `SHA256SUMS`; checksum test lists it.
- `util/src/kete/review.ts` (spec/output validators, record), `util/src/kete/job-secrets.ts` (review overlay).
- `cli/src/kete/job-spec.ts`, `job.ts`, `job-run.ts`, `job-standalone.ts`, `job-serve.ts` (spec section, job mode only, result `review`).
- `server/src/kete/job-server.ts` (review replacements: no spawn, no repository instructions).
- `core/src/kete/review-mode.ts` (tool, gates, prompt), `core/src/kete/job-plugin.ts` (install).
- Go: `internal/platform/review.go` (+ `ClaimFeatures`, `Claim.Review`), `internal/gitops/ops.go`/`gitops.go` (review fetch, merge base, diff, capped output), `internal/job/review.go` + `job.go` + `deps.go`, `internal/entry/entry_linux.go` (no tool socket), `internal/phaselog` (`review_diff`).
- Fake platform `review` knob + scripted scenario, `cmd/kete-job-fake-platform -scenario review`, e2e `TestReview`, `kete-job-image/scripts/e2e.sh`, `.github/workflows/kete-job-image.yml` paths.
- Docs: cards `job-entrypoint`, `job-mode`, `job-image`; `docs/context/contracts.md`; entrypoint README.
- Security-review round: review fetches fsck every object; boot step `git_version` (git ≥ 2.39.1) + image build check; `VerifyStorage` on the review path; review text redacted in the tool; server tests (j)/(k) for AGENTS.md; `fake-confine.ts` can seed files.
- No upstream file edited.

## Checks
| Check | Result |
|---|---|
| typecheck util/core/server/cli | ok |
| util, cli suites (`bun run test`) | 0 fail |
| core targeted (`review-mode`, `job-plugin`, `job-fs-sites`) | pass |
| server `job-mode.test.ts` (isolated script) | 8 pass |
| `go vet ./...` (darwin + GOOS=linux), `go test ./...` (darwin), `go vet -tags e2e ./internal/e2e/` | ok |
| root `bun run lint` | 0 warnings, 0 errors |
| `upstream:check` | passed |
| `verify --base main` | 1 new core failure (job-fs-sites: `util/src/kete/review.ts` unclassified) — fixed and re-run alone: pass; other packages 0 new failures; core's 30 pre-existing failures are on main too |
| CI (first push) | `kete-job-entrypoint/test` failed: two itests pinned the old claim feature list; fixed in 2433b163db, then all 8 checks green incl. `kete-job-image/e2e` (scenario `review` with the real kete: `TestReview` PASS) |
| Security-review fixes (second round) | `go vet` (darwin, linux, `integration`, `e2e` tags) + `go test ./...` ok; lint 0; core/server typecheck ok; server `job-mode.test.ts` 10 pass; core `review-mode.test.ts` 12 pass; `upstream:check` passed; `verify --base main`: 0 new failures in every package |

## Acceptance criteria
- [x] AC1 — `platform/review_test.go` `TestReviewClaimVector`/`TestReviewOutputVector`; `util/test/kete/review.test.ts`; `core/test/kete/review-mode.test.ts` (vector review through the tool).
- [x] AC2 — `TestReviewClaimVector` (ClaimFeatures has it, RuntimeClaimFeatures doesn't), `TestReviewRefusedByKubeVM`.
- [x] AC3 — `job/review_test.go` `TestReviewHeadMoved`, `TestReviewDeepensOnce` (moved between fetches).
- [x] AC4 — `review-mode.test.ts` (install gates, filterTools, applyPermission); server test (i) (no helper request with a socket); `TestReviewJob` (`KeteEnv.Review`, no tool hosts); e2e `review_shell_refused` (CI).
- [x] AC5 — `TestReviewJob`, `TestReviewResultBounded`, `platform` `TestBoundReview`; e2e `TestReview` (CI).
- [x] AC6 — `TestReviewJob`/`TestReviewContextText` (nonce delimiters, untrusted line); server tests (j)/(k): no root or subdirectory AGENTS.md reaches the model in review mode (session start and a read beside it); the control sends both.

## Cards updated
`job-entrypoint`, `job-mode`, `job-image` (Quick answers), `contracts.md`; `card-check` clean.
