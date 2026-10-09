# Spec: Automated PR review — runtime side (`review_v1`)

- Task: `2026-10-10-review-v1` · Size: large · Created: 2026-10-09
- Status: approved (competitive program; coordinator brief)

## Goal
Let a cloud job review a GitHub pull request read-only and report line-anchored findings in the
result, so the platform (kete-code-platform, merged behind `KETE_FLAG_GITHUB_MENTIONS`, ADR 0028)
can post them. Platform handoff: `kete-code-platform/docs/tasks/2026-10-08-github-mentions-review/handoff.md`.

## Scope
- Contract mirror: `review.json` vector (byte copy + SHA256SUMS), Go and TS types/validators for
  `spec.review` and `result.review` matching `JobSpecReview` / `JobReviewOutput` / `parseJobReviewOutput`.
- Entrypoint (`job-entrypoint`): announce `review_v1`; strict review claim check; fetch
  `refs/pull/<n>/head` and the base, verify the pinned head (refuse a mismatch), merge base
  (deepen once, else refuse); diff + changed files in the prompt between nonce delimiters; no tool
  socket, no tool hosts; bound the result's review; no bundle, no push error.
- Runtime (`job-mode`): `kete job run` accepts `review` (job mode only) and reports the recorded
  review; server review mode (no spawn, no repository AGENTS.md as instructions); plugin review mode
  (only `read` + `review`, all else hidden/refused/denied, review system prompt); the `review` tool.
- Tests: vectors (Go + TS), entrypoint fakes, runtime tool tests, server wiring, job-image e2e scenario.

## Out of scope
- In-process search for review mode (grep/glob spawn ripgrep, a subprocess on the checkout; denied).
- `synchronize` reviews, posting (platform), kubevm review (not announced).

## Acceptance criteria
- [ ] AC1: the vector's claim parses (Go), its `result.review` validates and every `invalid_reviews` entry is refused (Go + TS).
- [ ] AC2: `review_v1` is announced only by the cloud entrypoint (which has review mode); kubevm refuses a spec with `review`.
- [ ] AC3: a head that isn't the pinned commit refuses the job (`refused`) before kete starts, token revoked.
- [ ] AC4: a review job never runs a tool that writes or executes: only `read`/`review` offered, others refused at execute.before, permissions denied, no spawn in the server even with a tool socket, no tool socket from the entrypoint.
- [ ] AC5: review claim → findings in `result.review`, bounded to the contract; invalid review left out with a note; no bundle, finish without push error.
- [ ] AC6: PR content is labelled untrusted in the prompt with per-job nonce delimiters; the repository's AGENTS.md is never loaded as instructions.

## Risks and constraints
Security: untrusted fork content (prompt injection, code execution) — mitigated by no-spawn at two
layers, tool allowlist, nonce delimiters, instructions off. Contract: strict shapes; the runtime cuts
rather than letting the platform drop a whole review. Upstream files: none edited.
