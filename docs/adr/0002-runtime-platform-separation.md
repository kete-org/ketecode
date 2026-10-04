# 0002. Runtime and platform separation

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Kete Code needs both a runtime that does engineering work where the code is (on a
developer's machine, in Kete's cloud or in an enterprise environment) and central
services for identity, organizations, configuration, policy, model access and
billing. Mixing the two would couple the runtime's release cycle, deployment and
security posture to hosted services, and make the OpenCode-derived code harder to
keep in sync.

## Decision

Kete uses a control plane and execution plane split across two repositories:

- **Execution plane: `kete-code` (this repository).** The OpenCode-derived runtime, the
  `kete` CLI, the SDK, editor integrations, and the clients for platform services (auth,
  registration, configuration sync, model gateway, telemetry).
- **Control plane: `kete-code-platform`.** Portal, platform API, model gateway,
  billing and the database.

The runtime talks to the control plane only through the versioned Platform API. It
never reaches into the platform database, and its core isn't coupled to a specific
cloud or hosting provider (`docs/architecture.md` §41, §99).

## Consequences

- The runtime is versioned and released independently of the platform.
- Work that needs both sides is split into a platform change and a runtime client
  change. `CLAUDE.md` §1 decides where each piece belongs.
- A local runtime should stay useful during temporary platform outages where possible
  (local git, repository analysis, local models, cached agents and skills), but offline
  use must never bypass policy that needs central authorization (§45).
