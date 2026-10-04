# Spec: Self-hosted job hosts P5: dedicated driver and reset verification (agent side)

- Task: `docs/tasks/2026-10-03-job-host-dedicated` · Size: large · Created: 2026-10-03
- Status: built (approved by the user, 2026-10-03: design + build all)

## Goal
The `kete-job-host` agent can run one job directly on a dedicated (no-KVM) server, ADR 0023 rule 8:
exactly one job per host identity (generation), the job image's entrypoint launched with the
config pipe and `KETE_JOB_HOST_PROFILE=dedicated`, the host treated as compromised after the job
until the platform verifies a reset. R1 (`provider_rebuild`) works end to end on the agent side;
R2 (`measured_boot`) has its agent-side interface and stays refused.

## Scope
- `job-host` module (`packages/kete-job-host`):
  - `internal/driver/dedicated`: the driver. Rootfs = the verified read-only ext4 from
    `image.Store` (loop, read-only) + overlay on a sparse ext4 scratch file
    (`resources.scratch_gib`); a reaper (`kete-job-host __dedicated-init`, the agent's own binary)
    as PID 1 of new mount/PID/net/IPC/UTS/cgroup namespaces, cloned into
    `/sys/fs/cgroup/kete-job-host-jobs/<machine>` (`cpu.max`, `memory.max`, `memory.swap.max=0`,
    `pids.max`); veth `kjh0`↔`eth0` with a /30 under the same host nftables table as firecracker;
    tmpfs `/dev` with fixed nodes only; the entrypoint gets `--config-fd 3` (pipe; nothing on disk),
    stdout/stderr on the console log; the reaper reaps every child (P1 handoff), and records the
    entrypoint's end. `Status`/`Stop`/`List`/`Logs`/`Prepare`/`Blocker`/`IsolationGuard`.
  - Agent: one job per generation — the generation is **spent** durably (`state.json`
    `generation_spent_by`) when a dedicated machine reaches `starting`; any other machine is then
    refused `starts_blocked`, reports say `starts_blocked: "generation_spent"`, free slots 0, until
    re-enrollment with a new generation after a verified reset.
  - Enrollment: `enroll --token-file` (R1 boot enrollment from provider user data; root `0600`
    file, removed once the platform answered), `packaging/kete-job-host-enroll.service`; enroll
    refuses on a host whose state records a spent generation; an `active` enroll response (R1
    auto-approval) is reported as such.
  - Config: `dedicated` section (guest network, uplink, pids, min free disk); `measured_boot`
    still refused.
  - `internal/reset`: R2 agent-side interface (`Attestor`, quote over a platform nonce) and
    `Detect` refusing until TPM-resident keys exist.
  - `run`/`doctor` wire the driver and its checks; contract: `generation_spent` added to
    `starts_blocked` (platform must add it, like `host_isolation_lost`).
  - Fake platform: R1 rebuild tokens (auto-approval only for a matching dedicated rebuild).
- Docs: README, job-host card, contracts §6f, commands, handoff with the platform requirements.

## Out of scope
- The platform side (P5 plat / P6): generation tracking, R1 orchestrator and provider client,
  auto-approval, R2 quote verification — recorded in handoff.md for a later platform task.
- R2's TPM keys, quotes and the signed host image (UKI, dm-verity, tmpfs overlay): no TPM here.
- Real provider rebuilds (no provider account); the R1 cycle runs against a fake provider.

## Acceptance criteria
- [x] AC1: config: dedicated needs `provider_rebuild` (measured_boot and none refused), 1 slot, a
  generation, resolvers; the `dedicated` section is validated and refused for firecracker.
- [x] AC2: agent: the generation is spent at the first start; a second machine is refused
  `starts_blocked`; reports carry `generation_spent` and free 0; it survives a restart; a
  redelivered machine that never started is not blocked by it (scenario tests).
- [x] AC3: R1 cycle (fake platform + fake provider): rebuild with a fresh token → boot enrollment
  auto-approved → one job → generation spent, second assignment refused → revoked, agent halts →
  rebuild → new identity runs the next job; the first identity is refused.
- [x] AC4: enroll: `--token-file` file rules (root 0600, no symlink), removed after a definitive
  answer and kept after a network error; refused on a spent generation.
- [x] AC5: R2: `reset.Detect` refuses (no TPM / not implemented); config refuses measured_boot.
- [x] AC6: driver unit tests (as root in Docker, privileged): rendered cgroup limits, init spec
  validation, mount/dir safety, Stop idempotent with no residue, List/Logs.
- [x] AC7 (kvmtest): a real job image under the dedicated driver from the agent reaches
  `setup_host`, `host_boundary`, `isolation` and `claim` against the entrypoint's fake platform;
  the next assignment in that generation is refused `starts_blocked`; no residue after stop.
- [x] AC8: checks: gofmt, vet (incl. `-tags kvm`, darwin), `go test -race` in Docker; actionlint;
  `bun run lint`; `upstream:check`; `card-check`.

## Risks and constraints
- Security: rule 8 says the namespaces are not a boundary; the security of a dedicated host is the
  reset. The agent's part is fail-closed refusal (one start per generation, no reset → no run).
  No change to ADR 0023's posture. The new `starts_blocked` value is a contract addition the
  platform must accept before a dedicated host polls (else its reports are refused).
- State schema: an optional field in `state.json` v1 (older agents refuse a file that has it;
  downgrade isn't supported).
- The reaper runs the host's `ip` before pivoting; the job never sees host paths.
