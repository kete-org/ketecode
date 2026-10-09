# Plan: Automated PR review — runtime side (`review_v1`)

Built in one session by the builder (no separate planner); the steps as done:

1. Vector: copy `review.json` byte for byte into `kete-job-entrypoint/internal/fakeplatform/testdata/jobs-v1/`, regenerate `SHA256SUMS`, add it to `TestJobsVectorsChecksums`.
2. TS contract: `packages/util/src/kete/review.ts` (spec, output, record) + `job-secrets.ts` overlay; tests `util/test/kete/review.test.ts`.
3. CLI: `job-spec.ts` (`review` key), `job.ts` (job mode only, stale record removed, secrets message, `readReview`), `job-run.ts` (`withReview`), `job-standalone.ts`/`job-serve.ts` (message field).
4. Server: `server/src/kete/job-server.ts` review replacements; test (i) in `server/test/kete/job-mode.test.ts`.
5. Core: `core/src/kete/review-mode.ts` + `job-plugin.ts` install; `core/test/kete/review-mode.test.ts`.
6. Go platform: `internal/platform/review.go` (+ `ClaimFeatures`, `Claim.Review`); tests.
7. Go gitops: `ReviewClone`, `ReviewDeepen`, `MergeBase`, `Diff`, `Call.MaxStdout` + partial output on overflow; argv and real-git tests.
8. Go job: `internal/job/review.go`, wiring in `job.go`, `KeteEnv.Review`, `entry_linux.go` env; `job/review_test.go`.
9. Fake platform + e2e: `Knobs.Review`, `refs/pull/7/head`, scripted `review` scenario, `TestReview`, `e2e.sh`, workflow paths.
10. Docs: cards (`job-entrypoint`, `job-mode`, `job-image`), `contracts.md`, entrypoint README.

Verify: package typechecks/tests, `go vet`/`go test ./...` (darwin + `GOOS=linux go vet`), root lint, `upstream:check`, `verify --base main`, CI (incl. `kete-job-image` e2e).
