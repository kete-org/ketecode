# Handoff: Self-hosted job hosts P5: dedicated driver and reset verification (agent side)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-03 build agent

### Done
Agent side of P5 in `packages/kete-job-host`: the `dedicated` driver (`internal/driver/dedicated`),
one job per generation in the agent, R1 boot enrollment (`enroll --token-file`,
`packaging/kete-job-host-enroll.service`, `install.sh --driver dedicated`), R2's interface
(`internal/reset`, refused), config `dedicated` section, CLI wiring and doctor checks. Real tests on
Colima `kvmtest`: a whole job (to `finish ok`) under the dedicated driver against the entrypoint's
fake platform, the one-job-per-generation refusal, probe isolation, restart re-adoption, deadline
killer, table loss. See result.md. Nothing committed or pushed.

### Decisions
- **D1 Reaper = the agent's own binary** (`kete-job-host __dedicated-init`, dispatched before any
  flag parsing), not a `kete-job-init` reaper mode: no image change, no new trust in the image for
  host-side setup, and the reaper is the code that knows the init spec. It is PID 1 of new
  mount/PID/net/IPC/UTS namespaces, cloned with `CLONE_INTO_CGROUP` into
  `kete-job-host-jobs/<machine>`; it unshares the cgroup namespace itself on a locked OS thread
  (rather than relying on how clone3 orders copying namespaces and moving into the target cgroup
  when `CLONE_NEWCGROUP` and `CLONE_INTO_CGROUP` are combined; not tested) and forks the
  entrypoint from that thread.
- **D2 Generation spent at `starting`, in the agent's state** (`state.json`
  `generation_spent_by`, optional field in schema v1): the last moment before anything of the job
  runs on the host. Refused assignments (signature, sealed-config checks, generation mismatch,
  image unavailable) don't spend it (`TestDedicatedGenerationMismatch` keeps passing: m1 refused,
  m2 runs); a failed save fails the start; the spender's own redelivery after a restart isn't
  blocked. Stricter than this would be spending at assignment; the platform does that on its side
  (rule 8 "when that job's machine is assigned"), so the two together are fail-closed.
- **D3 New `starts_blocked` value `generation_spent`** (with `free: 0`), added to
  `internal/contract` like P4's `host_isolation_lost`. Not a posture change: it reports a refusal
  ADR 0023 already requires. The platform must accept it (below).
- **D4 Job root = the store's verified ext4 (shared cache with firecracker), loop-mounted
  read-only + overlay on a sparse ext4 scratch file** (bounded by `scratch_gib`), tmpfs `/dev` with
  six fixed nodes (no host device), `/proc` rw and full capabilities (parity with the privileged
  container the entrypoint's dedicated e2e already uses; rule 8 says no boundary). The reaper sets
  `oom_score_adj -1000` after forking the entrypoint so an OOM job can't take PID 1 down first.
- **D5 Network = the firecracker host table unchanged**: veth host side named `kjh0` (matches
  `kjh*`), job side `eth0` created directly in the reaper's netns; the reaper configures it with the
  host's `ip` before pivoting. The entrypoint's `host_boundary` and the probe test confirm the
  gateway, private ranges, metadata and IPv6 are unreachable.
- **D6 `enroll --token-file`**: root `0600` file via `fsutil.ReadPrivate`; removed once the platform
  answered (201 or any API error: the token is spent by any signed attempt) or when malformed;
  kept after a transport error so the oneshot unit's `Restart=on-failure` retries. `enroll` refuses
  a state whose generation is spent, even with `--replace`.
- **D7 R2**: `reset.Attestor` (TPM-resident public keys, `Quote` over a nonce) + `Detect` refusing
  (`ErrNoTPM` without `/dev/tpmrm0`, else `ErrNotImplemented`); `config.Parse` keeps refusing
  `measured_boot`. No TPM here, and R2 needs contract changes first (below).
- No shared-helper extraction from the firecracker driver (procStart, killCgroup, console reading
  are re-implemented in `dedicated`, ~80 lines): keeps P4's KVM-verified driver untouched. A later
  cleanup can move them to a common package.

### Platform requirements (for a later kete-code-platform task; P5 plat)
1. **Contract:** add `generation_spent` to `JobHostStartsBlocked` (and `docs/contracts/job-host-v1.md`)
   before any dedicated host polls — today the platform would refuse those reports
   (`malformed_request`) and the host would go stale. Then re-copy the contract and vectors here.
   (Still pending from P4: `host_isolation_lost` in `JobHostMachineReason`.)
2. **Generation tracking:** per dedicated host, `assignable` only when its current generation has
   a *verified* reset and no machine was ever assigned in it. The `selfhosted` adapter's `start`
   places at most one machine per generation (under the placement lock), marks the generation
   spent at assignment (not at start), and never assigns to a host whose last report says
   `starts_blocked: generation_spent` or `free: 0`.
3. **Identity end:** when the generation's machine is terminal (reported `destroyed`/`failed`, or
   withdrawn before delivery), revoke the host (`revoked`: keys refused forever, undelivered sealed
   configs deleted) and start the reset. The agent halts on `host_revoked` (exit 3); the unit
   doesn't restart.
4. **R1 orchestrator** (`provider_rebuild`):
   - Provider client for the first provider chosen (U4: DigitalOcean Droplet rebuild, Hetzner Cloud
     server rebuild, GCP/OCI re-create), credential in portal server configuration only, never on
     the host; timeouts, bounded retries, audit log entries.
   - Before the call: mint a fresh single-use enrollment token (`kete_jhe_…`, SHA-256 stored, short
     validity) bound to `{host record, provider server id, rebuild id, new generation}`; choose the
     new generation (`JobHostGeneration` pattern, unique, e.g. `g-<date>-r<n>`).
   - Call rebuild/re-create from the **pinned host image** (built with
     `packaging/install.sh --driver dedicated`; its id pinned in platform config) with user data
     (cloud-init `write_files`, root, mode `0600` for the token) writing
     `/etc/kete-job-host/config.json` — `platform_url`, `driver: dedicated`, `slots: 1`,
     `reset: provider_rebuild`, `generation: <new>`, `resolvers`, `image_allowlist`, optional
     `dedicated` section — and `/etc/kete-job-host/enroll.token` (token + newline). The image's
     `kete-job-host-enroll.service` enrolls on first boot; `kete-job-host.service` then polls.
   - Confirm through the provider API that the rebuild finished **from that image** (action status
     + image id), before accepting the enrollment.
   - **Auto-approval rule:** answer the enrollment `201 {status: "active"}` only when the token is
     the one minted for a rebuild the platform started, that rebuild is confirmed finished from the
     pinned image, the request declares `driver: dedicated`, `reset: provider_rebuild`, `slots: 1`
     and exactly the minted generation, and the signing key is new (`key_in_use` otherwise). Any
     other dedicated enrollment (admin token, mismatched generation, unconfirmed rebuild) stays
     `pending` and **unassignable** even if an admin approves it, until a platform-started R1
     reset verifies it — so initial provisioning is itself an R1 rebuild. The fake platform's
     `AddRebuildToken` models the token/generation part of this rule.
   - Failure handling: a rebuild that fails or isn't confirmed leaves the host unassignable (no
     retry loop that could reuse a token); tokens expire; the old identity stays revoked.
5. **R2 (if U4 wants it):** quote verification needs, first, a contract change: an ECDSA P-256 (TPM)
   signing key variant and a TPM-servable sealing scheme (or a TPM-sealed X25519 file key), a
   route or poll field that carries the platform nonce and returns the quote + event log, and an
   allowlist of measurements per signed host image. Then: verify the quote signature chain (EK/AK),
   the nonce (fresh, single-use), PCR values against the allowlist, before marking the generation
   verified; refuse stale nonces, wrong measurements, wrong keys (CI with `swtpm`). The agent side
   implements `reset.Attestor` after that.
6. **Admin UI/ops:** show a dedicated host's generation, spent/verified state, last reset
   (provider action id), and an admin "reset now" action (audited, MFA) that runs the R1 flow.

### Open issues / for later
- Real R1 on a provider (plan-overview P5 "Real"): two jobs in sequence on one rebuildable server
  needs a provider account (U4) and the platform orchestrator above.
- R2 as described in the README "Dedicated hosts".
- `TestHangingDriver` (P2, wall-clock assertions of 100–150 ms) failed once in one of ~7 full-suite
  `-race` runs while the new driver tests loaded the container; 25 isolated runs and 6 more full
  runs passed. Pre-existing timing sensitivity, not touched by this change; consider widening its
  margins if CI shows it.
- The firecracker KVM tests weren't re-run (no Firecracker/kernel artifacts staged; the firecracker
  driver's code is unchanged, its unit tests pass).
- CI `kete-job-host.yml` hasn't run on GitHub yet; the dedicated driver tests should run there under
  `sudo` (loop devices, cgroup v2, `iproute2` added to the apt step) — first run will tell.

## 2026-10-03 build agent — reviewer fixes (supersede D2's redelivery note and D6's removal rule)

1. **MAJOR, replayed spender could start twice — fixed.** The exception that let the spending
   machine's id through `starts_blocked` is gone: once `generation_spent_by` is set nothing starts,
   the spender's id included (a pruned tombstone replayed by the platform would otherwise have
   started again). A machine still `preparing` at a restart never spent the generation, so its
   redelivery is unaffected. Test `TestDedicatedReplayedSpender`; `TestDedicatedSpentOnlyByAStart`
   now expects a persisted spend to block the spender's id too.
2. **MAJOR, token file removed on transient errors — fixed.** Removed only on 201,
   `enrollment_token_invalid`, `key_in_use`, or a malformed token; 429/5xx/clock skew/other keep
   it. Test `TestTokenFile/transient 5xx`.
3. Enroll unit: `StartLimitIntervalSec=30min`, `StartLimitBurst=20` (pre-request failures don't
   loop forever).
4. Reaper: no `exit` record when the entrypoint's wait status was never seen (`Status` → crashed).
5. `Stop` removes a leftover veth whenever the machine had any residue (directory or cgroup).
6. `dedicated.New` refuses a `state_dir` containing `,` or `:` (overlay option injection).
7. `launch` kills the reaper if it isn't in its cgroup.
Re-ran: gofmt, vet (all tags/OS), `go test -race ./...` (Docker privileged) — pass. The kvmtest
runs predate these small fixes and were not repeated (the driver's real-launch unit tests cover
Stop/residue and pass).
