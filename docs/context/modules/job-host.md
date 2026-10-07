---
module: job-host
paths: [packages/kete-job-host/**, .github/workflows/kete-job-host.yml, docs/platform/job-host-v1.md]
verified-at: 0ff9212529
---

## Quick answers
- What is this module? `kete-job-host`, the self-hosted job host agent of kete-code-platform ADR
  0023 (rules 6, 9–13, 17, 19): a root systemd service on servers Kete operates. It enrolls the
  host, polls the platform with RFC 9421-signed requests, runs one machine per job through a
  `Driver`, and destroys undesired, unknown and past-deadline machines (the last offline too). It
  never listens on a port. Go, Linux-only, separate module like `kete-egress`/`kete-root-helper`.
- What's built? Self-hosted **P2** (agent core), **P4**: the `firecracker` driver
  (`internal/driver/firecracker`), the host nftables table (`internal/hostnet`), image fetch +
  conversion (`image.Store`) and the cosign keyless verifier (`image.Sigstore`, sigstore-go), the
  guest kernel (`kernel/`), `doctor` checks and `packaging/install.sh`; and **P5** (agent side):
  the `dedicated` driver (`internal/driver/dedicated`), one job per generation in the agent, R1
  boot enrollment (`enroll --token-file`, `packaging/kete-job-host-enroll.service`), R2's
  interface (`internal/reset`, refused). `newDriver` (`cmd/kete-job-host/host_linux.go:48`)
  builds either. The fake driver and fake platform are tests only.
- How does a dedicated job start? `Driver.Start` (`internal/driver/dedicated/driver_linux.go:309`):
  re-check the host table, cgroup limits (`CgroupLimits`), `allocate` (refused while any machine
  is held), `buildRoot` (`:393`: the store's ext4 loop-mounted read-only at `lower/`, a sparse ext4
  `scratch.img` loop-mounted at `scratch/`, overlay at `root/`; `mount_linux.go` `mountLoop`,
  auto-clearing loops), the machine cgroup under `kete-job-host-jobs`, then `launch` (`:505`): the
  config written into a pipe and closed, the agent's own binary (`/proc/self/exe`) started as
  `__dedicated-init` with `CLONE_NEWNS|NEWPID|NEWNET|NEWIPC|NEWUTS` and `CLONE_INTO_CGROUP`
  (`UseCgroupFD`), fds 3 config, 4 control, 5 report, 6 exit file. Then the veth
  (`hostnet.IP.CreateVeth`, `internal/hostnet/tap_linux.go:80`: `kjh0` ↔ `eth0` in the reaper's
  netns), the `InitSpec` on fd 4, and Start waits for `ok` on fd 5.
- What does the reaper do? `RunInit` (`internal/driver/dedicated/init_linux.go:29`, dispatched by
  `hidden` in `host_linux.go:82` before anything else): fds 3–6 CLOEXEC, umask 022, PID 1 check,
  read the spec, `ip` (host binary, before the pivot) for lo/eth0/default route, IPv6 off,
  `initMounts` (`:157`: `/` rprivate, proc, ro sysfs, tmpfs `/dev` with 6 fixed nodes, devpts,
  shm, `/run`, `unshare(CLONE_NEWCGROUP)` on the locked thread + cgroup2), `pivot_root(".", ".")`,
  hostname/resolv.conf/hosts from inside, `StartProcess` of
  `/usr/local/libexec/kete/kete-job-entrypoint --config-fd 3` (env `PATH` +
  `KETE_JOB_HOST_PROFILE=dedicated`), `ok`, `oom_score_adj -1000`, `reap` every child until the
  entrypoint exits, `kill(-1)`, `exited <code>` to fd 6. The entrypoint's shared-kernel guard
  requires exactly this set-up (PID 1 argv `[<exe>, __dedicated-init]`, initial user ns, own PID
  ns, no mount under `/etc`, no container marker files): `InitArg` and the reaper's mounts are a
  contract with kete-job-entrypoint `hostprofile.DedicatedReaper`; `TestJobRunsAndExits` checks it. `Status`: reaper alive (pid + start time +
  cgroup prefix) → running; `exit` says `exited` → exited; else crashed.
- One job per generation? The agent, not the driver: `prepare` sets `state.GenerationSpentBy` to the
  machine id right before `starting` (`internal/agent/agent.go:682`, dedicated only; a failed save
  fails the start); `startsBlocked` (`:234`) then blocks every machine, a replay of the spender
  included (`starts_blocked`, `TestDedicatedReplayedSpender`), reports say `generation_spent` and
  `free: 0` (`generationSpent`, `:227`). Refused assignments (signature,
  generation mismatch) don't spend. `enroll` refuses a spent state (`internal/enroll/enroll.go:98`).
- Is `generation_spent` in the platform contract? No: kete-code added it to `internal/contract`
  (`BlockedGenerationSpent`) in P5; the platform's `JobHostStartsBlocked` must add it before a
  dedicated host polls (P5 handoff), like `host_isolation_lost`.
- R1 and R2? R1 `provider_rebuild`: the platform rebuilds the server with user data writing
  `config.json` (the rebuild's generation) and `enroll.token`; `kete-job-host-enroll.service` runs
  `enroll --token-file` (`fsutil.ReadPrivate`; the file is removed on a 201, `enrollment_token_invalid` or `key_in_use` (or when malformed),
  kept after a transport error); the platform answers `active`. `TestDedicatedR1Cycle` with a fake
  provider; `fakeplatform.AddRebuildToken` models the auto-approval. R2 `measured_boot`:
  `reset.Attestor`/`Detect` (`internal/reset/reset.go:36`, `:55`) refuse; `config.Parse` refuses it
  (`internal/config/config.go:204`).
- How does a firecracker VM start? `Driver.Start` (`internal/driver/firecracker/driver_linux.go:300`):
  re-check the host table, slot (`allocSlot` writes `vm.json` first), hard-link kernel (SHA-256 must
  be in `kernel_allowlist`) and rootfs into the jail, sparse ext4 scratch labelled `kete-scratch`,
  config disk = `seal.ConfigDisk` (jail uid `0600`) on a 64 KiB tmpfs at the jail's `cfg/`
  (`mountConfigFS`; never on disk), VM config, tap `kjh<slot>`, then the jailer
  (`jailerArgs`, `render.go`: own uid/gid, chroot, default seccomp, `--new-pid-ns`, cgroup v2
  `cpu.max`/`memory.max`/`pids.max` under `kete-job-host-vms`, `--config-file` + `--no-api`). The
  config disk is unlinked and its tmpfs detached once the VMM holds it (`waitOpened`, matched by
  inode: the jailed process's fd links show chroot-relative paths; the jailer's recursive bind makes
  the tmpfs visible in the jail). Golden files in `…/firecracker/testdata/`.
- Exited or crashed? `Status` (`driver_linux.go:530`): VMM alive (pid + `/proc` start time + cgroup
  path) → running; gone and Firecracker's log has "Firecracker exiting successfully" (guest reboot:
  kete-job-init's end or `panic=1`) → exited; else crashed.
- What does the host table allow? `hostnet.Table.Render` (`internal/hostnet/hostnet.go:97`; goldens
  `internal/hostnet/testdata/*.nft`): from `kjh*` nothing to the host (input), IPv4 only, no
  spoofing (`fib saddr . iif oif missing`, pool source), out of the uplink only, no blocked range
  (`hostnet.Blocked`), then UDP/TCP 53 to the resolvers and TCP 443; masquerade on the uplink.
  Checked by comparing `nft -j` listings with handles stripped (`Canonical`) in
  `Driver.CheckIsolation` (`driver.IsolationGuard`), which the agent calls every 5 s
  (`Agent.CheckIsolation`, own loop in `Run`, `Options.IsolationEvery`) and `Start` calls first.
  Missing/changed → fail closed: every live machine destroyed (`host_isolation_lost` + agent phase
  line `host_isolation`/`failed`/`host_table`), starts blocked `host_table` (sticky `tableLost`/
  `isoLost`) until the agent restarts and `Init` re-applies the table.
- Is `host_isolation_lost` in the platform contract? Not yet: kete-code added it to
  `internal/contract` (`ReasonHostIsolationLost`) on the coordinator's decision (P4); the platform's
  `JobHostMachineReason` and `docs/platform/job-host-v1.md` must add it before P3 serves reports,
  or the platform refuses those reports.
- Where does image verification happen, and when? In the machine's worker, off `a.mu`
  (`Agent.prepare`, `internal/agent/agent.go:593`): `Verifier.Verify` (2 min) → `checkSealed` →
  `driver.Preparer.Prepare` (30 min, `image.Store.Rootfs`) → `starting` → `Start`. `PollOnce` waits
  only for fast work (`waitFast`); tests call `Wait`. `image.ErrUnavailable` → `image_unavailable`.
- What does the verifier accept? `image.Sigstore.Verify` (`internal/image/verify.go:135`): bundle
  referrers of the digest (`remote.Referrers`, falls back to the `sha256-<hex>` tag cosign v3 writes
  on GHCR), DSSE in-toto statement with predicate `https://sigstore.dev/cosign/sign/v1` and the
  digest as its only subject, sigstore-go with SCT + tlog + observer timestamp and
  `image.ReleaseIdentity` (SAN regex for `kete-release.yml@refs/tags/kete-v<semver>`, issuer, source
  repository). Trusted root: TUF, cached in `<state>/sigstore-tuf`. Tests use a real public bundle
  (`testdata/sigstore/`, github-mcp-server's identity) because Kete's release isn't signed yet.
- Where's the contract? `docs/platform/job-host-v1.md` (copy of the platform's
  `docs/contracts/job-host-v1.md` at `04d406a`); wire types in `internal/contract/contract.go`;
  module README `packages/kete-job-host/README.md` (configuration, files, exit codes, poll table,
  machine checks). `contracts.md` §6f summarises.
- How do I know the Go side interoperates with the platform's TypeScript? The shared vectors in
  `packages/kete-job-host/testdata/job-host-v1/` (byte-for-byte copies, `SHA256SUMS`; drift test
  `internal/vectors/vectors_test.go`). `internal/sig` re-signs both requests byte for byte and
  checks all 16 refusals with their reasons, RFC 9421 B.2.6 and RFC 9530 B.1; `internal/seal` opens
  both seals, refuses all 7 refusals, derives the vector keys and opens RFC 9180 A.1.1;
  `TestVectorConfigDisk` rebuilds the config disk's SHA-256. Cross-check against a platform
  checkout: `KETE_PLATFORM_VECTORS=<dir>` (`TestVectorsMatchPlatform`).
- Which HPKE library? Go 1.26's standard `crypto/hpke` (base mode, X25519/HKDF-SHA256/AES-128-GCM).
  Dependencies: `golang.org/x/sys`, go-containerregistry (v0.22.1) and sigstore-go (v1.3.0); the
  last two are large (≈70 indirect modules, ~19 MB binary) — justified in the README "Building" and
  the P4 handoff.
- Why do the agent's Ed25519 checks go beyond `crypto/ed25519`? Go, like Web Crypto, accepts the
  identity public key with the forged signature R = identity, S = 0. `sig.AcceptablePublicKey`
  (`internal/sig/sig.go:188`) refuses non-canonical and small-order keys (the libsodium list, same
  as the platform's `isAcceptableEd25519PublicKey`), `sig.CanonicalS` refuses S ≥ L, and `Verify`
  verifies unknown keys against a dummy key so they cost the same (P2.0 handoff).
- Order of the assignment checks? `checkCheap` (`internal/agent/agent.go:529`, under `a.mu` in
  `assign`): deadline passed → starts blocked (operator, state file, driver `Blocker`) → no free slot
  → image allowlist; then in the worker (`prepare`): signature (`image_signature_invalid`, or
  `image_unavailable`) → HPKE open → `platform_url` → strict canonical `JobMachineConfig` → dedicated
  generation (`checkSealed`, `:545`) → `Prepare` (`image_unavailable`) → deadline/blocked again →
  driver start (`driver_failed`). A run entry without `config` is `config_invalid`. Dedicated: the
  spent check is part of `starts_blocked` (both times), and the spend happens just before `starting`.
- When is a response discarded? `PollOnce` (`internal/agent/agent.go:853`): invalid body,
  `in_reply_to` ≠ the nonce sent, `host_id` ≠ ours, `revision` below the applied one. Nothing is
  applied and phase lines are resent.
- When is a tombstone forgotten? After a fresh, accepted response to a report that carried it in a
  terminal state names it in neither `run` nor `destroy` (`apply`, `internal/agent/agent.go:722`;
  `sentTerminal` from `buildReport`).
- What survives a restart? `state.json` (host id, fingerprint, generation, applied revision,
  durable halt, machine records without any configuration). `Reconcile`
  (`internal/agent/agent.go:1020`) stops driver machines without a live record (reported
  destroyed/`desired`, `job_id` null), records vanished machines (`crashed` or their pending stop
  reason), re-adopts running ones, drops `preparing` records. Phase lines are memory only.
- Halts? `host_revoked`/`generation_mismatch`: destroy all, halt durably (state file), exit 3; a
  durable halt found at start destroys every machine during reconcile. `signature_invalid`: stop
  polling (memory only), keep supervising until no machine is left, exit 3 — and report nothing
  meanwhile (the platform sees a stale host). The unit has `RestartPreventExitStatus=2 3`.
- How are driver calls bounded? `DriverTimeouts` (Start 2 min, Stop 1 min, Status/Logs 10 s, List
  30 s); every per-machine call runs in that machine's worker (`kick`/`work`/`step` in
  `internal/agent/agent.go`) without `a.mu`, one worker per machine. `Supervise` only kicks idle
  workers and doesn't wait; `PollOnce` and tests call `Wait`. Run starts the supervise loop before
  `Reconcile`, which is retried with backoff.
- File rules? `internal/fsutil`: `O_NOFOLLOW|O_CLOEXEC` + fstat on the descriptor, owner uid 0,
  no group/other bits on private files, ancestors root-owned and not group/other-writable;
  `config.Load` uses `OpenRootFile` (root-owned, no group/other write). Tests therefore run as root
  under a fresh dir below `/` (`internal/testroot`); CI runs `go test` with `sudo`.
- Re-enrollment safety? `enroll` stages keys (`keys.SaveStaged`, `*.key.new`), and only after a
  validated 201 runs `CommitStaged` then writes the state; failures `DiscardStaged`.
- How do I run the tests? `docs/context/commands.md` "Go job host agent": unit tests as root in
  Docker (`--privileged` for the nft tests); KVM acceptance tests with `scripts/kvm-test.sh` on a
  KVM host (`internal/kvmtest`, tag `kvm`; locally the Colima profile `kvmtest`).
- Why can't a host run Docker? Docker's iptables FORWARD policy DROP drops guest traffic after the
  agent's table accepted it; `install.sh` warns, `scripts/kvm-test.sh` adds `DOCKER-USER` accepts.
- How do VMs survive an agent restart? Each VMM is in `/sys/fs/cgroup/kete-job-host-vms/<id>` and its
  own PID namespace (the jailer parent exits), not in the unit's cgroup; the unit has
  `KillMode=mixed`. The driver's `vm.json` (no configuration) lets `List`/`Status` re-adopt them.

## Purpose
The execution-plane half of ADR 0023's architecture (A): the platform keeps desired state per host
(P3), the agent pulls it, reports observed state and phase lines, and enforces locally what a
compromised platform must not be able to change: the configured origin, the image allowlist and
signature, deadlines.

## Entry points
- `packages/kete-job-host/cmd/kete-job-host/main.go`: `enroll`, `run`, `doctor`, `fingerprint`,
  `version` (`run`, `:52`); exit codes 0/1/2/3; `facts` reads arch, `/dev/kvm` and `uname`
  (`host_linux.go`).
- `packages/kete-job-host/packaging/kete-job-host.service` (unit, `KillMode=mixed`) and
  `packaging/install.sh` (binaries, kernel, sysctl, unit; never enrolls or starts).
- `packages/kete-job-host/kernel/build.sh` (guest kernel), `check-config.sh`, `scripts/kvm-test.sh`.
- `.github/workflows/kete-job-host.yml`: CI.

## Key files
| File | Role |
| --- | --- |
| `internal/contract/contract.go` | Routes, limits, enums, request/response structs and `Validate` methods (responses tolerant of unknown fields; `DesiredState` fields are pointers so missing ≠ empty) |
| `internal/sig/sig.go` | `Sign` (`:134`), `Verify` (`:295`, contract order), `VerifyEnrollment` (`:329`), key hygiene, `Fingerprint`, `GroupFingerprint` |
| `internal/seal/seal.go` | `Binding.Info`, `Open` (`:68`), `Seal` (fake platform), `ParseMachineConfig`/`Validate`/`Canonical`, `ConfigDisk` (`:204`) |
| `internal/agent/agent.go` | `New`, `check`, `assign`, `apply`, `buildReport`, `PollOnce`, `handleError` (`:920`, the refusal table), `Supervise` (`:967`, deadline killer), `Reconcile`, `Run` (`:1086`); dedicated: `generationSpent` |
| `internal/enroll/enroll.go` | `ReadToken` (stdin only), `Run` (`:66`): keys, fingerprint, signed request, response check, state |
| `internal/client/client.go` | `Post` (`:110`): sign, TLS (verify on, no proxy, no redirects), 15 s, 1 MiB; `APIError`; `Backoff` |
| `internal/keys/keys.go`, `internal/fsutil/fsutil.go` | Key files and the private-file rules (0600/0700, owner, no symlink, atomic writes) |
| `internal/state/state.go` | `state.json` schema v1, `Validate`, atomic `Save` |
| `internal/config/config.go` | Strict config: origin, driver rules (dedicated needs `provider_rebuild`; `measured_boot` refused), allowlists, public IPv4 resolvers, `firecracker` and `dedicated` sections (`parseDedicated`, `:278`) |
| `internal/driver/dedicated/dedicated.go`, `driver_linux.go`, `init_linux.go`, `mount_linux.go` | Dedicated: `InitSpec`, `CgroupLimits`; `Init` (table, parent cgroup, stray veths), `Start`, `Status`, `Stop` (`cgroup.kill` tree, veth, unmount, never delete through a mount), `List`, `Logs`; the reaper `RunInit`; loop mounts |
| `internal/reset/reset.go` | R2's agent side: `Attestor`, `Quote`, `Detect` (refuses) |
| `packaging/kete-job-host-enroll.service` | Dedicated first-boot enrollment (`enroll --token-file`), `ConditionPathExists` on the token |
| `internal/driver/driver.go`, `driver/fake/fake.go` | The `Driver` interface and its rules, optional `Preparer` and `Blocker`; the in-memory test driver |
| `internal/driver/firecracker/render.go`, `driver_linux.go` | Jailer args, VM config, boot args; `Init` (table, cgroup parent, stray taps), `Start`, `Status`, `Stop` (`cgroup.kill`, residue check), `List`, `Logs` (offset in `vm.json`, 8 MiB truncation) |
| `internal/hostnet/hostnet.go`, `tap_linux.go` | Host table render/apply/check, `SlotNet` (/30, MAC, `ip=`), uplink, forwarding; taps via `ip` |
| `internal/image/image.go`, `verify.go`, `store.go` | `Allowlist`, `Verifier`, `Unconfigured`; `Sigstore` (`ReleaseIdentity`, TUF root); `Store.Rootfs` (`:63`; blobs downloaded whole and hashed, diff_ids, `os.Root` unpacker with whiteouts, `mkfs.ext4 -d`, cache + `Prune`) |
| `internal/kvmtest/kvm_test.go`, `probe/main.go` | KVM acceptance tests (tag `kvm`) and the guest-root probe (replaces the entrypoint in a test image) |
| `kernel/` | `kete.fragment`, `config-{amd64,arm64}` (microvm), `cloudvm.fragment` + `cloudvm-{amd64,arm64}.fragment` → `config-cloudvm-{amd64,arm64}`, `check-config.sh`, `build.sh` (6.18.55, pinned builder and Debian snapshot) |
| `internal/phase/phase.go` | Strict phase-line parse, 512-byte raw cap, 200-line buffer with Ack/Nack |
| `internal/fakeplatform/` | Both routes per P2.0 with hooks (`SetTamper`, `SetForceError`, `SetSkew`, `SetUnreachable`, …) and `StartTLS` (a fresh CA, real TLS) |
| `internal/agent/{harness,scenario}_test.go` | The scenario tests |

## Data flow
Enroll: token (stdin) → keys generated and saved → fingerprint printed → `EnrollRequest` signed
with `keyid` = fingerprint → 201 → `state.json`. Run: `Reconcile` → loop {clock synced? → report
(machines, phase lines `Take`) → signed poll → validate response → `Ack` lines → `apply` (stop
undesired, `assign` new, forget acknowledged tombstones, `applied_revision`) → sleep
`next_poll_after`} in parallel with `Supervise` every 2 s (status, phase lines, deadline killer).
`assign` runs the cheap checks and kicks the machine's worker; the worker verifies the signature,
opens the sealed config in memory, prepares the image, then hands the canonical JSON to
`Driver.Start` and clears it. The firecracker driver writes it only into the jail's config disk,
which it unlinks once Firecracker holds it.

## Data and APIs used
- Platform routes `POST /api/v1/job-hosts/enroll` and `/poll` (served from P3).
- The machine configuration is kete-code's config-pipe JSON (`bootenv.Config`, P1 decision D2):
  the agent re-encodes it canonically and the drivers deliver it (config disk header
  `kete-job-config v1\n` + JSON + NUL to 8192 bytes for firecracker, read by
  `guestinit.ParseConfigDisk`; the `--config-fd` pipe plus `KETE_JOB_HOST_PROFILE=dedicated` for
  dedicated, P5: the entrypoint's whole environment is `PATH` and that).
- Kernel: `adjtimex(2)` (NTP status), `uname(2)`, `/dev/kvm`, cgroup v2, nftables, tun.
- Tools on the host: `firecracker`/`jailer` (v1.17.0 tested), `nft`, `ip`, `mkfs.ext4`; dedicated:
  `/dev/loop-control` (`LOOP_CONFIGURE`), clone3 `CLONE_INTO_CGROUP` (Linux ≥ 5.7).
- Registries (go-containerregistry, TLS verified, no proxy) and Sigstore's TUF CDN.

## Rules that must not break
- Never listen on a port or expose a local API.
- TLS verification always on; no environment proxy; no redirects (`client.New`).
- Discard any poll response whose `in_reply_to`, `host_id` or `revision` doesn't fit.
- Image allowlist and signature before decrypting; `platform_url` before using anything else in
  the plaintext (ADR 0023 rules 13, 17).
- The configuration, claim token, enrollment token and private keys never reach a log, the state
  file or a report (`TestNoSecretsLeak`); logs carry ids, states, reasons and request ids only.
- Key and state files root `0600` in `0700` directories; refuse anything looser.
- The deadline killer needs nothing from the platform.
- A machine id is never started twice; tombstones stay until acknowledged.
- `run` refuses without a real driver; the dedicated driver refuses without a verified reset.
- No signature check, image fetch or other slow I/O under `a.mu`; reports never wait for them.
- Guests: never MMDS, vsock or an API socket; never the configuration in Firecracker's config, the
  kernel command line or a log; the config disk unlinked once held; default seccomp; `--new-pid-ns`.
- Nothing unverified is unpacked: every blob read to its end and hashed before use.
- A missing or changed host table destroys every live machine within ~5 s (`host_isolation_lost`),
  blocks starts and is reported; it is only re-applied by an agent restart. The check needs nothing
  from the platform.
- Vector copies change only by re-copying from the platform (drift test).
- Dedicated: a generation starts one job (spent durably before `starting`); `enroll` never
  re-enrolls a spent state; the configuration only on the pipe; no agent descriptor reaches the
  entrypoint; the job's `/dev` holds no disk; mounts are made private before anything else in the
  reaper; never `RemoveAll` through a mount point. The namespaces are not a boundary (rule 8): don't
  rely on them for anything the reset is for.

## Testing
- `docker run --rm -v "$PWD/packages/kete-job-host:/src" -w /src golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go test -race ./...'`.
- Scenario tests (`internal/agent/scenario_test.go`): `TestLifecycle`, `TestMachineExits`,
  `TestMachineCrashes`, `TestAssignmentRefusals` (14 cases), `TestNoFreeSlot`,
  `TestDedicatedGenerationMismatch`, `TestReplayAndStale`, `TestPhaseLinesResentAfterLostResponse`,
  `TestClockAndNonce`, `TestHostStates`, `TestRestartReconcile`, `TestDeadlineKiller`,
  `TestRunLoop`, `TestNoSecretsLeak`. Unit tests in every package; vector tests in `sig`, `seal`,
  `vectors`.
- P4: `prepare_test.go` (`TestSlowVerifyOffTheLock`, `TestStopWhileVerifying`,
  `TestImageUnavailableAndPrepare`, `TestDriverBlocksStarts`, `TestIsolationLostDestroysAll`,
  `TestIsolationCheckedOffline`); driver `TestCheckIsolation` (fake `TableManager`); `internal/image` (`TestVerifyBundle`,
  `TestVerifyFromRegistry`, `TestRootfsConversion`, `TestRootfsRefusals`, `TestRootfsTamperedBlob`);
  `internal/hostnet` (goldens, `nft -c`, apply/check/missing/changed); `internal/driver/firecracker`
  (goldens, `TestRenderedSafety`, `TestConfigDiskRoundTrip`, `TestLogsListStop`).
- KVM (`internal/kvmtest`, `sudo scripts/kvm-test.sh <dir>`): `TestGuestIsolation`, `TestRealJob`,
  `TestLifecycle`. Passed on Colima `kvmtest` (aarch64, nested KVM) on 2026-10-03.
- P5: `internal/agent/dedicated_test.go` (`TestDedicatedOneJobPerGeneration`,
  `TestDedicatedSpentOnlyByAStart`, `TestDedicatedR1Cycle` with a fake provider); enroll
  `TestTokenFile`, `TestEnrollRefusesSpentGeneration`; `internal/reset`; driver
  `internal/driver/dedicated` (`TestJobRunsAndExits`, `TestOneAtATimeStopAndCrash`,
  `TestStartFailureCleansUp`: a real launch with the test binary as reaper and, copied with its
  `ldd` libraries into a test ext4, as entrypoint; root, `--privileged`, loop, cgroup v2, `ip`);
  KVM-host `TestDedicatedRealJob` (whole job to `finish ok`, second assignment `starts_blocked`)
  and `TestDedicatedLifecycle` (probe isolation, restart re-adoption, deadline killer, table loss);
  `sudo scripts/kvm-test.sh <dir> TestDedicated` needs no KVM. Passed on Colima `kvmtest` on
  2026-10-03.
- Kernel: `kernel/check-config.sh` (all four configs) is the quick check; `build.sh <arch> --variant cloudvm` rebuilds one (Docker, ~5 min) and fails if the config isn't stable under `olddefconfig`.
- CI: `kete-job-host.yml` (nftables + e2fsprogs + iproute2, kernel config check, gofmt, vet incl. `-tags kvm`
  and `GOOS=darwin`, `sudo go test -race`, compile of the KVM tests, build). The release builds and
  signs the kernels (`kete-tools-ci` card).

## Changes
- `docs/tasks/2026-10-03-job-host-cloudvm-images/` (self-hosted P7): the `cloudvm` kernel variant
  (`kernel/cloudvm.fragment`, `cloudvm-<arch>.fragment` merged over Firecracker's base and
  `kete.fragment`, so every microvm hardening term still holds; EFI stub, GPT, ACPI/PCI,
  virtio-pci, `IP_PNP_DHCP`), `config-cloudvm-<arch>`, `build.sh --variant cloudvm` (outputs
  `kete-cloudvm-kernel-<release>-<arch>` bzImage/Image + `.sha256` + `.config`; arm64 rebuilt
  bit-identical), `check-config.sh --variant microvm|cloudvm --arch` (no arguments: all four
  checked-in configs). The disk and provider images that use it are the `job-image` card's;
  operators read `docs/job-hosts.md` (the README points to it).
- New driver: implement `driver.Driver` keeping its rules (`internal/driver/driver.go`), select it
  in `newDriver` (`host_linux.go`), add its `doctor` checks to `driverChecks` (shared `hostChecks`).
- R2: implement `reset.Attestor` (TPM keys, quotes), then let `config.Parse` accept
  `measured_boot` — needs a contract change (key algorithm, quote route) first (README
  "Dedicated hosts").
- Firecracker or kernel bump: `kernel/build.sh` pins (+ `--regen-config` for both arches **and both variants**, `--variant microvm|cloudvm`; the builder is always `linux/amd64`, as on the release runner, because Kconfig records compiler probes such as `CC_CAN_LINK` that differ between native and cross toolchains — don't regenerate under emulation on an arm64 Mac — qemu segfaults silently drop probed symbols; take the `kernel-config-<variant>-<arch>` artifact from `kete-job-host.yml`'s `kernel-config` job, which regenerates each config on the runner and checks the committed one with `build.sh --check-only`),
  Firecracker version in hosts' `versions.firecracker`, the KVM tests' versions, the README.
- Host table change: `hostnet.Render`, regenerate goldens (`go test ./internal/hostnet -update`),
  re-run `TestGuestIsolation` on a KVM host.
- Contract change: re-copy `docs/platform/job-host-v1.md` and the three vectors from the platform,
  regenerate `SHA256SUMS`, update `internal/contract`, then this card and `contracts.md` §6f.
- Driver contract (timeouts, no same-machine concurrency): `internal/driver/driver.go` package doc.
- `go.mod` pins (`go 1.26.0`, `toolchain go1.26.8`, `golang.org/x/sys v0.48.0`) move with the
  sibling modules (`kete-tools-ci` card); go-containerregistry and sigstore-go are this module's own.

## Gotchas
- Go's `encoding/json` matches field names case-insensitively; strict decoders here
  (`DisallowUnknownFields`) still accept `"JOB_ID"`. The machine configuration is therefore also
  compared byte for byte with its canonical encoding (`config_invalid` otherwise).
- `freeSlots` counts the candidate machine once it is in the table: `check` compares
  `len(live) > slots`, not `freeSlots() <= 0` (a bug the scenario tests caught).
- Fake clock vs TLS: scenario tests advance a fake clock for signatures, deadlines and the fake
  platform; TLS certificate validity uses the real clock, so jumps of hours are fine.
- Claim-token strings decoded from JSON can't be zeroed in Go; byte slices are cleared (best
  effort), strings are dropped as soon as the driver has the config.
- `Driver.Stop` failing leaves a machine `stopping`; `Supervise` retries every pass (one error
  log line per pass). A failed `Start` whose cleanup `Stop` fails goes to `a.cleanup` and is
  retried there (the machine itself is already `failed`).
- A driver call that ignores its context keeps that machine's worker busy forever (calls on one
  machine never overlap); the other machines are unaffected.
- Tests must run as root; as another user `testroot.Dir` fails with an explanation.
- The jailed VMM's `/proc/<pid>/fd` links read `/config.img` (its own root), so matching by path
  fails; match by device + inode.
- `nft -j list` output carries handles and a metainfo version: compare canonical listings only.
- Go probes in a guest: `select {}` with no other goroutine is a fatal deadlock (the VM then
  reboots and exits) — sleep in a loop instead.
- go-containerregistry checks a blob's digest only at EOF; a tar reader stops at the end marker.
  `image.Store` therefore downloads every blob whole and hashes it itself before unpacking.
- Dedicated: the entrypoint isn't PID 2 (the reaper's `ip` commands took pids first); tests assert
  only "not 1". Go 1.25+'s runtime keeps `/sys/fs/cgroup/cpu.max` open (container-aware
  GOMAXPROCS): an fd-leak check must ignore it. In a Docker container the test process sits at a
  cgroup-namespace root and must move to a leaf before controllers can be enabled there
  (`needHost`). A fork bomb in the job OOM-kills inside its cgroup; the reaper protects itself
  (`oom_score_adj -1000`, set after forking the entrypoint so descendants keep 0). Under systemd
  the agent's mounts are in its unit's mount namespace (PrivateTmp/ProtectSystem) and vanish on
  restart; the job keeps its own copies, and `Stop` must accept plain directories.
- The entrypoint's fake platform issues 64-hex claim tokens (the contract's shape); an agent refuses
  any other shape as `config_invalid`.
