# Result: Job entrypoint: Harness Code clones (jobs-v1 additive fields, clone-done revoke)

## Release order (read first)
This entrypoint must **not** ship in a release (a job image digest) before kete-code-platform PR
kete-org/ketecode-portal#68 is deployed: it always sends `features` in the claim request, and older
platforms reject unknown claim fields (`strictObject`), so every job would fail at claim.

## What changed
- `packages/kete-job-entrypoint/internal/platform/claim.go` — `clone.provider` (absent = github;
  unknown or `null` refused) and `clone.username` (absent = `x-access-token`; printable, no `:`,
  ≤ 128); `CloneAPIHost` (GitHub only); storage-host check against the clone host only for Harness.
- `internal/platform/platform.go` — claim body `{claim_token, features: ["clone_revoke_callback"]}`;
  `CloneDone` (≤ 3 tries, 5xx/network retried, 404 = gone); `RevokeURL` documented GitHub-only.
- `internal/gitops/{gitops,ops}.go` — `BasicHeader(username, token)`; `Scrub(stderr, username, …)`
  redacts the token, `base64(username:token)` (claim's and default username) and Authorization lines;
  `Clone` takes the username.
- `internal/job/{job,deps}.go` — Harness: `clone-done` instead of the revoke, and via `failClone`
  on a refused branch, clone failure and verify failure (HEAD ≠ `base_sha`) before finalising;
  GitHub: revoke, then `clone-done` best effort; clone allowlist from `CloneAPIHost`.
- `internal/phaselog/phaselog.go` — step `clone_done`.
- `internal/fakeplatform/{fakeplatform,sync}.go` — Harness-style git host (`git.harness.kete.test`,
  basic auth with the claim's username, no `/api`, refused after clone-done), `clone-done` route,
  claim `features`; `testdata/jobs-v1/claim-harness-code.json` (byte copy of the platform vector,
  `d282821`) + `SHA256SUMS`.
- Tests: platform, gitops, job, fakeplatform units; itest `TestHarnessCodeLifecycle`,
  `TestHarnessCodeWrongCommit`; lifecycle/e2e call orders include `clone-done`.
- `packages/kete-job-entrypoint/README.md` — steps 5–7, claim checks, hardened git, credentials,
  test list, not-verified list.
- `docs/platform/jobs-v1.md` — the platform's 2026-10-05 hunks applied byte for byte with `patch`
  (clean). The copy was already not byte-identical overall (earlier platform edits on 429/503 and
  upload expiry text never copied; there is no sync check in this repo), so only the additive
  hunks were applied; the header comment records the provenance.
- `docs/context/contracts.md` §6d/§6e, cards `job-entrypoint` (verified-at `e2f31003c6`), `egress`
  (allowlist text).

## Checks
| Check | Result |
|---|---|
| CI `kete-job-entrypoint` (gofmt, vet incl. integration/e2e tags, `go test -race ./...`, privileged integration suite) | pass — https://github.com/kete-org/ketecode/actions/runs/37295413332 (first run; `TestHarnessCodeLifecycle`, `TestHarnessCodeWrongCommit` PASS) |
| CI `kete-build` | pass — https://github.com/kete-org/ketecode/actions/runs/37295413309 |
| CI `kete-job-image` (image e2e with the real `kete`, call order now includes `clone-done`) | pass — https://github.com/kete-org/ketecode/actions/runs/37295413292 |
| `kete-egress` workflow | not triggered (`packages/kete-egress` unchanged) |
| root `bun run lint` | pass (0 warnings, 0 errors) |
| `bun run --cwd packages/kete-tools upstream:check` | pass (no upstream file touched) |
| `node scripts/agent/stale-cards.mjs`, `card-check.mjs` | pass |
| Local Go (gofmt/vet/test) | not run: no Go toolchain locally and too little disk for Colima; CI is the compiler |

## Acceptance criteria
- [x] AC1 — `TestValidateClaimProvider`.
- [x] AC2 — `TestClaimSuccessAndStatuses` (exact body), `TestHarnessCodeVector` (vector request).
- [x] AC3 — `TestBasicHeader` (vector `basic_authorization`), `TestScrubBasicValue`,
  `TestHarnessCloneFailed`, fakeplatform `TestHarnessVectorShape`.
- [x] AC4 — `TestLifecycle` (revoke, clone-done), `TestHarnessLifecycle`, `TestCloneDone`
  (success, 2×500 then 204, 3×500, 404, 409), `TestHarnessCloneDoneFails`, `TestHarnessCloneDoneGone`,
  `TestHarnessCloneFailed`, `TestHarnessWrongCommit`, `TestGitHubCloneDoneBestEffort`.
- [x] AC5 — `TestHarnessLifecycle` (allowlist exactly platform + clone host, no later phase),
  `TestValidateClaimProvider` (storage host vs clone host only).
- [x] AC6 — integration `TestHarnessCodeLifecycle` (vector-shaped claim, clone-done retried after
  a 500, no git-host API call, no git request after clone-done, no job user on the git host),
  `TestHarnessCodeWrongCommit`.
- [x] AC7 — `patch` applied the platform diff (`main...feature/harness-code-repos`) with no rejects.

## Decisions
- GitHub jobs call `clone-done` only on the success path (after the revoke), as the handover says;
  their failure paths are unchanged. A 404 from `clone-done` is "gone" for both providers.
- A `null` or non-string `clone.provider`/`clone.username` is refused, not defaulted.
- Harness `clone-done` also runs when the claim's branch is refused (a token was minted at claim).

## Cards updated
job-entrypoint, egress, contracts.md.

## Metrics
- Agents used: one build agent (no subagents)
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~1 h 15 min (1 CI round)
