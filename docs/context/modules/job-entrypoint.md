---
module: job-entrypoint
paths: [packages/kete-job-entrypoint/**, .github/workflows/kete-job-entrypoint.yml]
verified-at: e2f31003c6
---

## Quick answers
- What is this module? `kete-job-entrypoint`, the cloud job container's **root** entrypoint (piece C
  of the image work; kete-code-platform `docs/jobs.md` §8 items 1-2, ADRs 0018-0021). It sets up
  the machine, guards the network with `kete-egress`, starts `kete-root-helper`, claims the job,
  clones, runs `kete job run` as the `kete` user, and reports the result, audit log, proxy log and
  a safe change bundle. Linux-only Go; ships in the job image (piece D), never with the CLI or VS
  Code. Task: `docs/tasks/2026-09-30-job-entrypoint/` (PR 1 = this module; PR 2 = the image).
- Where's the contract? `packages/kete-job-entrypoint/README.md`: Machine configuration
  (`README.md:25-44`), Layout (`:46-73`), Steps (`:74-153`), Fly guard and isolation check
  (`:154-196`), Claim response checks (`:197-204`), Environments (`:205-226`), Hardened git
  (`:227-240`), Credentials (`:241-250`), Bundle (`:251-299`), Launching (`:300-309`), How to test
  (`:310-358`), Not verified without Fly (`:359-371`), Staging runbook (`:372-405`). `contracts.md`
  §6d summarises it.
- How does the entrypoint know which host it's on (self-hosted P1, ADR 0023 rule 16)? Host profiles
  `fly`, `microvm`, `dedicated`, `cloudvm` (`internal/hostprofile`). Boot: `bootenv.FromEnv` (env
  path: the four vars + optional `KETE_JOB_HOST_PROFILE`; `hostprofile.Resolve`: unset → `fly` only
  with a Fly signal (`FLY_*` var or `/.fly`), else exit 2; must resolve to `fly`) or, with
  `--config-fd <n>` (a FIFO only, `bootenv.ReadConfigFD`), `bootenv.FromConfig` (strict JSON
  `bootenv.Config`: the four + `host_profile`, `host_provider` (cloudvm), `host_generation`
  (dedicated); the four env vars must be unset; an env profile must match). `Values` carries
  `Profile`, `Source`, `Provider`, `Generation` across the handover (re-validated in `Decode`).
  Setup: step `setup_host` (`entry.hostCheck`, first after `boot`) = `hostprofile.Gather` (reads
  `/.fly`, `/proc/1/exe` vs `layout.InitBin`, virtio id `0x0013` under `/sys/bus/virtio/devices`,
  DMI under `/sys/class/dmi/id`) + `hostprofile.Check` → codes `fly_signals`, `missing`, `source`,
  `init`, `vsock`, `dmi`, `generation`, `invalid` (empty profile). Then `fly` → `flyGuard`
  (unchanged); others → `hostBoundary`. README "Host profiles".
- What is the host-boundary probe? Step `host_boundary` (`entry.hostBoundary`, every profile but
  fly, at the Fly guard's place: as root before the firewall): `hostprofile.FindConfigDisk`
  (any block device starting `kete-job-config v1\n` → `config_disk`); no IPv4 default gateway →
  `probe`; cloudvm: `nft -j list table inet kete_job_init` must pass `hostprofile.VerifyMetadataDrop`
  (exactly init's chain and two drop rules; `metadata_drop`); then `isolation.Check` in-process with `SysNet`
  over `isolation.Controls(tcp, "")` + `hostprofile.BoundaryTargets(gateways)` (gateways from
  `layout.RouteFile` via `hostprofile.DefaultGateways`; sample ports, metadata, private, IPv6 lists
  in `hostprofile.go`) → `gateway`, `metadata`, `private_range`, `ipv6`, `probe`. The tool-user
  isolation check off Fly: `Inputs.OffFly` (no `[fdaa::3]`, 6PN, Fly socket) + `Inputs.Extra` =
  `hostprofile.IsolationTargets` (boundary targets, every block device node as `KindFile` →
  `guarded_path`, dedicated's agent dirs). Fly's probe list is byte-for-byte today's.
- What is kete-job-init? `cmd/kete-job-init` + `internal/guestinit`, same module, in the image at
  `/usr/local/libexec/kete/kete-job-init`, unused on Fly: PID 1 of microvm/cloudvm guests. `Stage1`
  (mounts, console, ext4 `kete-scratch` (also a partition: layout `SysBlockDir` = `/sys/class/block`) → overlay + `pivot_root` + re-exec `__guest`), `Stage2` →
  `Run(ctx, Deps, log)` (testable orchestration: mounts → network (`Machine.Network`, `init_linux.go:276`: cmdline `kete.net=dhcp` → own DHCP client then resolvers from `kete.dns`, else the kernel's `ip=`, resolvers from
  `/proc/net/pnp` minus link-local) → config (config disk → microvm: `ParseConfigDisk`, unbind;
  else provider by DMI → `UserDataClient.Fetch` → `ParseUserData`, cloudvm) → cloudvm
  `MetadataDrop` (`ApplyMetadataDrop`: `hostprofile.MetadataDropRuleset`, listed back, probe) →
  `StartEntrypoint` (`--config-fd 3`) → `Wait`/`Reap` → `Shutdown` (microvm Restart, else PowerOff;
  every failure powers off without starting the entrypoint; `Run` and both stages recover panics and
  power off; the guest kernel needs `panic=1`, a P4 requirement). README "kete-job-init".
- What does the platform's Fly adapter have to set? Four env vars (D3, plus one from the security
  review): `KETE_JOB_ID`, `KETE_JOB_PLATFORM_URL`, `KETE_JOB_CLAIM_TOKEN`, `KETE_JOB_STORAGE_HOST`
  (`internal/bootenv/bootenv.go`; `README.md:25-44`). Any other variable is ignored, except that
  whether one of Fly's own `FLY_MACHINE_ID`/`FLY_ALLOC_ID`/`FLY_APP_NAME`/`FLY_REGION`/
  `FLY_PRIVATE_IP` is set crosses the re-exec as one bit (`Values.OnFly`, `bootenv.FlyVars`; never
  a value) for the Fly guard. Invalid → exit 2, no callback. `KETE_JOB_STORAGE_HOST` is the **only** host signed upload URLs may name
  (`internal/platform/claim.go:245`), and the claim is refused (`storage_host`) if it equals the
  gateway or clone host, or (GitHub only) the clone-API host (`claim.go:199`).
- How are Harness Code repositories cloned (jobs-v1 additive, 2026-10-05; platform ADR 0024,
  kete-org/ketecode-portal#68)? The claim request sends `features: ["clone_revoke_callback"]`
  (`platform.go:195`); the response's optional `clone.provider` (absent = `github`; else
  `harness_code`; anything else, `null` included, → `clone.provider`) and `clone.username` (absent
  = `x-access-token`; printable, no `:`, ≤ 128 → `clone.username`) are read raw
  (`claim.go:137`, `Claim.CloneProvider`, `CloneUsername`, `CloneAPIHost` = GitHub's revoke host,
  empty for Harness). The clone header is `gitops.BasicHeader(username, token)`; `gitops.Scrub`
  redacts the token, `base64(username:token)` (claim's and default username) and any
  `Authorization` line. GitHub: `Revoke` as before, then `CloneDone` best effort. Harness: **no**
  git-host API call; `CloneDone` (`POST …/clone-done`, `{}`, ≤ 3 tries, `platform.go:296`) after
  verify, and `failClone` (`job.go:447`) calls it on a refused branch, clone failure and verify
  failure (HEAD ≠ `base_sha` included) before finalising; a failure is the events message "clone
  token revoke failed", a 404 = gone (`job.go:425`). Clone-phase root allowlist = `uniq(platform,
  clone host, CloneAPIHost)` (`job.go:458`), so exactly `{platform, clone host}` for Harness; no
  later phase lists the git host. Phase step `clone_done`. **Release order:** platforms before #68
  reject `features`, so an image with this entrypoint ships only after #68 is deployed.
- Step order? Boot (validate env, re-exec `/proc/self/exe __run` with only `PATH`, so the claim
  token leaves `/proc/<pid>/environ`) → `setup_host` → users, sysctls, `/proc hidepid=2`, **Fly
  guard** (fly) or **host-boundary probe** (others), dirs,
  cgroups → firewall (`kete-egress nft | nft -f -`) → proxy instance 1 (root → platform only) →
  helper → **isolation check** → **claim** → proxy instance 2 (full allowlists) → clone, verify `base_sha`, revoke the
  clone token (GitHub revoke + `clone-done`; Harness Code `clone-done` only), agent copy → agent (`kete job run`) → stop agents (helper SIGTERM, `cgroup.kill`,
  `/proc` uid scan) → result → bundle → uploads → proxy instance 3 (adds the storage host) → PUTs →
  finish. Any failure before claim exits 1 **with no claim**. Code: `internal/entry/entry_linux.go:40`
  (machine setup and starts), `internal/job/job.go:175` (`run`), `:458` (`afterClaim`), `:666`
  (`finalize`).
- How does the Fly guard fail closed (security review, 2026-10-03)? `setup.LockFly(dir, onFly)`
  (`internal/setup/setup_linux.go`): on Fly (`boot.OnFly` or `/.fly` exists) a missing `/.fly` or
  `/.fly/api` is `setup.ErrFlyAPIMissing` → phase `setup_fly` failed `missing`; else `/.fly` →
  root 0700 and `/.fly/api` → root 0600, read back; off Fly (no variable, no dir) a no-op. Then
  `flyGuard` (`entry_linux.go:160`) runs the probe as the tool user with `isolation.FlyProbes`
  (control + `/.fly/api`): reachable → `fly_api`. Only `/.fly/api` is documented by Fly
  (`setup.FlyAPISockets`); a socket elsewhere is caught by the isolation check's
  `/proc/net/unix` sweep (`unix_socket`). Tests: `setup_linux_test.go` (root, in the golang
  container), `TestFlyGuardMissingAPISocket`, `TestFlyGuardLocks`, `TestBinaryBootOnFly`.
- What is the isolation check? `internal/isolation`: after the helper, before claim
  (`job.go:200`, `Machine.CheckIsolation`, `entry_linux.go:303`), the entrypoint re-executes itself
  as `__isolation_probe` through `launch` as the tool user (uid `kete-tool`, gid `kete-job`, no
  groups, NNP, only `PATH` in env, leaf cgroup `<tool>/isolation`, removed after) with a JSON probe
  list on fd 3 and reads one code from stdout. Probes (`isolation.Build`): controls
  (`isolation.Controls`: a root TCP listener on `127.0.0.1:<ephemeral>`, a root abstract unix
  listener, opening `/`; each must succeed), `/.fly/api`, the helper socket, every listening
  stream/seqpacket unix socket from `/proc/net/unix` (path or `@abstract`), kete's home and TMPDIR
  (open for read), `169.254.169.254:{80,443}`, `[fdaa::3]:{80,443,4280}` and the machine's own
  `fdaa::/16` addresses on 1-1023 + 4280, resolvers (resolv.conf + `[fdaa::3]:53`, TCP and a UDP
  DNS query), `127.0.0.1`/`::1` TCP 1-1023 except port B. 300 ms per attempt (controls get up to
  `isolation.ControlAttempts` = 3 attempts: a busy or nested-virtualized guest right after boot can
  miss one; no other probe is retried), 64 workers, 10 s
  budget (cut-off attempts and resource errors `EMFILE`/`ENFILE`/`ENOBUFS`/`ENOMEM`, i.e.
  `isolation.ErrInconclusive`, → `probe`; a unix `EAGAIN` counts as reached), launch-to-answer 20 s
  (`layout.ProbeTimeout`); `Run` also stops on ctx cancellation (SIGKILLs the probe). Codes
  (`phaselog`, priority order `isolation.Priority`): `control`, `fly_api`, `helper_socket`,
  `unix_socket`, `kete_dir`, `metadata`, `sixpn`, `resolver`, `loopback`, plus `probe` (didn't
  launch/finish/answer; class + errno on the line). `isolation.Check` takes a `Net` interface, so
  unit tests use fakes (`isolation_test.go`). With the firewall up every refusal is an nft reject,
  so the check takes milliseconds. It never touches port B itself (the proxy would log a
  refused empty connection), hence the separate control listener.
- Why three proxy instances? D2 (user decision): egress config v1 fixes hosts at start and the
  gateway host arrives only with `claim`, the storage host only with `uploads`. So the proxy is
  restarted between phases **only while no job-user process exists**, keeping the same listener
  fds and log fd (`job.go:184,419-423,763`; the egress card).
- Failure → outcome codes? Entrypoint-written result v1: `error` (1), `refused` (2, clone HEAD ≠
  `base_sha`), `deadline` (1, effective timeout < 1 min), `proxy_failed` (1), `time_limit` (3,
  backstop at effective timeout + 3 min). `finish.push_error`: `processes_alive`, `symlink`,
  `unreadable` (also over-limit bundles, D10), `proxy_failed` (`job.go:25-28`; `README.md:141-144`).
  Any callback 404 → kill everything, no more callbacks, exit 0. Hard deadline (the claim's
  `deadline`) → SIGKILL helper, `cgroup.kill` both job cgroups, close proxy, exit 1, no callbacks.
- What if a job process survives the kill? `processes_alive`: the proxy is **never** restarted while
  a job uid lives. `result` and `finish` go through the instance already in `report` (root →
  platform only), nothing is uploaded; with no such instance, nothing is reported and it exits 1
  (sweeper marks it lost) (`job.go:639-655`). Security-review fix 1.
- Where does each credential live? Claim token: handover pipe → heap until claim. Callback token:
  heap only. Clone token: heap → the clone's `GIT_CONFIG_VALUE_n` → dropped after revoke (GitHub)
  or before `clone-done` (Harness Code; the platform deletes it). Gateway
  key (since piece A1): heap → a pipe that becomes `kete`'s **fd 3**, with
  `KETE_JOB_GATEWAY_KEY_FD=3` in its env and no `KETE_GATEWAY_KEY` (`StartKete`,
  `internal/entry/entry_linux.go:219,281-310`: empty key refused, written ≤ 4096 bytes so it can't
  block, write end closed before launch so `kete` reads to EOF). `kete` reads it once, closes it,
  and is non-dumpable (`cli/src/kete/job-preflight.ts`; `job-mode` card). Signed URLs: heap, never
  logged (`README.md:187-196`).
- How does an extra fd reach the launched process? `launch.Options.Extra` files become fds 3.. in
  the target (`internal/launch/launch_linux.go:26,66,71`); stage 2 keeps fds 3..3+n-1 open and marks
  the rest close-on-exec (`stage2_linux.go:102`). The proxy uses fds 3-7; `kete` uses fd 3 for the
  gateway key.
- How does the bundle reader stay safe? Git runs only against the pristine git-dir with a fresh
  `GIT_INDEX_FILE` (never the agent's `.git`); every path is opened component by component with
  `O_NOFOLLOW`; symlinks → `symlink`, non-regular → `unreadable`; decimal limits (1,000,000 /
  256,000 binary / 50 binaries / 1,000 entries / 20,000,000 tar / 10,000,000 gzip); gzip tar with
  `manifest.json` first, a bare JSON array (D11); no changes → empty manifest still uploaded (D12)
  (`internal/bundle/bundle_linux.go:157`, `bundle.go:116,179,214`; `README.md:195-236`).
- Can I test it on a Mac? Yes, with Docker/Colima only (no Go needed): see Testing.
- Which ids does the helper get? `--tool-gid` is the `kete-job` gid, not the tool user's own: the
  helper runs tools with `setgroups([])`, so only the primary gid can enter the root:kete-job 2750
  worktree parent. `--env-allow` = terminal/pager names only, never `KETE_*`
  (`internal/layout/layout.go:173`; `entry_linux.go:265`).
- What routes does the fake platform serve (`internal/fakeplatform`)? Platform host:
  `POST /api/v1/jobs/<id>/<kind>` (callbacks, callback token; the claim accepts `features` and
  refuses a Harness claim without `clone_revoke_callback`; `clone-done` in `running`, `{}` or
  empty, `Knobs.CloneDoneFailures` 500s first, `fakeplatform.go:512`), and since PR 2 the GETs
  `/api/v1/sync` (job key as Bearer; a wrong key is 401, the callback token here is recorded as a
  leak), `/api/v1/sync/skills/{id}/files`, `/api/v1/models`, `/api/v1/me`
  (`fakeplatform.go:391-395`, `sync.go:86-115`). A gateway host (`gateway.go`) answers scripted
  model calls: it checks the key header (`x-api-key` for Anthropic) and `x-kete-agent-id` /
  `x-kete-agent-version`, else 403 (`kete_agent_not_found`, a contract error). It holds **one job
  per run** (`NewJob`, `fakeplatform.go:260`; no control port); knobs `Scenario`, `OmitAgent`,
  `UnknownAgent`, `SyncStatus`, `Provider` (`harness_code`: the claim names provider and
  username; `HarnessGitHost` `git.harness.kete.test` serves the repository at `HarnessRepoPath`
  behind basic auth with the claim's username, refuses it after clone-done, and records any
  `/api/` request as `harness-api` plus a contract error; `harnessGit`, `fakeplatform.go:720`).
  The shared vector is `testdata/jobs-v1/claim-harness-code.json` (+ `SHA256SUMS`;
  `TestHarnessVectorChecksum`). `Leaks()`/`ContractErrors()` feed the e2e asserter.
- How does the entrypoint get the audit log (piece A3)? `StartKete` (`internal/entry/entry_linux.go`)
  creates the root file `/var/log/kete-job/kete.audit.jsonl` (0600, `layout.Config.KeteAudit`,
  `layout.go`) and a pipe; the write end becomes `kete job run`'s fd 4 (`layout.KeteAuditFD`,
  `KETE_JOB_AUDIT_FD=4` in `KeteEnvList`) and our copy is closed once kete has it. `auditReader` (a
  goroutine) copies the read end into the file, and past `layout.MaxAuditUpload` (20,000,000) stops
  and closes the pipe so the next write fails. `OpenAudit()` (no session id; `AuditRel` and
  `job.SessionID` are gone) waits <= 10 s for the reader after `Reap` and returns `job.ErrAuditTooLarge`
  / `job.ErrAuditReaderStuck`; `job.go` `upload` maps them and an empty file to the notes "audit log
  not uploaded: too large | reader stuck | empty | missing or refused" (N5). kete can append only,
  never rewrite. `kete job run`'s result has no `audit_log` in job mode.
- Where does the result come from? kete's stdout, a root-created file `/var/log/kete-job/kete.stdout`
  (`layout.KeteStdout`), parsed by `ParseKeteResult` (D3, unchanged by A3).
- Can the e2e lifecycle leave a symlink in the worktree? No: the bundle refuses it (`push_error:
  symlink`), so the lifecycle's confinement steps (the tool user plants links into kete's home;
  `read`/`write` through them are refused) remove the links before the end (`job-image` card).
- Where's the container main and the real-`kete` e2e? `cmd/kete-job-fake-platform/main.go` (flags
  `-scenario lifecycle|ac5|no-agent`, `-state`, `-deadline`; writes `ca.pem`, `job.env`, state on
  finish/SIGTERM) and `internal/e2e/` (build tag `e2e`: `TestLifecycle`, `TestAC5`, `TestNoAgent`,
  `TestExportScan`), driven by `packages/kete-job-image/scripts/e2e.sh` (`job-image` card).
- What do piece A and the image still owe? PR 2 (piece D) is built: see the `job-image` card.
  **Piece A:** A1 is done (`docs/tasks/2026-10-01-job-socket-server/`: `kete`'s server on a unix
  socket, so F2's firewall problem is gone; the gateway key by descriptor; `PR_SET_DUMPABLE`).
  A2 (sync) and A3 are done (`docs/tasks/2026-10-01-job-file-confinement/`): `openat2` for `kete`'s
  own files and an entrypoint-owned audit sink (below); the result stays on kete's stdout.
- What only a real Fly machine can verify? `nf_tables` inet and IPv6 in Fly's guest kernel, the
  resolver (`fdaa::3`) and NAT64, `hidepid` remount, cgroup v2 delegation and who owns the root
  cgroup, `/.fly/api`'s path and mode, the machine-config vars arriving, exit stopping the machine,
  Fly init keeping the claim token, real GitHub token revoke and shallow `--branch` clone, Supabase
  signed-upload method (PUT assumed, D15), real callback behaviour (`README.md:359-371`). The Fly
  guard and isolation check have a staging runbook (`README.md:372-405`): phase lines `setup_fly`
  ok and `isolation` ok before `claim`; inspect `/.fly`, `/proc/net/unix`, `ss -xlp`, the 6PN
  addresses on a sleep-entrypoint machine; `curl --unix-socket /.fly/api` as the tool user must be
  denied; a planted world-connectable socket must stop the entrypoint at `isolation`
  `unix_socket`.
- Does the heartbeat flag a stray process in the kete cgroup (ADR 0019 rule 5), and where? Yes:
  `startHeartbeat` (`internal/job/job.go:295`) adds `kete_cgroup_extra` to every agent-phase event
  from `machine.KeteExtra` (`internal/entry/entry_linux.go:371`), which reads `cgroup.procs` of
  `m.cg.Kete` (`cgroup.Procs`, `internal/cgroup/cgroup.go:143`) and counts pids whose
  `/proc/<pid>/exe` isn't `KeteBin`; a pid that's gone (ENOENT, ESRCH) is skipped, any other readlink error
  **counts** (fail closed). If the cgroup itself can't be read, the event carries the fixed message
  `KeteCheckFailed` (`job.go:291`) instead of a count, so the check is never silently missing. The
  platform records a count above 0 as a `job_events` error (`docs/platform/jobs-v1.md`). Tests:
  `TestHeartbeatKeteCgroupCheck` (`job_test.go`, both cases) and the integration scenario
  `TestKeteCgroupStray` (fake kete prompt `stray` starts `/bin/sleep` in its own cgroup).
  Limits: a process that execs `/usr/local/bin/kete` counts as kete; clone and report phases send
  no count (nothing runs in the kete cgroup then).

## Purpose
The most privileged code in a cloud job: it holds every credential and runs as root, so it is
small, shells out only to `nft`, `git`, the helper, the proxy and `kete`, and is tested like the
helper. It turns a Fly machine with three (four) env vars into one job run end to end, failing
closed with a fixed, message-free phase log at each step (ADR 0019 rule 8).

## Entry points
- `cmd/kete-job-entrypoint/main.go:27`: `__launch` (stage 2 of a launch, before anything else),
  `__isolation_probe` (the isolation probe, already the tool user: `isolation.RunProbe`) →
  `__run <fd>` (after the env scrub; SIGTERM/SIGINT become an abort) → default boot (read env,
  `bootenv.Handover`). Non-root → exit 2.
- `internal/entry/entry_linux.go:40` `Main`: `setup_host` (`hostCheck`), users, sysctls, `/proc`,
  Fly guard (`flyGuard`, fly) or `hostBoundary` (others), dirs, cgroups, firewall, then `job.Run`
  with the real deps (`egressImpl`, `machine`).
- `cmd/kete-job-init/main.go`: `guestinit.Stage1` (no argument) / `Stage2` (`__guest`).
- `internal/job/job.go:135` `Run(ctx, Deps)`: the orchestrator, testable with fake deps
  (`internal/job/deps.go:22-108`).

## Key files
| File | Role |
| --- | --- |
| `internal/dhcp/*` | kete-job-init's DHCPv4 client (cloudvm): `dhcp.go` messages, `Parse`, `LeaseFrom`, `Plan` (pure); `packet.go` IPv4/UDP; `client_linux.go` packet-socket DORA (`Client.Configure`, `Install`); `netlink_linux.go` RTM_NEWADDR/RTM_NEWROUTE, `AckFor`. Needed because the kernel's `ip=dhcp` refuses off-link gateways (GCP /32 + option 121, Hetzner /32 + router 172.31.1.1: `ic_setup_routes` "Gateway not on directly connected network") |
| `internal/guestinit/cmdline.go` | `ParseCmdline`: `kete.net=dhcp` + `kete.dns=` 1-2 public IPv4 (strict; `contracts.md` §6g) |
| `internal/bootenv/bootenv.go` | Machine-config env names and validation (`Read`), `Config` (the config pipe's JSON, `ParseConfig`/`DecodeConfig`, strict), `FromEnv`/`FromConfig` (boot rules), JSON handover over a pipe to `__run`; `handover_linux.go` `ReadConfigFD` (FIFO only) |
| `internal/hostprofile/*` | Profiles, `Resolve`, `Check` and codes, the DMI provider table, boundary/isolation targets, `DefaultGateways`, `MetadataDropRuleset`; `signals_linux.go` `Gather`, `BlockDevices`, `FindConfigDisk`, `OpenConfigDisk` |
| `internal/guestinit/*`, `cmd/kete-job-init` | kete-job-init: `Run` over `Deps` (`guestinit.go`), `ParseConfigDisk` (`config.go`), `UserDataClient` and the provider endpoints (`userdata.go`), the real machine, stage 1/2, `Reap`, `Nameservers`, `ApplyMetadataDrop` (`init_linux.go`) |
| `internal/layout/layout.go` | Every fixed path, port (81/82/83), limit and timing (`Default`, `:67`); tests override timings in-process, the binary has no knob; `ToolEnvAllow` (`:173`) |
| `internal/sysusers/sysusers.go` | `/etc/passwd`/`/etc/group` parse → `kete`, `kete-tool`, `kete-proxy`, `kete-job` ids (`Resolve`, `:96`) |
| `internal/setup/setup*.go` | Sysctls written and read back, `/proc` remount, the Fly guard (`LockFly`, fail closed), `O_NOFOLLOW` dir creation, atomic/exclusive root files |
| `internal/isolation/*` | The isolation check: probe list (`Build`, `FlyProbes`), `Check` over a `Net` interface, `/proc/net/unix` parser, `Run` (launch as the tool user), `RunProbe`, control `Listen` |
| `internal/cgroup/cgroup.go` | `R/kete-job-init`, `R/kete-job/{system,kete,tool}`, limits (25%/512 and 60%/4096), `Kill`, `Populated` |
| `internal/launch/*` | Stage 1 `Start` (`launch_linux.go:40`) and stage 2 (`stage2_linux.go:21`): oom, umask, groups/ids, NNP, chdir, `close_range`, `execve`; failures on a status pipe |
| `internal/egress/*` | Config v1 builder (`config.go:101`), `ApplyFirewall` (`proxy_linux.go:24`), `Manager` keeps listeners and log across instances (`:56-122`), control client |
| `internal/helper/*` | Helper flags and start/stop/kill |
| `internal/platform/{platform,claim}.go` | Callback client (claim with `features`, events, result, uploads, finish, clone-done, PUT, GitHub revoke), claim no-retry-after-write, strict claim (incl. `clone.provider`/`clone.username`) and uploads validation |
| `internal/gitops/*` | Hardened git env built from scratch (`gitops.go:44-83`), clone (`BasicHeader(username, token)`)/verify/agent copy, `ChownWalk`, stderr scrub (token, basic-auth value, Authorization lines) |
| `internal/bundle/*` | The safe reader and tar writer |
| `internal/job/job.go` | Phases, heartbeats, backstop, deadline, outcome mapping, uploads |
| `internal/phaselog/phaselog.go` | Fixed steps/codes; `FailErr` adds only `class` + number (`:113`) |
| `internal/fakeplatform/*` | Test support (non-`_test`, reused by the image e2e): callbacks incl. clone-done, sync/models/me GETs (`sync.go`), scripted gateway (`gateway.go`), job state (`state.go`), own CA, DNS with forwarding (`dns.go`), git smart HTTP on a GHES-style host (+ revoke) and a Harness-style host, uploads; `testdata/jobs-v1/` the shared Harness claim vector |
| `cmd/kete-job-fake-platform`, `internal/e2e` | The fake as a container process, and the `e2e`-tagged asserter (call order, heartbeats, proxy log, audit log, export token scan) run by `kete-job-image/scripts/e2e.sh` |
| `internal/itest/*` (+ `itest/fakekete`) | `integration && linux` suite and the fake `kete` (asserts uid, NNP, oom 0, env, `KETE_JOB_GATEWAY_KEY_FD=3` with a printable key on fd 3 and **no** `KETE_GATEWAY_KEY`; `KETE_JOB_AUDIT_FD=4` is a pipe it writes audit lines to; spawns via the real helper); `TestAuditOverLimit` covers the 20 MB stop |
| `scripts/integration.sh` | Installs tools, builds helper/proxy/entrypoint/fakekete, creates users, runs in a fresh netns on `198.51.100.0/24`, restores `user.max_user_namespaces` |
| `.github/workflows/kete-job-entrypoint.yml` | Path-filtered CI (see Testing; also `go vet -tags e2e`) |

## Data flow
1. Boot: env (fly) or `--config-fd` pipe (others) → validate, resolve the profile → pipe → re-exec
   `__run` with only `PATH`; not dumpable, oom −1000, umask 022; `setup_host`.
2. Machine setup and the network guard (`README.md:79-94`); helper socket must appear (owner kete,
   0600) within 10 s.
3. `POST /api/v1/jobs/{id}/claim` through port R trusting only the proxy CA; retried ≤ 5 in 2 min
   only while no request byte was written; strict validation (`claim.go:98`).
4. Proxy instance 2; clone (`events {clone}`); verify; revoke (GitHub: revoke then `clone-done`
   best effort; Harness Code: `clone-done` only, also on clone/verify failure; D8: failure →
   events note); agent copy at `/srv/kete-job/work/repo` on `spec.branch`, owned tool:kete-job.
5. Agent: effective timeout; `spec.json` (policy.timeout replaced); `kete job run --json spec.json`
   as `kete` in cgroup `kete`, cwd = the working copy; heartbeats every 30 s from claim to done
   (first agent event carries `effective_timeout_minutes`; agent-phase ones `kete_cgroup_extra`, or
   the `KeteCheckFailed` message when the cgroup can't be read).
6. Report: stop agents; `result` (kete's stdout v1 object verbatim, else a synthesised `error`);
   bundle; `uploads`; proxy instance 3; PUT audit log (what the pipe delivered, `OpenAudit()`), bundle, proxy-log snapshot; `events {done}`;
   `finish`; close the proxy. Exit 0, or 1 if `result`/`finish` wasn't accepted.

## Data and APIs used
- Platform callbacks (kete-code-platform `docs/jobs.md` §2): claim (200), events (204), result
  (204), uploads (200), finish (202), clone-done (204), signed-URL PUT; 404 = gone
  (`internal/platform/platform.go:181-345`).
- GitHub (or GHES `/api/v3`) `DELETE /installation/token` (`platform.go:347-377`), GitHub jobs only.
- `kete-egress` config/fds/control v1 and `kete-root-helper` flags (their READMEs; `egress`,
  `root-helper` cards). `kete job run`'s job-mode contract (`contracts.md` §6d, `cli` card).
- `golang.org/x/sys` v0.48.0, `golang.org/x/net` v0.59.0 (fake DNS) — the same pins as the helper
  and egress modules.

## Rules that must not break
- Nothing is claimed unless the firewall, proxy and helper are all up and the isolation check
  passed; on Fly, nothing is claimed unless `/.fly/api` was found and locked; off Fly, nothing is
  claimed unless the profile's signals fit and the host-boundary probe reached nothing.
- Fly signals with any profile but `fly` never run; an unset profile is `fly` only with a Fly
  signal. Non-fly values come only from a pipe, never the environment, argv or a file.
- `fly`'s isolation probe list must stay exactly as it was (no `OffFly`, no `Extra`).
- No credential in any child's env (the gateway key goes to `kete` on fd 3, piece A1), and the clone
  token only in the clone's git env; never in argv, URLs, files or logs. Phase lines never carry
  free text (`phaselog`).
- A Harness Code job never sends a request to its git host's API and its clone phase reaches only
  the platform and the clone host; its token is released only through `clone-done`.
- The proxy is restarted only while no job-user process exists (D2).
- Every root git call uses the constructed env (no system/global config, hooks/fsmonitor off) and
  never runs against the agent's `.git`.
- Order at the deadline or abort: helper SIGKILL, then `cgroup.kill`, then close the proxy.
- `--env-allow` never names a `KETE_*`, proxy or CA variable.
- Machine config, layout, callbacks, bundle format are contracts: change the README and
  `contracts.md` §6d together.

## Testing
- Unit (no root, Docker/Colima): `docker run --rm -v "$PWD/packages:/src" -w
  /src/kete-job-entrypoint golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... &&
  go vet -tags integration ./... && go test -race ./...'` — 14 packages with tests. Note the mount is
  `packages/`, not the module (the integration suite builds the sibling modules).
- Integration (privileged, cgroup v2): `docker run --rm --privileged --cgroupns=private -v
  "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash
  scripts/integration.sh` (append `-test.run <Name>`). The tests, ~30 s:
  TestLifecycle, TestAuditOverLimit, TestRefuseClaimWithout{Firewall,Proxy,Helper}, TestCloneWrongCommit,
  TestHarnessCodeLifecycle, TestHarnessCodeWrongCommit,
  TestProcessesAlive, TestKeteCgroupStray, TestProxyFailed, TestHardDeadline, TestCancelled, TestDeadlineTooShort,
  TestBundleRefusals/{symlink,fifo,oversize}, TestCredentials, TestBinaryBoot, and
  (`itest/isolation_test.go`) TestIsolationProbeDetects, TestFlyGuardMissingAPISocket,
  TestFlyGuardLocks, TestIsolationStraySocket/{path,abstract}, TestIsolationReadableKeteDir,
  TestIsolationFirewallRefuses, TestBinaryBootOnFly, and (`itest/profiles_test.go`, self-hosted P1)
  TestProfileMismatch, TestHostBoundaryMicrovm, TestCloudvmMetadataDrop, TestBinaryBootDedicated,
  TestBinaryBootDedicatedStdin, TestBinaryBootRefusals — 30 top-level tests. `defaultProfile` (main_test.go) gives in-process
  runs with no profile `fly` (a Fly signal) or `dedicated`; `guestTree` (profiles_test.go) fakes PID
  1, virtio, DMI, block devices and the route file through `layout.Config` paths; `localAddr` puts
  a listener on a sample address on `lo` (IPv6 with `nodad`). TestBinaryBoot now has a world-open
  `/.fly/api` (the env path is Fly's). `bootHook` edits the boot values `runJob`
  passes (e.g. `OnFly`).
- CI: `.github/workflows/kete-job-entrypoint.yml` — PR/push to `main` path-filtered to the
  entrypoint, helper and egress modules and itself, plus dispatch; `ubuntu-latest`, 15 min:
  gofmt, vet (+integration tag), `go test -race`, then the integration suite in a privileged
  `golang:1.26-bookworm` container with `--cgroupns=private`. Runs on PRs touching the module
  (passed on PR #9, 2026-10-05, with the Harness scenarios); manual:
  `gh workflow run kete-job-entrypoint.yml --repo kete-org/ketecode --ref <branch>`.
- Harness Code (2026-10-05): units `TestValidateClaimProvider`, `TestHarnessCodeVector`,
  `TestCloneDone` (platform), `TestBasicHeader`, `TestCloneUsername`, `TestScrubBasicValue`
  (gitops), `TestHarness{Lifecycle,CloneFailed,WrongCommit,CloneDoneFails,CloneDoneGone}`,
  `TestGitHubCloneDoneBestEffort` (job), `TestHarnessVector{Checksum,Shape}`,
  `TestHarnessClaimAndCloneDone`, `TestGitHubClaimUnchanged` (fakeplatform); integration
  `TestHarnessCodeLifecycle`, `TestHarnessCodeWrongCommit`.
- Orchestrator units with fake deps: `internal/job/job_test.go` (outcome table, timeout math,
  processes_alive with and without a live proxy, storage-host clash, signal abort order, backstop).

## Changes
- `docs/tasks/2026-10-05-harness-code-entrypoint/` (platform ADR 0024, #68's runtime handover):
  claim `features`, `clone.provider`/`clone.username`, basic auth with the claim's username,
  `clone-done` (GitHub best effort; Harness Code the only revoke, also on clone/verify failure),
  the narrowed Harness clone allowlist, step `clone_done`, the fake's Harness host and vector.
- `docs/tasks/2026-10-03-job-host-cloudvm-images/` (self-hosted P7): `internal/dhcp`,
  `guestinit/cmdline.go`, `Machine.Network` choosing DHCP or the kernel's `ip=` (microvm unchanged);
  README "kete-job-init" steps 1, 3, 6 and "Not verified without a real host".
- `docs/tasks/2026-10-03-job-host-firecracker/` (self-hosted P4): control probes retried up to 3
  times in `isolation.Check` (the loopback control timed out at 300 ms in Firecracker guests on a
  nested-KVM host and failed `host_boundary` with `control`); the fake platform's claim tokens are
  64 hex (the job-host-v1 shape).
- `docs/tasks/2026-10-03-job-host-profiles/` (self-hosted job hosts P1, kete-code-platform ADR 0023
  rules 13-17): host profiles and `setup_host`, the config pipe (`--config-fd`), the root
  host-boundary probe (`host_boundary`), per-profile isolation inputs (`OffFly`, `Extra`, kind
  `file`), `kete-job-init`; new phaselog steps/codes; layout signal paths. Fly's behaviour and
  probe list unchanged.
- `docs/tasks/2026-10-03-job-fly-lock/` — security review major finding: the Fly guard fails
  closed (`OnFly`, `missing`), locks `/.fly/api` too, and is verified as the tool user; the new
  isolation check (`internal/isolation`, phase step `isolation`) runs before claim; staging runbook.
- `docs/tasks/2026-10-02-job-gateway-allowlist/` — the heartbeat's kete-cgroup check fails closed (unreadable exe counts; unreadable cgroup → `KeteCheckFailed` message), with a unit test and `TestKeteCgroupStray`; the platform's item 11 audit is in that task's result.md.
- `docs/tasks/2026-10-01-job-socket-server/` (piece A1): the gateway key moved from
  `KETE_GATEWAY_KEY` to fd 3; fakekete and TestCredentials follow; TestProxyFailed retries until it
  has killed a proxy.
- `docs/tasks/2026-09-30-job-entrypoint/`: spec, plan (F1-F6, D1-D15, step table), handoff (user
  decisions D1-D4, the implementer's deviations, security-review fixes 1-8).
- **Three Go pins to bump together:** this module's, `kete-egress`'s and `kete-root-helper`'s
  `go.mod` (`go 1.26.0`, `toolchain go1.26.8`, `x/sys v0.48.0`; `x/net v0.59.0` here and in egress).
- A new machine-config variable: `bootenv` (validate + handover), the README table, `contracts.md`
  §6d, and the platform's Fly adapter.
- A new phase step or code: `phaselog` constants only (fixed values; no free text). A new isolation
  reason also goes into `isolation.Priority` (Validate and ParseAnswer accept only listed ones).
- A new host profile signal: `hostprofile.Signals` + `Gather` (path in `layout.Config`, so tests
  can point it at a tree) + `Check` + a `TestCheckMatrix` row + a `TestProfileMismatch` case.

## Gotchas
- `--config-fd` must be a FIFO: `docker run -i` stdin is one (e2e uses `--config-fd 0`), a file is
  refused. `docker create -i` + `start -i` would leave stdin open (no EOF): use `run -i`.
  `ReadConfigFD` parks `/dev/null` on a closed stdio fd and `Handover` moves its pipe to fd ≥ 3
  (with fd 0 closed, `os.Pipe` reused it and `__run 0` was refused: `TestBinaryBootDedicatedStdin`).
- The host-boundary probe dials as root before the firewall: in Docker it needs the Docker host to
  drop the job's packets to itself and private ranges (e2e.sh `host_table`), else `gateway`.
- `FindConfigDisk` opens every non-empty block device read-only (`O_NONBLOCK`) to read the header;
  in the privileged test container that includes the Docker VM's disks (harmless, read-only).
- The integration netns has an on-link default route via `198.51.100.1` (nothing answers):
  off-Fly profiles require a default gateway; `guestTree` writes the same gateway into its route
  file, and "no default gateway" is a `TestHostBoundaryMicrovm` case.
- The cgroup named `kete-job-init` (where pre-existing processes move) is unrelated to the
  `kete-job-init` binary.
- The entrypoint sets `KETE_DISABLE_MODELS_FETCH=1` for `kete` (N1; `entry_linux.go:198-225`), so a
  job's model catalog is the binary's bundled snapshot (see `job-mode`). It sends
  `events(agent, effective_timeout_minutes)` right after starting `kete` (`job.go:525-531`), so
  `sync` races it: assert order `revoke < sync < skill_files < first messages`, not sync then events.
- **Docker image is bookworm, not trixie** (disk): git 2.39. The plan named trixie; README, CI and
  these commands use bookworm.
- `GIT_INDEX_FILE` is set only for the bundle listing; the agent copy (`checkout -b`) needs its own
  index or the working copy would have none.
- `ls-tree` uses `-l`: a same-size tracked file is hashed in full as a stream (deadline-checked per
  read) to decide "unchanged", so large unchanged files never load into memory or hit the limits.
- An untracked FIFO/socket is invisible to `git ls-files`, so it's never bundled; a FIFO at a
  tracked path is refused `unreadable`.
- If the proxy died or the claim was invalid, the report phase starts a report-only instance
  (root → platform) before `result` (`job.go:591-604`).
- Audit upload cap is 20,000,000 bytes (the platform's <= 20 MB), and kete's job-mode sink caps at the same number (bytes); only the file-mode writer uses 20 MiB.
- TestCredentials' disk search skips `/` itself (bind-mounted sources and Go caches); it covers
  `/run /var /srv /tmp /etc /root /home`, every cmdline and non-root environ every 10 ms, the gateway
  key (and any `KETE_GATEWAY_KEY=`) in **no** environ, `kete`'s included, `/var/log/kete-job/*.stderr`,
  and stdout. An EACCES/EPERM reading a live non-root process's environ is recorded as a leak, not
  skipped — a non-dumpable process's environ is root-owned, and a scan that can't read it would pass
  without looking.
- TestProxyFailed's killer goroutine keeps scanning until it has actually killed a proxy (a scan
  between instances found none and the job then ran to its time limit); it fails if it never did.
- The in-process integration tests call `entry.Main` with test timings; the test binary is its own
  launch stage 2 (`__launch` in `init`) and its own isolation probe (`__isolation_probe`). Only
  TestBinaryBoot and TestBinaryBootOnFly run the real binary.
- The tool cgroup holds no process directly (the helper refuses one that does, and the kernel's
  no-internal-process rule makes `CLONE_INTO_CGROUP` fail with EBUSY), so the probe runs in its
  own leaf `<tool>/isolation`, killed and removed after (`removeCgroup`).
- Any world-connectable listening unix socket in the job's network namespace stops every job at
  `isolation` `unix_socket`, by design (that's the finding: an API socket somewhere unexpected).
  If Fly adds one, jobs stop until it's understood (staging runbook step 3).
- The isolation controls include a world-connectable abstract unix listener, so
  `CheckIsolation` reads `/proc/net/unix` **before** `isolation.Listen`, and the Fly guard closes
  its controls before returning; a control still open during a later sweep is (rightly) reported
  `unix_socket` (TestFlyGuardLocks closes its own before running the job).
