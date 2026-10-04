# 0006. Runtimes pull jobs, with leases

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Autonomous jobs (Phase 7) are created on the platform — from the portal, a schedule or a trigger
such as a GitHub comment — and executed by a runtime (ADR 0005). The platform must get a job to a
runtime and learn its outcome. Today the runtime only polls the platform (sync every five minutes,
registration daily; `packages/core/src/kete/sync/plugin.ts`) and exposes no endpoint to it; enterprise
runtimes (§11, §64) sit behind firewalls and proxies that allow outbound traffic only.

## Decision

A runtime **pulls** work. A worker (`kete worker`) calls the platform to claim a job, receives a
**lease** with an expiry, renews it with heartbeats while it works, and reports the result, which
ends the lease. It never listens for inbound connections.

- A job whose lease expires without a result is released for another attempt, up to a retry limit
  set by the platform; each attempt is recorded.
- Work is idempotent per job: output goes to a branch named for the job (`kete/job-<id>`), so a
  retry updates the same branch instead of creating another.
- The contract (claim, heartbeat, complete, and the job spec) is defined in `kete-code-platform` as
  a versioned API (`/api/v1/jobs…`) and copied to `docs/platform/` here, like `sync-v1`.

## Consequences

- Works through enterprise firewalls and proxies; no public endpoint on any runtime.
- A dead sandbox costs at most one lease period before its job is retried.
- Latency: a job starts when a worker next claims; claim with long-polling rather than a fixed
  interval.
- The platform owns the queue, leases, retries and scheduling (control plane, CLAUDE.md §1); the
  runtime holds only the worker client.
