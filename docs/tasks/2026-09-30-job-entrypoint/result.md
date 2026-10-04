# Result: Cloud job entrypoint and image (pieces C+D)

## PR 1 (piece C) — #61
- `packages/kete-job-entrypoint/`: the root entrypoint (setup, egress firewall + proxy + helper before claim, claim with re-exec token hygiene, hardened pristine clone + separate agent copy, `kete job run` as the `kete` user with the clamped timeout and heartbeats, proxy supervision and restarts between phases with no job process alive, helper-first kill and `/proc` scan, result, O_NOFOLLOW bundle reader, uploads pinned to `KETE_JOB_STORAGE_HOST`, finish, hard deadline).
- `kete job run` in job mode uses the prepared worktree (no git calls); the root helper resets a tool's `oom_score_adj` to 0.
- Checks: 12 unit packages (race); integration 13/13 (+3 subtests) ×3 locally and re-run by the coordinator; `kete-job-entrypoint.yml` on `ubuntu-latest` 16/16 PASS (second run — the first failed on an unquoted colon in a step name, caught by actionlint afterwards); helper 15/15; cli/server job-run tests; lint; upstream:check.
- Security review: approve; all minors fixed (no restart while processes alive, pinned storage host, helper-first deadline kill, deadline-aware hashing, decimal limits, stronger credential test, error classes, nits).
- Interim gap until piece A: the gateway key reaches `kete` by environment variable. *(Since closed by piece A1: the key now arrives on fd 3 and no credential is in any child's environment; see the `job-entrypoint` card.)*

## PR 2 (piece D)
- `packages/kete-job-image/`: Debian image (entrypoint, root helper, egress proxy, Linux `kete`; distro git, ripgrep, nftables, Node/npm, Python/pip), `test/Dockerfile.e2e` (fake platform, e2e asserter, cargo; never pushed), `scripts/build.sh`, `scripts/e2e.sh`.
- Fake platform (`internal/fakeplatform`, `cmd/kete-job-fake-platform`): sync, skill files, models, me with the job key; fake Anthropic gateway checking `x-api-key` and the agent headers; `internal/e2e` asserts no-agent, lifecycle and AC5.
- Entrypoint: `KETE_DISABLE_MODELS_FETCH=1` for `kete` (N1; contracts §6d). No `spec.agent` check (N2).
- Workflows: `kete-job-image.yml` (path-filtered build + e2e); `kete-release.yml` `image` job pushes the tested image to GHCR on `kete-v*` tags after build, smoke and extension; `publish` records the digest.
- Found and fixed along the way (user-approved): kete-egress `crate_download` shape (cargo's `/crates/<name>/<ver>/download`; versions must start alphanumeric); root helper half-closes after EXIT and lingers ≤5 s for late CREDIT frames — an outright close let a Bun client's late write hit EPIPE and drop the unread output tail and EXIT (~3% in a repro; seen once in AC5).
- Checks: Go gofmt/vet/race tests (entrypoint, egress, helper); integration 13/13; image build (arm64); e2e no-agent, lifecycle, ac5 all PASS with clean token scans; actionlint; lint; upstream:check. CI (amd64 build, e2e) runs on the PR.
- Security review: approve; three minors fixed (image job waits for the extension job; CI credential cleanup no longer `|| true`; no `.`/`..` crate versions).
- AC1 (real `kete`), AC5, AC6: met (CI pending at write-up).
