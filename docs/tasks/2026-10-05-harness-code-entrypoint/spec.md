# Spec: Job entrypoint: Harness Code clones (jobs-v1 additive fields, clone-done revoke)

- Task: `docs/tasks/2026-10-05-harness-code-entrypoint` · Size: medium · Created: 2026-10-05
- Status: built <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Cloud jobs can clone repositories hosted on Harness Code: the entrypoint authenticates with the
claim's username and releases the clone token through the platform's `clone-done` callback, never
through the git host's API. This is the runtime half of kete-code-platform ADR 0024 (platform PR
kete-org/ketecode-portal#68, spec items 10–16, "Runtime handover" in its result.md).

## Scope
Module `job-entrypoint` (`packages/kete-job-entrypoint`); the contract copy
`docs/platform/jobs-v1.md`; cards `job-entrypoint`, `egress` (allowlist text only; `kete-egress`
itself is unchanged), `contracts.md`.

1. `internal/platform/claim.go`: optional `clone.provider` (absent → `github`; anything else but
   `github`/`harness_code` refused as `clone.provider`) and `clone.username` (absent →
   `x-access-token`; printable, no `:`, ≤ 128, else `clone.username`).
2. Claim body `{"claim_token": …, "features": ["clone_revoke_callback"]}`.
3. `internal/gitops`: `BasicHeader(username, token)`; `Scrub` redacts the token, base64
   (`username:token`) and any `Authorization` line.
4. Revocation: `github` unchanged revoke, then `clone-done` best effort; `harness_code` no request
   to the git host's API, `POST {platform_url}/api/v1/jobs/{id}/clone-done` (Bearer callback
   token, `{}`, ≤ 3 tries with backoff), also on clone failure and HEAD ≠ `base_sha`, before
   finalising. `RevokeURL` only for github.
5. Egress (`afterClaim`): Harness clone-phase allowlist exactly `{platformHost, cloneHost}`; the
   storage-host check compares with the clone host only; no later phase reaches the git host.
6. `internal/fakeplatform`: Harness-style git host and the `clone-done` route; unit tests; the
   integration suite runs a full `harness_code` job in the shared test vector's shape.
7. `docs/platform/jobs-v1.md`: the platform's additive edits, byte for byte.

## Out of scope
The platform side (#68); the `kete-egress` binary; real Harness verification (platform staging
list); the job image (it picks the change up from this module).

## Acceptance criteria
- [x] AC1: claim parsing accepts absent/`github`/`harness_code` and valid usernames, refuses an
  unknown or `null` provider and a bad username with the field name.
- [x] AC2: the claim request body is exactly `{"claim_token":…,"features":["clone_revoke_callback"]}`
  and matches the shared vector's request.
- [x] AC3: the clone header for the vector's username and token equals the vector's
  `basic_authorization`; `Scrub` output holds no token, base64 value or Authorization line.
- [x] AC4: revocation paths: GitHub revoke then clone-done; Harness clone-done only (success,
  retries after 5xx, 404 = gone, failure noted on the job), and clone-done before the result on
  clone failure and HEAD mismatch.
- [x] AC5: Harness clone-phase allowlist is `{platform, clone host}`; no agent/report allowlist
  holds the git host; storage-host check uses the clone host only.
- [x] AC6: the integration suite completes a `harness_code` job against the fake (no git-host API
  call, clone-done before the agent phase) and a HEAD-mismatch job.
- [x] AC7: `docs/platform/jobs-v1.md` carries the platform's hunks byte for byte.

## Risks and constraints
- **Contract / release order:** platforms before #68 reject the unknown `features` field
  (`strictObject`), so an image with this entrypoint must not be released before #68 is deployed.
- **Security:** the Harness token must never reach the git host's API from the job; the clone
  phase allowlist is narrowed accordingly. Scrubbing covers the basic-auth encoding.
