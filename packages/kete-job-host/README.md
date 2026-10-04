# kete-job-host

The self-hosted job host agent of kete-code-platform ADR 0023 (rules 6, 9–13, 17, 19): a root
systemd service on each server Kete operates for cloud jobs. It enrolls the host, polls the
platform with signed requests, runs one machine per job through a **driver**, and destroys
machines the platform no longer wants, unknown machines and machines past their deadline — the
last even while the platform is unreachable. It **never listens on a port** and exposes no local
API (ADR 0018 rule 6, kete-code ADR 0006).

Linux-only, Go, no cgo. It never ships with the `kete` CLI, the job image or the VS Code
extension.

Operators: start with the consolidated guide, `docs/job-hosts.md` (every architecture, what a
release publishes for it, setup, upgrades, and the platform documents for each step).

**Status (self-hosted P5):** the agent core (P2) plus the **`firecracker` driver** (P4): one
jailed Firecracker microVM per job, booted from Kete's guest kernel (`kernel/`) and the job image's
read-only root file system, behind the host nftables table `inet kete-job-host`; images are
fetched by digest, every blob verified, and accepted only with a valid cosign keyless signature
by Kete's release workflow (sigstore-go). And the **`dedicated` driver** (P5): one job per host
identity, directly on a server without KVM, with R1 (`provider_rebuild`) resets; R2
(`measured_boot`) is refused until TPM-resident keys exist ("Dedicated hosts" below). The platform
side of dedicated hosts (rebuild orchestration, auto-approval, generation tracking) is not built
yet; nothing answers this agent outside tests until the platform routes are deployed.

## The contract

`docs/platform/job-host-v1.md` (copy of kete-code-platform `docs/contracts/job-host-v1.md`; the
platform's `packages/shared/src/api/v1/job-hosts.ts` is the source of truth). The shared test
vectors are copied byte for byte into `testdata/job-host-v1/` with a `SHA256SUMS`;
`internal/vectors` fails if either drifts. A change to them is a contract change: re-copy all three
files from the platform and regenerate `SHA256SUMS` together.

| Package | Implements |
|---|---|
| `internal/contract` | routes, limits, request/response bodies and their validation |
| `internal/sig` | RFC 9421 signer and verifier (fixed profile), RFC 9530 `Content-Digest`, Ed25519 key hygiene, fingerprint |
| `internal/seal` | HPKE open/seal (RFC 9180 via Go's `crypto/hpke`), the binding `info`, the machine configuration, the config disk |
| `internal/keys` | Ed25519 + X25519 keys, root `0600` files in a `0700` directory |
| `internal/client` | signed HTTPS client: TLS verification always on, no redirects, 15 s, 1 MiB, backoff |
| `internal/agent` | poll/report loop, desired state, assignment checks, machine state machine, deadline killer, reconcile |
| `internal/enroll` | `kete-job-host enroll` |
| `internal/state` | the durable state file |
| `internal/driver` | the `Driver` interface; `driver/fake` is the test driver |
| `internal/image` | image allowlist; `Sigstore` cosign keyless verifier (sigstore-go); `Store`: fetch by digest (go-containerregistry), blob and diff_id checks, safe unpacking (`os.Root`), `mkfs.ext4 -d` root file system cached per digest |
| `internal/hostnet` | the host table (render, `nft -f`, check by listing), taps and /30s, uplink, IP forwarding |
| `internal/driver/firecracker` | the firecracker driver: jailer arguments, VM configuration, kernel command line, jail, disks, taps, cgroups, console, re-adoption |
| `internal/kvmtest` | KVM acceptance tests (build tag `kvm`) and the guest probe (`probe/`) |
| `internal/phase` | phase-line filter and per-machine buffer |
| `internal/fakeplatform` | both routes of the contract, for tests |

## Security model

- **Pull only, signed, replay-protected.** Every request is an HTTPS `POST` signed with the host's
  Ed25519 key under the contract's fixed RFC 9421 profile (`created`, `expires` = +60 s, a fresh
  16-byte nonce). No bearer token exists.
- **Responses are trusted only through TLS** to the configured platform origin: certificate
  verification is never turned off, no environment proxy is used and redirects are never followed.
  A poll response whose `in_reply_to` isn't the nonce just sent, whose `host_id` isn't this host,
  or whose `revision` is below the applied one is discarded whole.
- **What a compromised platform can't do** (ADR 0023 rules 13, 17): make the host call another
  origin (a sealed configuration's `platform_url` must equal the configured origin), or run an
  image outside the operator's local allowlist (exact `registry/repo@sha256:…`) or without a valid
  release signature.
- **The claim token never rests.** The sealed configuration is opened in memory, validated,
  handed to the driver (config disk or pipe, P4/P5) and cleared. It is never written to the state
  file, a log or a report. HPKE base mode gives confidentiality and binding (host, machine, job,
  generation), not sender authentication — hence the checks above.
- **Files** are opened with `O_NOFOLLOW|O_CLOEXEC` and checked on the open descriptor (no
  check-then-open race). Keys and state must be root-owned with no group or other access (`0600`
  files, `0700` directories), and every ancestor of the state directory must be a root-owned
  directory, not a symlink, that group and others can't write. The configuration must be a
  root-owned regular file without group/other write (it may be world-readable), reached the same
  way. Loading also refuses a signing key whose public half is non-canonical or of small order.
- **Enrollment never loses an identity**: new keys are staged next to the current ones and
  installed (keys, then the state file) only after the platform's 201 is validated; any failure
  removes the staged keys and leaves the old keys and state untouched. The verifier (fake platform, vectors) also refuses S ≥ L and runs a dummy verification for
  unknown keys.
- **Images** (rule 17): an image runs only if the platform named it by digest, the exact reference
  is in the local allowlist, and a Sigstore bundle referrer of that digest (cosign v3, DSSE in-toto
  statement with predicate `https://sigstore.dev/cosign/sign/v1` and the digest as its only
  subject) verifies with sigstore-go: Fulcio chain, SCT, transparency log, a timestamp, issuer
  `https://token.actions.githubusercontent.com`, SAN
  `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v<semver>`
  and source repository `https://github.com/kete-org/ketecode`. The trusted root comes from
  Sigstore's TUF repository, cached in `<state_dir>/sigstore-tuf` (used without network for a day).
  A registry that can't be reached is `image_unavailable`; anything else `image_signature_invalid`.
  Every blob is downloaded whole and checked against its size and digest, and every layer against
  its config `diff_id`, before it is unpacked; unpacking goes through `os.Root` (no `..`, no
  absolute symlink or hard link out of the root), skips device nodes and FIFOs and carries no
  extended attributes. Verification and preparation run in the machine's worker, off the agent
  lock, with their own timeouts (2 and 30 min).
- **Guests** (rule 7): see "Firecracker driver" below — jailer, seccomp, no API socket, no MMDS,
  no vsock, the host table, the config disk unlinked once the VM holds it.
- **Dedicated hosts** (rule 8): the configuration is refused unless it declares a verified reset
  (`provider_rebuild`; `measured_boot` is refused until keys are TPM-resident). A generation runs
  one job: the agent spends it durably before the job starts and refuses every other machine
  until the platform has reset the server and it enrolled again (see "Dedicated hosts").
- **Deadlines hold offline**: the deadline killer runs on its own schedule and needs nothing from
  the platform.
- **Logs** are structured JSON (stderr → journald): ids, states, reasons, statuses and request ids
  only — never a token, key, ciphertext, configuration or server message text (`TestNoSecretsLeak`).

## Configuration (`/etc/kete-job-host/config.json`)

One strict JSON object (unknown fields refused), owned by the operator:

```json
{
  "platform_url": "https://portal.kete.example",
  "driver": "firecracker",
  "slots": 4,
  "reset": "none",
  "state_dir": "/var/lib/kete-job-host",
  "resolvers": ["1.1.1.1", "8.8.8.8"],
  "image_allowlist": ["ghcr.io/kete-org/kete-job@sha256:<index digest of a release>"],
  "kernel_allowlist": ["sha256:<guest kernel digest>"],
  "versions": { "firecracker": "1.13.1", "guest_kernel": "6.1.141-kete.1" }
}
```

| Field | Rule |
|---|---|
| `platform_url` | `https://` + a plain lowercase DNS host, port 443 or none, no path. Its host is the signature's `@authority` |
| `driver` | `firecracker` (needs `/dev/kvm`, `reset: none`, both `versions`) or `dedicated` (`slots: 1`, `reset: provider_rebuild`, `generation` = the verified reset generation, no `versions`; `measured_boot` refused until R2 is built) |
| `slots` | 1–32 |
| `generation` | optional for firecracker (generated at enrollment), required for dedicated |
| `state_dir` | clean absolute path, default `/var/lib/kete-job-host` |
| `resolvers` | 1–2 public IPv4 addresses (ADR 0023 rule 7): the only DNS servers guests may query, passed as the kernel `ip=` dns0/dns1 (dedicated: the job's `/etc/resolv.conf`); required by both drivers |
| `image_allowlist` | exact digest references; update with each release (`kete-job-image.digests` `index`) |
| `kernel_allowlist` | `sha256:` digests (a release's `kete-guest-kernel-*.sha256`); the guest kernel is hashed at every VM start |
| `firecracker` | the firecracker driver's section (below); required by it, refused for dedicated |
| `dedicated` | the dedicated driver's section (below); optional for it, refused for firecracker |
| `starts_blocked` | optional `"operator"`: stop starting machines (reported to the platform) |

`firecracker` section (only `kernel` is required):

| Field | Default | Rule |
|---|---|---|
| `kernel` | — | the guest kernel file (clean absolute path), e.g. `/var/lib/kete-job-host/kernels/kete-guest-kernel-6.18.55-kete.1-amd64` |
| `firecracker_bin`, `jailer_bin` | `/usr/local/bin/firecracker`, `/usr/local/bin/jailer` | `firecracker -V` / `jailer -V` must report `versions.firecracker` (doctor) |
| `guest_network` | `10.200.0.0/16` | IPv4 pool inside RFC 1918 with a /30 per slot (slot n: gateway .4n+1, guest .4n+2) |
| `uplink` | the IPv4 default route's interface | the only interface guest traffic may leave by |
| `uid_base` | `900000000` | the VM in slot n runs as uid and gid `uid_base + n` |
| `vmm_overhead_mib` | 256 | added to the job's memory for the cgroup's `memory.max` |
| `net_mbps`, `disk_mbps`, `disk_iops` | 1000, 400, 10000 | Firecracker rate limiters per VM |
| `min_free_gib` | 10 | below this in `state_dir`, starts block (`disk_space`) |

`dedicated` section (every field optional):

| Field | Default | Rule |
|---|---|---|
| `guest_network` | `10.200.0.0/30` | IPv4 network inside RFC 1918, /30 or larger; its first /30 is the job's veth (host .1, job .2) |
| `uplink` | the IPv4 default route's interface | the only interface job traffic may leave by |
| `pids_max` | 32768 | the machine cgroup's `pids.max` (256–4194304) |
| `min_free_gib` | 10 | below this in `state_dir`, starts block (`disk_space`) |

## Files

| Path | Owner / mode | Holds |
|---|---|---|
| `/usr/local/bin/kete-job-host` | root `0755` | the agent |
| `/etc/kete-job-host/config.json` | root `0644` (or `0600`) | the configuration |
| `/var/lib/kete-job-host/` | root `0700` | state directory |
| `/var/lib/kete-job-host/keys/{signing,sealing}.key` | root `0600` | raw 32-byte Ed25519 seed / X25519 private key |
| `/var/lib/kete-job-host/state.json` | root `0600` | host id, fingerprint, generation, applied revision, durable halt, `generation_spent_by` (dedicated), machines (no configuration, token or key) |
| `/var/lib/kete-job-host/images/rootfs/<manifest hex>.ext4` | root `0444` | read-only root file systems, one per image digest (pruned to the allowlist at start) |
| `/var/lib/kete-job-host/vms/<machine>/` | root `0700` | `vm.json` (slot, uid, VMM pid, console offset; no configuration), `console.log` (the serial console), `jailer.stderr` |
| `/var/lib/kete-job-host/jail/firecracker/<machine>/root/` | root `0711` | the VM's chroot: kernel and root file system (hard links), scratch disk, VM configuration, Firecracker's log; `cfg/` is a tmpfs holding the config disk only until the VM holds it |
| `/var/lib/kete-job-host/sigstore-tuf/` | root `0700` | Sigstore TUF cache |
| `/sys/fs/cgroup/kete-job-host-vms/<machine>` | — | each VMM's cgroup (`cpu.max`, `memory.max`, `pids.max`) |
| `/var/lib/kete-job-host/dedicated/<machine>/` | root `0700` | dedicated: `job.json` (reaper pid, start time, console offset; no configuration), `console.log`, `exit`, `scratch.img`, mount points `lower/`, `scratch/`, `root/` |
| `/sys/fs/cgroup/kete-job-host-jobs/<machine>` | — | the dedicated job's cgroup (`cpu.max`, `memory.max`, `memory.swap.max`, `pids.max`), its namespace root |
| `/etc/kete-job-host/enroll.token` | root `0600` | dedicated R1: the rebuild's single-use token (user data), removed by `enroll --token-file` |
| `packaging/kete-job-host.service`, `packaging/kete-job-host-enroll.service`, `packaging/install.sh` | — | the systemd units (agent; dedicated first-boot enrollment) and the installer |

## Commands and exit codes

```sh
kete-job-host enroll [--config PATH] [--replace] < token   # prints the key fingerprint
kete-job-host enroll [--config PATH] --token-file PATH      # dedicated first boot after a rebuild
kete-job-host run [--config PATH] [--debug]                 # the service
kete-job-host doctor [--config PATH]                        # checks only
kete-job-host fingerprint [--config PATH]
kete-job-host version
```

Exit codes: `0` done, `1` failed, `2` usage or configuration (including a driver that can't be built from it), `3`
halted — the platform revoked the host, its generation no longer matches, or it refuses the key.
The unit doesn't restart on `3` (`RestartPreventExitStatus=3`): an operator re-enrolls
(`enroll --replace` with a new token) or fixes the enrollment.

## Enrollment

1. A platform admin creates the host on `/admin/job-hosts` (P3) and copies the single-use token
   (`kete_jhe_…`, 1 hour).
2. On the host: `printf '%s\n' "$TOKEN" | sudo kete-job-host enroll` — never pass it as an argument
   or environment variable. The agent generates both keys, prints the fingerprint in groups of 4,
   and sends the signed enrollment request (`keyid` = the fingerprint).
3. The admin approves after comparing fingerprints. Until then polls answer `host_pending`.

`enroll` refuses an enrolled host unless `--replace` (refused while the state holds a live
machine), and refuses a dedicated host whose generation already ran its job (only a reset gives it
a new identity). `--token-file PATH` reads the token from a root-owned `0600` file instead of stdin
(no symlink, root-owned ancestors) and removes it on a definitive answer — accepted, `enrollment_token_invalid` or `key_in_use` (the
token is spent) — or when it is malformed; a network error, 429, 5xx or clock skew keeps it for a
retry. An `active`
answer means the platform approved the enrollment itself (an R1 rebuild it started). The new keys stay staged until the platform accepts them: a refused token, `key_in_use`,
a 5xx or a network failure removes them and keeps the old identity. Run `enroll` again with a new
token.

## The poll loop

Every 10 s (the response's `next_poll_after`, 1–60 s, overrides) the agent sends its report and
applies the desired state. Before each poll it checks the kernel's NTP status (`adjtimex`); while
the clock is unsynchronised it sends nothing. Each request has 15 s; after a network error, a 5xx,
a 429 or an unexpected 4xx it backs off exponentially from 10 s to 5 min with jitter (honouring
`Retry-After`).

| Answer | Agent action |
|---|---|
| 200, fresh | phase lines acknowledged; every held machine not in `run` (or in `destroy`) destroyed, reason `desired`; new `run` entries prepared; tombstones forgotten once a fresh answer to a report carrying them names them nowhere; `applied_revision` updated |
| 200, discarded (`in_reply_to`, `host_id`, invalid body, lower `revision`) | nothing applied; phase lines resent; back off |
| `host_pending` | retry in 30–60 s; no machines |
| `host_disabled` | destroy every machine (`host_disabled`); retry in 60 s |
| `host_revoked`, `generation_mismatch` | destroy every machine; halt durably (state file); exit 3 |
| `signature_invalid` | stop polling, keep supervising machines until none is left; exit 3. **While halted with machines the host reports nothing**: the platform sees a stale host (`status` `unavailable`) until those machines end or the deadline killer destroys them (at most deadline + 5 min, 135 min of age) |
| `clock_skew` | retry in 10 s (NTP is checked first) |
| `nonce_replayed` | retry in 1 s with a fresh nonce |
| anything else | back off |

## Machines

States: `preparing → starting → running → stopping → destroyed`, or `failed` (never ran).
An assignment is checked in this order, the first failure being its `failed` reason:
`deadline_passed` → `starts_blocked` → `no_free_slot` → `image_not_allowed` →
`image_signature_invalid` → `config_undecryptable` (HPKE open, binding = this host, the machine,
the job, the host's generation) → `platform_mismatch` → `config_invalid` (strict, canonical
`JobMachineConfig`, the assignment's job id, `microvm` for firecracker / `dedicated` for
dedicated; also a run entry without a config) → `generation_mismatch` (dedicated) → driver start
(`driver_failed`). A machine id is never started twice.

**Driver calls** each have a timeout (Start 2 min, Stop 1 min, Status and Logs 10 s, List 30 s)
and run in one worker per machine, without the agent's table lock: the driver never sees two
calls for one machine at once, and a hung call holds up only its own machine. A driver must honour
its context (`internal/driver/driver.go` lists the driver contract).

The **host isolation check** (every 5 s, `driver.IsolationGuard`; firecracker: the host table)
destroys every live machine with `host_isolation_lost` when it fails and blocks starts until the
agent restarts (fail closed, no platform needed). `host_isolation_lost` is a kete-code addition to
the machine reasons that the platform's job-host-v1 contract must adopt before P3.

The **deadline killer** (every 2 s, independent of polling and started before reconcile) destroys a machine past its deadline
plus 5 min (`deadline`) or older than 135 min from acceptance (`max_age`). A guest that powers off
is `exited`; a dead VMM or a vanished machine `crashed`.

**Restart reconcile** (at start, retried with backoff while the driver can't list or stop; polling
waits for it, the deadline killer doesn't): every machine the driver holds without a live state record
is stopped and reported `destroyed` (`desired`, `job_id` null); a record whose machine vanished is
`destroyed` (`crashed`, or its pending stop reason); a running machine is re-adopted; a record
still `preparing` is dropped (the platform delivers it again). With a durable halt in the state
file (revoked, generation mismatch) every machine is destroyed and the agent exits 3.

**Phase lines** (rule 19): only lines that parse strictly as the contract's phase line; raw lines
over 512 bytes are dropped unparsed; at most 200 per machine per report; the rest are counted in
`phase_lines_dropped`. They live in memory only (lost on restart).

## Firecracker driver

Per VM (`Start`): the host table is re-checked; the root file system (prepared earlier) and the
guest kernel are hard-linked into the jail, and the kernel's SHA-256 must be in
`kernel_allowlist`; a sparse scratch disk of `scratch_gib` is formatted ext4 with the label
`kete-scratch` (kete-job-init's overlay upper); the config disk is `seal.ConfigDisk` of the
canonical configuration (jail uid, `0600`) on a 64 KiB tmpfs mounted at the jail's `cfg/`, so the
claim token never reaches a persistent file system; a tap `kjh<slot>` owned by the jail uid gets the /30's
gateway address and no IPv6; then the jailer starts Firecracker with its own uid/gid, a chroot, the
default seccomp filters, a new PID namespace, `cpu.max`/`memory.max`/`pids.max` in
`kete-job-host-vms/<machine>`, `--config-file` and `--no-api` (no API socket, no MMDS, no vsock),
stdout (the serial console) to `console.log`. Once Firecracker holds the config disk open (matched
by inode in `/proc/<pid>/fd`), the file is unlinked and the tmpfs detached. Kernel command line: `console=ttyS0 reboot=k
panic=1 pci=off quiet loglevel=1 init=/usr/local/libexec/kete/kete-job-init
ip=<guest>::<gateway>:255.255.255.252::eth0:off:<dns0>:<dns1>` (Firecracker adds `root=/dev/vda
ro`). Golden files: `internal/driver/firecracker/testdata/`.

`Status`: the VMM (pid, start time and cgroup recorded in `vm.json`) alive → `running`; gone with
Firecracker's log saying "Firecracker exiting successfully" (a guest reboot: kete-job-init's end,
or a panic with `panic=1`) → `exited`; otherwise `crashed`. `Stop`: `cgroup.kill` (or, before
Linux 5.14, SIGKILL to every pid in `cgroup.procs` until it is empty), detach the config tmpfs,
remove the cgroup, the tap, the jail and the record — idempotent, and an error while anything remains.
`List`: every machine with a record, a jail or a cgroup. `Logs`: new complete console lines (≤ 256
KiB per call, offset persisted, the file truncated past 8 MiB once read); the agent keeps only
phase lines, which carry no free text.

**Host table** `inet kete-job-host` (`internal/hostnet/testdata/*.nft`): input drops everything
from `kjh*`; forward sends guest traffic through `guest_out` — IPv4 only, source routed back
through its own tap (`fib saddr . iif oif missing`) and inside the pool, out of the uplink only (so
no other guest or host interface), no RFC 1918, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`,
`0.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, then DNS (UDP/TCP 53)
to the resolvers and TCP 443 — and replies back through `guest_in`; postrouting masquerades the
pool on the uplink. Applied at start (`nft -f`, atomic) and checked against its own listing before
each start and **every 5 s** by the agent's isolation check (`Agent.CheckIsolation`, its own loop in
`Run`, independent of the platform and of the deadline killer). Missing or changed → **fail
closed**: every live machine is destroyed at once (reason `host_isolation_lost`, plus an agent phase
line `host_isolation` `failed` code `host_table`), starts stay blocked (`host_table`), and the table
is re-applied only when the agent restarts. A host whose iptables FORWARD policy is DROP (Docker) also drops guest traffic
after this table: such a host should not run Docker.

VMs survive an agent restart or stop (`KillMode=mixed`; each VMM is in its own cgroup and PID
namespace, nobody's child), and reconcile re-adopts or destroys them (ADR 0023 rule 12).

## Dedicated driver

`internal/driver/dedicated` (ADR 0023 rule 8). One job at a time, directly on the host; the job's
namespaces keep the host's processes, sockets and files out of its view but are **not a security
boundary** (job root is host root), which is why the host runs one job per identity:

- **Root file system:** the image store's verified read-only ext4 (the same cache as firecracker)
  loop-mounted read-only at `<state>/dedicated/<machine>/lower`, a fresh sparse ext4 scratch file
  (`resources.scratch_gib`) loop-mounted at `scratch/`, their overlay at `root/` (loop devices
  auto-clear on unmount).
- **Launch:** the agent re-executes itself as the reaper, `kete-job-host __dedicated-init`, PID 1
  of new mount, PID, network, IPC and UTS namespaces, cloned straight into
  `/sys/fs/cgroup/kete-job-host-jobs/<machine>` (`cpu.max` = vCPUs, `memory.max`,
  `memory.swap.max` 0, `pids.max`); it unshares a cgroup namespace rooted there, so the entrypoint
  subdivides its own cgroup as under Docker's private cgroupns. The agent creates the veth `kjh0`
  (host, the /30's .1) ↔ `eth0` (job, .2) in the reaper's network namespace, then sends it the
  init spec; the reaper configures `eth0` with the host's `ip` (before pivoting: the image may have
  none), makes every mount private, mounts `/proc`, a read-only `/sys`, a tmpfs `/dev` with only
  null/zero/full/random/urandom/tty, devpts, `/dev/shm`, `/run` and cgroup2, pivots into the
  overlay, sets the hostname `kete-job` and writes `/etc/resolv.conf` (the configured resolvers)
  and `/etc/hosts` from inside (an image link can't redirect them to a host file).
- **Configuration:** on a pipe only (`--config-fd 3`, a FIFO, written by the agent before the
  reaper starts and closed; it waits in the kernel's pipe buffer until the entrypoint reads it),
  with `KETE_JOB_HOST_PROFILE=dedicated` and `PATH` as the entrypoint's whole environment; the
  generation travels in the configuration's `host_generation`. No other descriptor of the agent's
  reaches the entrypoint.
- **Reaping:** the reaper reaps every orphan (so the entrypoint's end-of-job check never counts
  zombies as live job processes: P1's `processes_alive`), protects itself from the OOM killer
  after forking the entrypoint, and when the entrypoint exits kills what is left of the namespace
  and writes `exited <code>` to the machine's `exit` file: `Status` is then `exited`; a reaper gone
  without it is `crashed`. Stdout and stderr go to `console.log` (phase lines, as firecracker's
  serial console).
- **Network:** the host table (`hostnet`) is the firecracker one, unchanged: the veth is named
  like a tap (`kjh*`), so input to the host, other interfaces, RFC 1918/CGNAT/link-local/IPv6 are
  dropped and only DNS to the resolvers and TCP 443 leave through the uplink, masqueraded. Checked
  every 5 s and before the start (`IsolationGuard`); lost → the job is destroyed.
- **Stop:** `cgroup.kill` on the machine's tree, the tree removed bottom-up, the veth, the three
  mounts (detached; a directory still mounted is never deleted through), the machine directory.
  The job survives an agent restart (own cgroup, own namespaces); the restarted agent re-adopts
  it (`job.json`: pid + start time + cgroup). Under systemd the agent's mounts live in its unit's
  mount namespace and vanish with it; the job keeps its own copies, and `Stop` then finds plain
  directories.

## Dedicated hosts

ADR 0023 rule 8. A dedicated host's identity (keys, `generation`) is good for **one job**:

- **The agent spends the generation** when the first machine reaches `starting` (after the
  signature, the sealed configuration's checks — `host_generation` must equal the host's — and
  the image preparation; nothing of the job has run before that), durably in `state.json`
  (`generation_spent_by`, a failed save fails the start). From then on every other machine fails
  `starts_blocked`, reports carry `starts_blocked: "generation_spent"` and `free: 0`, across
  restarts, a replay of the spending machine's id included (a machine still `preparing` at a
  restart never spent it and is simply delivered again). `enroll` refuses a spent host, even with `--replace`.
- **R1 `provider_rebuild` (built, agent side):** the platform rebuilds the server through the
  provider's API from the pinned host image (built with `packaging/install.sh --driver dedicated`:
  agent, sysctl, both units enabled), with user data that writes
  `/etc/kete-job-host/config.json` (driver `dedicated`, reset `provider_rebuild`, the rebuild's
  `generation`, resolvers, image allowlist) and `/etc/kete-job-host/enroll.token` (root `0600`, a
  fresh single-use token). On first boot `kete-job-host-enroll.service` runs `enroll --token-file`;
  the platform answers `active` because the token belongs to the rebuild it started; the agent
  starts and polls. After the job the platform revokes the identity (the agent halts, exit 3) and
  rebuilds again. `TestDedicatedR1Cycle` runs this against the fake platform and a fake provider.
- **R2 `measured_boot` (not built):** `internal/reset` holds the agent-side interface
  (`Attestor`: TPM-resident public keys, a quote over the platform's nonce) and `Detect`, which
  refuses (`ErrNoTPM`, else `ErrNotImplemented`); `config.Parse` refuses `measured_boot`. Remaining:
  keys generated in the TPM and sealed to the PCR policy of the signed image (go-tpm or similar;
  Ed25519 isn't a TPM algorithm, so the contract needs an ECDSA P-256 host key and an HPKE suite
  the TPM can serve, or a TPM-sealed file key), quote generation with the event log, a contract
  route/field carrying the nonce and the quote, the signed read-only host image (UKI, Secure Boot,
  dm-verity root, tmpfs overlay, per-boot encrypted scratch) and reboot-after-job, CI with `swtpm`.

## Guest kernel

`kernel/`: Linux **6.18 LTS** (Firecracker supports 6.18 from v1.16.1; its 6.1 support ended
2026-09-02), pinned by version and tarball SHA-256 in `build.sh`; `config-amd64` and
`config-arm64` are Firecracker v1.17.0's validated guest configurations plus `kete.fragment`
(nftables `inet` with ct/reject, IPv6 compiled in for `inet` but never routed, cgroup v2
cpu/memory/pids, user namespaces, overlayfs, ext4, virtio-blk/net/mmio, `IP_PNP`, serial console,
no modules, no vsock, no `/dev/mem`, `PANIC_TIMEOUT=1`). `check-config.sh` checks them (CI).
`build.sh <amd64|arm64>` builds reproducibly in a pinned Debian image with packages from a fixed
snapshot and fixed build metadata, refuses a config that `olddefconfig` would change, and writes
`kete-guest-kernel-<release>-<arch>` (amd64 `vmlinux`, arm64 `Image`) and its `.sha256`. The
release (`kete-release.yml` `kernel`, `kernel-publish`) builds both, signs each with cosign
`sign-blob` (same identity as the job images) and attaches them with their bundles. To bump: new
`LINUX_VERSION`/`LINUX_SHA256`, `--regen-config` for both arches **and both variants**, review the
diff, release, update hosts' `kernel_allowlist`.

**cloudvm variant** (self-hosted P7): the same source and pins build the kernel of the VM-per-job
provider images (`packages/kete-job-image/packer`): `config-cloudvm-<arch>` is Firecracker's base
plus `kete.fragment` (so every microvm hardening term holds) plus `cloudvm.fragment` and
`cloudvm-<arch>.fragment`: EFI and the EFI stub, GPT partitions (`root=PARTLABEL=`: no
initramfs), ACPI/PCI, the DHCP-capable `IP_PNP`, virtio-pci (legacy too, for GCP) blk/scsi/net,
`sd`, NVMe, gVNIC, RTCs (CMOS on amd64; EFI and PL031 on arm64), virtio-rng, 8250 and (arm64) PL011
consoles, all built in (the image has no module loader). It only adds options to the microvm
configuration; `check-config.sh` checks it against all three fragments.
`build.sh <arch> --variant cloudvm` writes `kete-cloudvm-kernel-<release>-<arch>` (amd64
`bzImage`, arm64 `Image`), its `.sha256` and its resolved `.config`; it isn't allowlisted or signed
on its own (it only goes into provider images, built by CI from the release:
`kete-cloudvm-images.yml`). The arm64 build reproduced bit for bit (P7).

## Installing a host

Dedicated: `packaging/install.sh --driver dedicated --agent …` (root) installs the agent, the
sysctl and both units (`kete-job-host.service`, `kete-job-host-enroll.service`), enabled but not
started, for a provider host image (see "Dedicated hosts"); `doctor` adds `/dev/loop-control`, the
reset and whether the generation already ran its job.

Firecracker: `packaging/install.sh --agent … --firecracker … --jailer … --firecracker-sha256 … --jailer-sha256
… --kernel … --kernel-sha256 sha256:…` (root): checks the tools (`nft`, `ip`, `mkfs.ext4`), cgroup
v2 and `/dev/kvm`, verifies every artifact's SHA-256, installs the binaries, the kernel under
`/var/lib/kete-job-host/kernels/`, `net.ipv4.ip_forward = 1` (`/etc/sysctl.d/90-kete-job-host.conf`)
and the unit. It never enrolls, starts the service or downloads anything. Then write the
configuration, enroll, run `kete-job-host doctor` (firecracker checks: cgroup v2 controllers,
Firecracker and jailer versions, the kernel's digest, IP forwarding, `mkfs.ext4`, `ip`, the
uplink, `nft -c` of the table, the live table, free space) and `systemctl enable --now
kete-job-host`.

## Building

```sh
CGO_ENABLED=0 go build -trimpath -ldflags="-s -X main.version=0.1.0" -o dist/kete-job-host ./cmd/kete-job-host
```

Dependencies: the standard library (HPKE is Go 1.26's `crypto/hpke`), `golang.org/x/sys`,
**go-containerregistry** (Apache-2.0; registry client: manifests, blobs, referrers, auth; image
fetch by digest) and **sigstore-go** (Apache-2.0; the Sigstore project's verifier: bundles,
Fulcio, Rekor, CT, TSA, TUF). They are large (about 70 indirect modules; the stripped binary is about
19 MB): verifying a keyless signature means certificate-chain, SCT, transparency-log and
timestamp checks that CLAUDE.md forbids re-implementing ("never invent cryptography"), and the
agent ships only to Kete's job hosts, never with the CLI, the image or the extension.

## How to test

No Go is needed locally (Docker or Colima). The tests run as root (the container's default user;
`sudo` in CI): the agent refuses files not owned by root, and the tests create their state under a
fresh root-owned directory below `/` (`internal/testroot`).

```sh
docker run --rm --privileged -v "$PWD/packages/kete-job-host:/src" -w /src golang:1.26-bookworm \
  sh -c 'apt-get update -qq && apt-get install -y -qq nftables iproute2 >/dev/null; test -z "$(gofmt -l .)" && go vet ./... && go vet -tags kvm ./... && go test -race ./...'
```

`--privileged` lets the host-table tests apply and check the table in the container's own network
namespace (without it, or without `nft`, they skip). The rootfs tests need root and `mkfs.ext4`.
The dedicated driver's tests (`internal/driver/dedicated`) launch a real job — the test binary as
the reaper and, copied with its libraries into a test ext4 image, as the entrypoint — and need
root, `--privileged`, loop devices, cgroup v2, `ip` (add `iproute2` to the `apt-get install`) and
`mkfs.ext4`; they skip otherwise.

**KVM acceptance tests** (`internal/kvmtest`, build tag `kvm`) run on a Linux host with `/dev/kvm`
as root: `sudo scripts/kvm-test.sh <dir>` with `kvm.test`, `probe`, `firecracker`, `jailer`, a
guest kernel, `kete-job.tar` (`docker save` of the job image) and `kete-job-fake-platform` in
`<dir>` (the script's header says how to build each); an optional `kete-job-entrypoint` there
replaces the image's in `TestRealJob` (tests this checkout's entrypoint without an image rebuild). `TestGuestIsolation`: two concurrent guests,
guest root with no in-guest firewall, can reach TCP 443 and UDP 53 on the resolver and nothing else
— not the host (its tap address, uplink address, ICMP, SSH), not each other, not RFC 1918, CGNAT,
`169.254.169.254` or IPv6 — and power off by themselves (`exited`). `TestRealJob`: the job image
(plus the fake's test CA) under the agent reaches `setup_host`, `host_boundary`, `isolation` and
`claim` against the entrypoint's fake platform. `TestLifecycle`: the VMM's uid/gid, seccomp, no
capabilities, own PID namespace and cgroup limits; an agent restart re-adopts a running VM; the
deadline killer destroys it offline; a withdrawn VM is cleaned up; a hand-deleted table blocks
starts and is reported. Each checks that no tap, jail, record, cgroup or VMM is left.
`TestDedicatedRealJob` (no KVM needed: `sudo scripts/kvm-test.sh <dir> TestDedicated` needs only
`kvm.test`, `probe`, `kete-job.tar` and `kete-job-fake-platform`): the job image under the
dedicated driver runs a whole job (`setup_host`, `host_boundary`, `isolation`, `claim` … `finish`)
against the entrypoint's fake platform; a second assignment in the generation fails
`starts_blocked`; nothing is left. `TestDedicatedLifecycle`: job root with no firewall (the probe)
reaches only TCP 443 and DNS to the resolver; the job survives an agent restart and is re-adopted;
the deadline killer destroys it offline; a deleted host table destroys a job of a second host.

Cross-check the vector copies against a platform checkout:
`-v <platform>/docs/contracts/test-vectors/job-host-v1:/pv:ro -e KETE_PLATFORM_VECTORS=/pv`.
CI: `.github/workflows/kete-job-host.yml` (path-filtered).

What the tests cover: every case of the three vector files (`internal/sig`, `internal/seal`); the
whole lifecycle over real TLS against the fake platform (`TestLifecycle`); every assignment refusal
(`TestAssignmentRefusals`, `TestNoFreeSlot`, `TestDedicatedGenerationMismatch`); discarded and
stale responses (`TestReplayAndStale`); clock, skew and nonce replay (`TestClockAndNonce`); host
states (`TestHostStates`); restart reconcile and the deadline killer offline
(`TestRestartReconcile`, `TestDeadlineKiller`); the killer while reconcile fails, hung driver calls
and a halt found at start (`TestKillerRunsWhileReconcileFails`, `TestHangingDriver`,
`TestHangingStart`, `TestHaltedAtStartupDestroysAll`); staged re-enrollment
(`TestReplaceKeepsOldIdentityOnFailure`); the file rules (`internal/fsutil`, `internal/config`); the real loop (`TestRunLoop`); and that no token,
key or configuration reaches a log, the state file or a report (`TestNoSecretsLeak`); signature
checks and image preparation off the agent lock and in the contract's order
(`TestSlowVerifyOffTheLock`, `TestStopWhileVerifying`, `TestImageUnavailableAndPrepare`,
`TestDriverBlocksStarts`); the cosign verifier against a real bundle (`internal/image`
`TestVerifyBundle`, `TestVerifyFromRegistry`); rootfs conversion and refusals
(`TestRootfsConversion`, `TestRootfsRefusals`, `TestRootfsTamperedBlob`); the host table
(`internal/hostnet`); the driver's rendering, config disk and file handling
(`internal/driver/firecracker`); one job per generation, R1 and the token file
(`TestDedicatedOneJobPerGeneration`, `TestDedicatedSpentOnlyByAStart`, `TestDedicatedR1Cycle`,
`TestTokenFile`, `TestEnrollRefusesSpentGeneration`); the dedicated driver for real
(`TestJobRunsAndExits`, `TestOneAtATimeStopAndCrash`, `TestStartFailureCleansUp`); R2's refusal
(`internal/reset`).

## Not built yet

- R2 `measured_boot` ("Dedicated hosts"); the platform side of dedicated hosts (generation
  tracking, the R1 rebuild orchestrator and provider client, auto-approval, R2 quote verification,
  and `generation_spent` in its `JobHostStartsBlocked`).
- The platform routes (P3); until then nothing answers this agent outside tests.
