# 0007. Jobs use short-lived, job-scoped credentials

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

An autonomous job needs to reach the platform (claim, heartbeat, report), the model gateway, and
usually git hosting. The only runtime credential today is a user's Kete API key from `kete login`
(PKCE in a browser; `packages/cli/src/kete/cli-login.ts`), stored in the OS credential store. A
sandbox has no browser and no user, and a long-lived user key inside a container would outlive the
job and act as the user everywhere.

## Decision

Each job runs with credentials issued by the platform **for that job**:

- A job token, scoped to that job's platform calls and its gateway usage (attributed to the job and
  its agent, and bounded by the job's budget), and expiring when the job's lease ends.
- Git credentials, when the job needs them, as short-lived tokens for the one repository it works on
  (for GitHub, an installation token of the Kete GitHub App), provided through a credential helper,
  never written to the repository or logs.
- A user's own `kete login` key is never copied into a sandbox.

The runtime accepts the job token non-interactively (environment variable or file provided by the
orchestrator), keeps it in memory, and redacts it from logs, errors and model context (CLAUDE.md §9).

## Consequences

- A leaked token is useful only for one job, for its lifetime.
- Usage and cost are attributed per job.
- The platform needs token issuance, scoping and revocation — control-plane work, with its own
  contract.
- Local `kete job run` (no sandbox) uses the signed-in user's account, as the CLI does today.
