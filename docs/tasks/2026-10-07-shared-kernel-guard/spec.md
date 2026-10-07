# Spec: shared-kernel guard for the job entrypoint

- Task: `docs/tasks/2026-10-07-shared-kernel-guard` · Size: medium · Created: 2026-10-07
- Status: approved (maintainer's standing approval for security fixes in the Phase 8 program;
  enterprise runtime spec "S0 findings" item 3 asks for this fix as its own PR, ahead of P2)

## Goal
The job entrypoint (and kete-job-init) must never write kernel state (sysctls, mounts and
remounts, nftables, cgroups, hidepid) unless it is provably in its own kernel: a VM booted for the
job, or the single-tenant dedicated host set up by kete-job-host's dedicated driver. Spike S0
(`docs/tasks/2026-10-07-enterprise-runtime/s0-report.md` §4.3) ran the released `dedicated` profile
in a Kubernetes runc pod: privileged (r2), a whole job passed and set the node's
`user.max_user_namespaces` to 0; capabilities only (r3), the remounts succeeded and only AppArmor
stopped host sysctl writes.

## What `dedicated` is
`packages/kete-job-host/internal/driver/dedicated`: one job at a time directly on a host without
KVM; the agent spends the host's reset generation and the platform rebuilds the host afterwards
(ADR 0023 rule 8). The agent re-executes itself as the reaper `kete-job-host __dedicated-init`,
PID 1 of new mount, PID, network, IPC, UTS and (after unshare) cgroup namespaces, **not** a user
namespace; the reaper pivots into an overlay root, mounts proc, a read-only sysfs, a tmpfs `/dev`,
devpts, shm, `/run`, cgroup2, writes `/etc/resolv.conf` and `/etc/hosts` as files, and starts the
entrypoint with `--config-fd 3` and env `PATH` + `KETE_JOB_HOST_PROFILE=dedicated`. "Job root is
host root" by design. So in `dedicated` the entrypoint legitimately writes the **host's** kernel
state; a boot-ID comparison can't distinguish it from a container (both share the host kernel).

## Design (per profile)
Code `shared_kernel` at step `setup_host` (entrypoint) and a new step `init_kernel`
(kete-job-init). `setup_host` becomes the entrypoint's first step (before `boot`'s
`oom_score_adj`/dumpable writes); it only reads.

- **microvm, cloudvm** (`OwnKernel`): the process is in the kernel's initial user and PID
  namespaces (`stat /proc/self/ns/{user,pid}` inode = `PROC_USER_INIT_INO` 0xEFFFFFFD,
  `PROC_PID_INIT_INO` 0xEFFFFFFC, fixed kernel constants; all others are ≥ 0xF0000000) and, by the
  existing `init` rule, PID 1 is kete-job-init. kete-job-init is then the kernel's own init, so the
  kernel is the VM's. A container is never in the initial PID namespace; one sharing the host's
  (`hostPID`) has the host's init as PID 1. kete-job-init runs the same check first in both stages
  (mounting `/proc` first when absent, i.e. in a VM), and powers off on refusal (inside a
  container's PID namespace that only ends the namespace). No host input, no contract change.
- **dedicated** (`DedicatedReaper`): the initial user namespace; a PID namespace other than the
  initial one; `/proc/1/cmdline` exactly `[<exe>, __dedicated-init]`; no mount point at or under
  `/etc`, `/dev/termination-log`, `/run/secrets`, `/var/run/secrets` (Docker, Podman and every CRI
  runtime bind-mount `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`; Kubernetes adds the
  termination log and service account); no `/.dockerenv` or `/run/.containerenv`.
- **fly**: unchanged (Fly Machines are Firecracker VMs; not verifiable here, see Out of scope).
- Unreadable namespaces or mount table: refuse (`shared_kernel`). Unreadable `/proc/1/cmdline`:
  no argv (refused for dedicated).
- Not used: virtio/DMI (S0: useless), `/proc/1/cgroup` (cgroup namespaces show `0::/` in both),
  environment markers (the boot stage scrubs the environment; Kubernetes is caught by its mounts),
  boot IDs (see above; the future `kubevm` profile uses the node's boot ID per S0 because there
  the job is in a PID namespace inside the Kata guest).

Threat model: the guard stops the image running where it doesn't belong (a Docker or Kubernetes
container named `dedicated` or a VM profile). It is not a defence against a host administrator who
deliberately imitates the reaper; that person owns the kernel anyway.

## Scope
- `packages/kete-job-entrypoint`: `hostprofile` (kernel.go, `GatherKernel`, `Check`), `layout`
  (guard inputs), `entry` (order, gather), `guestinit` (`ownKernel`), `phaselog`
  (`shared_kernel`, `init_kernel`), tests (unit, linux, itest, e2e stand-in reaper), README.
- `packages/kete-job-host`: `dedicated.InitArg` comment; the dedicated driver test asserts the real
  reaper presents what the guard requires.
- `packages/kete-job-image`: `scripts/e2e.sh` runs the job container under the stand-in reaper
  (`e2e.test __dedicated-init`); README.
- Cards: job-entrypoint, job-host; contracts.md.

## Out of scope
- `fly` profile (no change; would need verification on a real Fly machine).
- `kubevm` (P2 of the enterprise runtime).
- Any contract change: phase-line `step`/`code` are free-form `^[a-z][a-z0-9_]{0,39}$` in
  job-host-v1/v2 `JobHostPhaseLine` and jobs-v1; nothing maps entrypoint codes to machine reasons.

## Acceptance criteria
- [ ] AC1: `hostprofile.Check` refuses `shared_kernel` for dedicated in a privileged Docker
  container, a capability-only pod and a VM kernel; for microvm/cloudvm in a container; passes the
  dedicated reaper's set-up and a VM (unit tests over real-shaped mount tables).
- [ ] AC2: `GatherKernel` reads the facts with injectable readers; unreadable namespaces or mount
  table fail; unreadable cmdline is no argv (linux unit test).
- [ ] AC3: `setup_host` is the entrypoint's first step; kete-job-init's guard runs before its other
  writes in both stages.
- [ ] AC4: integration: the built binary with `dedicated` in the CI privileged container is
  refused `shared_kernel` (config on fd 3 and on stdin), no claim, and the sysctls it sets,
  `/proc`'s mount, the nft table and job cgroups are untouched.
- [ ] AC5: kete-job-host's dedicated driver test: the real reaper's job sees the initial user
  namespace, its own PID namespace, PID 1 argv `[<exe>, __dedicated-init]`, no runtime mount, no
  marker file.
- [ ] AC6: existing suites pass: entrypoint unit + integration, job-host, image e2e (with the
  stand-in reaper).

## Risks and constraints
- Version coupling: the guard requires the dedicated reaper's argv; `InitArg` changes must change
  both modules (commented on both sides, tested in AC5).
- Fail closed: a real VM whose kernel lacks `/proc/self/ns` would be refused (the guest kernels
  have `CONFIG_NAMESPACES`, `CONFIG_PID_NS`, `CONFIG_USER_NS`).
- Not runnable locally (macOS, no Docker by instruction): Linux-only tests rely on CI. A real
  dedicated host and a real Firecracker guest with the real image (kvm-test.sh) were not run.

## Review amendments (2026-10-07, independent review of PR #19)
- **fly:** no shared-kernel guard yet (whether the entrypoint on a Fly Machine is in the initial
  namespaces can't be verified here; follow-up). Added: a read-only presence check of `/.fly` and
  `/.fly/api` (`setup.FlyPresent`) right after `setup_host`, before any write, so Fly's variables
  alone in a container never reach the sysctls (`setup_fly` `missing`). A container that also
  fakes the socket is not caught.
- **Host side:** `kete-job-host/internal/hostguard`: the firecracker and dedicated drivers' `Init`
  (first step) and `doctor` refuse unless the agent is in the initial user and PID namespaces and
  no container marker is present (`/.dockerenv`, `/run/.containerenv`, `/run/systemd/container`,
  `/run/host/container-manager`, `container=` in `/proc/1/environ`).
- **Coupling:** `initarg_test.go` (kete-job-host) reads `DedicatedInitArg` from the entrypoint's
  source; kete-job-host.yml triggers on that file.
- **Nits:** dedicated also requires the reaper as parent (ppid 1), PID 1 not this program, no
  `container=` in PID 1's environment, the systemd marker files; nsfs verified by statfs
  `NSFS_MAGIC`; kete-job-init opens the console before its guard.
- AC7: host guard refuses in container facts and before any write in `Init` (unit tests).
- AC8: fly without `/.fly/api` stops before `boot`/`setup_sysctl` (itest).
