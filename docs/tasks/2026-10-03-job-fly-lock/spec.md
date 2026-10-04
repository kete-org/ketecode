# Spec: Job entrypoint: fail closed on Fly guards; in-VM isolation check

- Task: `docs/tasks/2026-10-03-job-fly-lock` · Size: medium · Created: 2026-10-03
- Status: built <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Close the cloud-jobs whole-system security review's major finding on the job entrypoint:
`setup.LockFly` returned nil when `/.fly` was missing (`internal/setup/setup_linux.go:76`,
README `:299`), so if Fly's machine API socket lived elsewhere the tool user could call the
Machines API as the machine (delete or exec into other tenants' machines in the shared jobs app).
The entrypoint must fail closed and prove, as the tool user, that nothing outside the job is
reachable before it claims.

## Scope
Module `job-entrypoint` (`packages/kete-job-entrypoint`) only:
1. **Fly guard fails closed.** Detect Fly (Fly's machine variables at boot, carried across the
   scrubbed re-exec as one bit, or `/.fly` existing). On Fly, a missing `/.fly` or `/.fly/api`
   aborts setup (`setup_fly` `missing`) before claim. Lock `/.fly` root 0700 and `/.fly/api`
   root 0600, read back. Then verify as the tool user that the socket can't be connected to.
2. **In-VM isolation self-check** before claim, as the tool user (a dedicated probe launched the
   way the helper runs a tool): Fly's API socket, the helper's socket, every other listening unix
   socket (path or abstract) not connectable; kete's home and TMPDIR unreadable; metadata
   169.254.169.254, Fly's 6PN (fdaa::/16 samples and the machine's own fdaa addresses), the
   resolvers (resolv.conf's and fdaa::3, TCP and UDP) unreachable; 127.0.0.1 and ::1 TCP ports
   1-1023 not connectable except port B. Any failure (or an incomplete or broken probe) aborts
   before claim with a fixed reason. Bounded timeouts; a positive control.
3. **Staging runbook** in the entrypoint README and the job-entrypoint card.

## Out of scope
- The platform's Fly adapter and machine configuration (no new `KETE_*` variable).
- The image (`kete-job-image`) and its e2e (not changed; the check runs there too).
- Changing the nft ruleset (`kete-egress`).

## Acceptance criteria
- [x] AC1: On Fly (a Fly variable set, or `/.fly` present) with `/.fly` or `/.fly/api` missing,
  setup fails `setup_fly` `missing` and no claim is made (unit `setup` tests,
  `TestFlyGuardMissingAPISocket`, `TestBinaryBootOnFly`).
- [x] AC2: The guard locks `/.fly` root 0700 and `/.fly/api` root 0600, and a socket the tool user
  could reach before the guard is unreachable after it (`TestLockFlyLocks`, `TestFlyGuardLocks`).
- [x] AC3: The isolation check runs as the tool user after the helper and before claim, and each
  reachable target class aborts with its fixed code; the control and an incomplete check fail
  closed (`isolation` unit tests, `TestRefuseClaimWithoutIsolation`, `TestIsolationProbeDetects`,
  `TestIsolationStraySocket`, `TestIsolationReadableKeteDir`).
- [x] AC4: With the job's firewall up, the check passes on a healthy machine (every existing
  integration scenario, `TestIsolationFirewallRefuses`) and takes well under a second.
- [x] AC5: The README and the card describe the guard, the check, the codes and a staging runbook.

## Risks and constraints
- Security posture: tightened only (more aborts, no relaxed check). Fail-closed risk: a Fly change
  (socket moved, a new world-connectable socket) stops every job before claim until handled; that
  is the intended direction and the runbook covers confirming it on staging.
- Contracts: additive phase step `isolation` and codes; reading Fly's own `FLY_*` variables (as
  a bit) is a new boot input, documented; no platform-visible change (no callback before claim).
- No money or tenancy impact.
