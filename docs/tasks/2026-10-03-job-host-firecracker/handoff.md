# Handoff: Self-hosted job hosts P4: Firecracker driver, guest kernel, host nftables, image verification

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-03 build agent (spec, plan, build in one session; coordinator-delegated, user approved design + build all)

Done: spec (approved status per the user's "design + build all"), plan, build, cards, docs, KVM
acceptance on Colima `kvmtest` (see result.md). Nothing committed or pushed.

### Decisions (none changes the security posture beyond ADR 0023; each is stricter or neutral)

- **F1 dependencies.** go-containerregistry v0.22.1 (registry client) and sigstore-go v1.3.0
  (Sigstore verifier), both Apache-2.0, maintained by Google / the Sigstore project, pure Go,
  cross-platform. They are not small: ≈70 indirect modules (grpc, otel, go-openapi via Rekor's
  client, go-tuf, in-toto, protobuf specs) and a ~19 MB stripped binary. Justification against
  CLAUDE.md's bar: keyless verification needs Fulcio chain, SCT, Rekor inclusion/SET and TSA checks
  plus TUF for the trusted root — re-implementing them would be inventing cryptography (CLAUDE.md
  §9); the agent ships only to Kete-operated job hosts (never in the CLI, image or extension). The
  P2 handoff (E2) deferred exactly this dependency to P4.
- **F2 cosign format: v3 Sigstore bundles only.** Kete's release signs with cosign v3.0.6, whose
  default is the new bundle format stored as an OCI 1.1 referrer (on GHCR, under the
  `sha256-<hex>` fallback tag). The verifier reads only those (artifact type
  `application/vnd.dev.sigstore.bundle.v0.3+json`), requires a DSSE in-toto statement with
  predicate `https://sigstore.dev/cosign/sign/v1` whose only subject is the image index digest,
  and the identity: SAN regex
  `^https://github\.com/kete-org/ketecode/\.github/workflows/kete-release\.yml@refs/tags/kete-v<semver>$`,
  issuer `https://token.actions.githubusercontent.com`, source-repository extension
  `https://github.com/kete-org/ketecode`; SCT + tlog + one observer timestamp. Legacy `.sig`
  signatures are refused (fail closed). Trusted root: Sigstore TUF (embedded root), cache in
  `<state>/sigstore-tuf`, `CacheValidity` 1 day (no offline use of expired metadata).
- **F3 test signer.** Kete's release has never been signed (no `kete-v*` tag since P1), so
  `TestVerifyBundle`/`TestVerifyFromRegistry` run the production code with a real public cosign v3
  bundle (github/github-mcp-server v1.14.0's index, checked in under `testdata/sigstore/` with
  the trusted root fetched 2026-10-03) and that signer's identity, and assert Kete's identity
  refuses it. The KVM tests use locally built images and an accept-all verifier (test file only).
  **Open:** verify the real signature of the first `kete-v*` release's index with `image.Sigstore`
  (one manual run of `kete-job-host`'s verifier, or a test with that bundle).
- **F4 check order.** `checkCheap` under the lock (deadline → starts blocked → slot → allowlist),
  then in the worker: signature (`image_unavailable` when the registry/TUF can't be reached,
  else `image_signature_invalid`) → sealed config checks (unchanged order) → `Prepare`
  (`image_unavailable`) → deadline/starts-blocked again → `Start` (`driver_failed`). The plaintext
  config is held in memory during `Prepare` (≤ 30 min) so a bad configuration never costs a fetch.
  `PollOnce` waits only for fast work (`waitFast`), so reports keep flowing during fetches.
- **F5 image integrity.** go-containerregistry checks a blob's digest only at EOF, and a tar reader
  stops at the end marker, so `image.Store` downloads every blob whole into a root-only temp dir
  and hashes it itself, then checks each layer's uncompressed content against the config's
  `diff_id`. Unpacking goes through `os.Root` (Go 1.24+): `..` names refused outright, absolute or
  escaping symlinks/hard links refused, device nodes and FIFOs skipped (kete-job-init mounts
  devtmpfs), xattrs not carried, OCI whiteouts and opaque dirs applied bottom-up. The ext4 image is
  built by `mkfs.ext4 -d` (no journal, label `kete-root`), cached per **platform manifest** digest,
  `0444`, pruned to the allowlist at start. Supported layer types: gzip and uncompressed (zstd
  refused).
- **F6 host table** `inet kete-job-host`: exactly ADR 0023 rule 7's ranges (documentation ranges
  such as 198.51.100.0/24 are not blocked — the KVM tests rely on that for their "internet"), plus
  two stricter rules: anti-spoofing (`fib saddr . iif oif missing drop`, source inside the pool) and
  "out of the uplink only". The check compares canonical `nft -j` listings (handles/metainfo
  stripped) with the one taken after applying. A missing/changed table blocks starts and is
  re-applied only by an agent restart (no silent self-repair).
- **F7 jail.** Jail under `<state>/jail` (same file system as the image cache and kernels, so hard
  links work; copy on EXDEV), root dir `0711` (traverse only), VM config `0400` jail uid, config
  disk `0600` jail uid, unlinked once Firecracker holds it (matched by device+inode in
  `/proc/<pid>/fd` — the jailed process's links show chroot-relative paths). `--new-pid-ns`
  (Firecracker's recommendation): the VMM is nobody's child, so exit codes are lost; `exited` vs
  `crashed` comes from Firecracker's own log line "Firecracker exiting successfully". VMM identity
  = pid + `/proc` start time + cgroup path. Default seccomp; `no-file=1024`, `fsize` = scratch size;
  `pids.max=256`; `memory.max` = job + `vmm_overhead_mib` (256). uid/gid = `uid_base`(900000000)+slot.
- **F8 kernel: 6.18 LTS, not 6.1.** Firecracker's kernel policy ends 6.1 guest support on
  2026-09-02 and supports 6.18 from v1.16.1; pinned 6.18.55 (kernel.org sha256) with Firecracker
  v1.17.0's validated configs + `kete.fragment`. `CONFIG_IPV6=y` is required by
  `NF_TABLES_INET`; the guest still gets no IPv6 address or route and the host drops all IPv6.
  Builds use `debian:trixie-slim@sha256:a99c…` with apt from `snapshot.debian.org/…/20261001T000000Z`
  and fixed `KBUILD_*`; two independent arm64 builds on kvmtest gave the same SHA-256
  (`sha256:b88c1cf4508be6608dae3e220ffb2a6d844f05334e1d4717389af80be59f3735`).
- **F9 KillMode=mixed.** VMMs are outside the unit's cgroup and PID tree; `mixed` kills only
  helpers (mkfs, nft) left in the unit's cgroup. Verified by `TestLifecycle` (agent stop → VM alive
  → new agent re-adopts the same pid).
- **F10 entrypoint fake.** `packages/kete-job-entrypoint/internal/fakeplatform` now issues 64-hex
  claim tokens (was `claim-<40 hex>`), the shape job-host-v1's `JobMachineConfig` requires, so the
  agent accepts the fake's job. No other code depends on the old shape (image e2e asserts by value).

### Open issues / for later phases

- **Running VMs when the table vanishes:** ADR 0023 says a missing/changed table stops *starts*.
  Running guests then lose host-side confinement until the agent restarts. Destroying running VMs
  (or re-applying) would be stricter; left as ADR says — the platform/ops should decide.
- **Docker on a host** drops forwarded guest traffic (FORWARD policy DROP); install.sh warns, the
  KVM runner adds `DOCKER-USER` accepts. Hosts should not run Docker.
- **First release:** `kernel` + `kernel-publish` and the cosign v3 bundle path run for the first
  time on the next `kete-v*` tag; snapshot.debian.org can be slow (the job has 90 min).
- **amd64 KVM** not exercised (kvmtest is aarch64); the amd64 kernel config is checked
  (`check-config.sh`) but the amd64 build and boot were not run here (P4 staging host, U2).
- **Platform P3**: the real routes, then a staging job with `KETE_JOB_HOST=selfhosted`.
- The `TestRealJob` job reached `agent start` (kete job run) within the 6-minute window but was
  withdrawn before it finished; the claim and everything before it passed.
- Phase lines stay memory-only in the agent; the driver persists only its console offset.

## 2026-10-03 build agent — review fixes (reviewer subagent) and a KVM finding

Reviewer findings and what was done (file:line refs are to the reviewed diff):

1. **MAJOR, Stop relied on `cgroup.kill`** (Linux 5.14+). `killCgroup` now falls back to SIGKILL
   of every pid in `cgroup.procs` each round until the group is empty.
2. **MAJOR, the config disk (claim token) was written and fsynced on the state disk.** It now
   lives on a 64 KiB tmpfs mounted at the jail's `cfg/` (`mountConfigFS`, jail uid, `0700`,
   `nosuid,nodev,noexec`), never fsynced; once Firecracker holds it, the file is unlinked and the
   tmpfs detached (`unmountConfigFS`, also in `Stop`). Verified on kvmtest: the jailer's
   recursive bind makes it visible in the jail, guests read it (`init_config ok`), and the host has
   neither the file nor the mount afterwards (`TestGuestIsolation`).
3. **MAJOR, directories lost their owner** in the rootfs: `Lchown` for directories too
   (`TestRootfsConversion` checks `/home/job` 1001 `0750`).
4. **MAJOR, a stopped `preparing` machine waited for Verify/Prepare (up to 30 min).** Each
   machine's slow work runs under its own cancel func, called by `dropPending` and the deadline
   killer; `TestStopWhileVerifying` now expects `destroyed` without releasing the hung verifier.
   Agent shutdown during that work leaves the record `preparing` (no false `failed`).
5. Minor, fixed: malformed whiteouts (`.wh..`, `.wh..wh..x`) refused; opaque whiteouts now keep
   this layer's entries (including implicit parents) and recursively remove the lower layers'
   entries beneath them; unknown tar entry types fail (only char/block/FIFO are skipped); `Start`
   fails if the VMM's start time can't be read; `firecracker.log` read and jail files written with
   `O_NOFOLLOW`; slot allocation has its own mutex so `StartsBlocked` (called under the agent lock)
   never waits on file I/O; `Rootfs` remembers built paths so `Start` needs no registry.
6. Kept as is: `Prepare` digest mismatches report `image_unavailable` (the contract's meaning:
   "couldn't be fetched or a layer failed verification"); the console file is bounded by `Logs`
   (every 2 s) and the 8 MiB truncation, not by its own rlimit (`fsize` must allow the scratch
   disk) — noted as a residual; the TUF comment now matches the code (in-memory 1 h, cache 1 day).

**KVM finding — entrypoint control probe (P1 code).** After the first passing `TestRealJob`, every
run failed `host_boundary` with `control`: a debug build showed the loopback control dial timing
out at 300 ms (`dial tcp 127.0.0.1:…: i/o timeout`) while 64 workers dialled blocked targets, in a
4-vCPU Firecracker guest on Colima's nested KVM (a probe in the same guest measured 50–90 ms right
after boot, 18–26 ms later). Fix in `packages/kete-job-entrypoint/internal/isolation/isolation.go`:
control probes get up to `ControlAttempts` = 3 attempts; no other probe is retried (any forbidden
target reached still fails at once), so the check is no weaker. Test `TestCheckControlRetried`;
entrypoint unit tests and the integration suite pass. With this checkout's entrypoint injected
(`KVM_ENTRYPOINT`, `scripts/kvm-test.sh` picks up `kete-job-entrypoint` from its directory),
`TestRealJob` passed twice in a row. **The released job image needs this entrypoint** (next
release) before firecracker hosts on slow (nested) hardware pass `host_boundary` reliably.

## 2026-10-03 build agent — coordinator decision: fail closed when host isolation is lost

Decision (coordinator, resolving the open issue "running VMs when the table vanishes"; stricter
than ADR 0023 rule 7, which only stops starts — ADR note for the platform: rule 7 should read
"a missing or changed table destroys every running VM and stops all starts until the agent
restarts"):

- `driver.IsolationGuard` (`CheckIsolation(ctx) error`); the firecracker driver implements it by
  comparing the live `inet kete-job-host` listing with the one taken at `Init`
  (`Driver.CheckIsolation`; also called first by `Start`). Failure marks the table lost (sticky
  `tableLost`, starts blocked `host_table`) and returns an error wrapping `ErrIsolationLost`.
  The driver's own 30 s loop now covers only forwarding and disk space.
- The agent runs the check on its own loop in `Run` every `IsolationEvery` (default 5 s, 15 s
  timeout per check), separate from the supervise loop so a hung check never delays the deadline
  killer; it needs nothing from the platform. On failure (`Agent.CheckIsolation`): every live
  machine not already stopping gets an agent phase line `{"step":"host_isolation","event":"failed",
  "code":"host_table"}` and is stopped with reason **`host_isolation_lost`** (its in-flight
  verify/prepare cancelled); starts stay blocked (`isoLost`, `host_table`) until the agent restarts,
  even if the table reappears; `Init` re-applies the table on restart as before.
- **Contract:** `host_isolation_lost` is new. Added to kete-code's `internal/contract` destroyed
  reasons (and `contracts.md` §6f "pending addition"); `docs/platform/job-host-v1.md` and the
  vectors are untouched (copies of the platform's). **The platform (P2.0/P3) must add it to
  `JobHostMachineReason`** — until then a real platform would refuse a report carrying it.
- Tests: driver `TestCheckIsolation` (fake `TableManager`: never applied, missing, changed, sticky
  block after the table returns, `Start` refused); agent `TestIsolationLostDestroysAll` (both
  machines destroyed with the reason and phase line, report `starts_blocked` `host_table`, a later
  assignment fails `starts_blocked` even after the check passes again) and
  `TestIsolationCheckedOffline` (the `Run` loop destroys the machine with the platform unreachable).
  KVM `TestLifecycle` extended: with the platform unreachable, deleting the table while a VM runs
  kills the VM within the 30 s bound (check every 1 s in the test), nothing is left behind, then the
  report shows `host_isolation_lost` with the phase line and `starts_blocked` `host_table`, and a new
  assignment fails `starts_blocked`.
- Driver options take a `TableManager` interface (`hostnet.Nft` by default) for the fake.
