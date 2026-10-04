# 0005. The cloud runtime runs whole inside the sandbox

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Phase 7 (`docs/architecture.md` §10, §62–63, §102) runs Kete in Kete-managed sandboxes. Two shapes
are possible:

1. **Runtime in the sandbox.** One container per job runs `kete` itself, with its database, the
   repository and git. The orchestrator (in `kete-code-platform`) starts and stops containers.
2. **Split.** The agent loop stays on a host and only command execution runs in the sandbox, which
   is what upstream OpenCode is building: `WorkspaceDriver` (`packages/core/src/workspace/driver.ts`)
   provisions a sandbox and `EnvironmentDriver` routes shell, file and stdio-MCP execution into it.

The split shape is incomplete upstream: no driver ships (the registry is empty), the HTTP API hides
`workspaceID`, and file browsing, snapshots and revert, git, the terminal and the persistent-pty
daemon still run on the host. Crash recovery (`packages/core/src/session/execution/restart.ts`)
assumes that every orphaned execution claim belongs to a dead process, which holds only when one
runtime owns its database.

## Decision

The Kete cloud runtime runs the whole runtime inside the sandbox: one container per job, from one
Kete runtime image (§63), with its own data directory and database. The same image is the
enterprise private runtime (§11). The runtime reports `runtime_type: "kete_cloud"` (or
`"enterprise_private"`) from configuration instead of the hard-coded `"local"`.

Upstream's `WorkspaceDriver` remains available for a later, separate mode (a laptop session whose
commands run in a cloud sandbox); this ADR doesn't adopt or block it.

## Consequences

- Isolation is the container's: nothing of one job's repository, database or credentials is on a
  shared host.
- Recovery stays correct: one runtime per database, so `SessionRestart`'s single-owner assumption
  holds; a restarted container resumes its own job.
- Every feature that works locally works in the cloud unchanged, including snapshots, revert, git
  and the terminal.
- Cost: a container per job (start-up time, image size). Revisit if jobs are short and frequent
  enough that start-up dominates.
- The runtime must not assume persistent local state between jobs (§10): anything that must
  survive a job is reported to the platform, not kept in the container.
