# Handoff: Self-hosted job hosts P2: kete-job-host agent core with a fake driver

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-03 build agent (spec, plan, build in one session; coordinator-delegated, user approved design + build)

Done: spec (approved status per the user's "design + build all"), plan, build, cards (result.md
for files and checks). Nothing committed or pushed.

### Decisions (none changes the security posture beyond ADR 0023; each is stricter or neutral)

- **E1 HPKE dependency: none.** Go 1.26's standard library has `crypto/hpke` (RFC 9180, base mode,
  `DHKEM(X25519)`, HKDF-SHA256, AES-128-GCM, `DeriveKeyPair`). It opens both vectors, refuses all 7
  refusals, derives the vectors' recipient and ephemeral keys from their `ikm`, and opens RFC 9180
  A.1.1. So `github.com/cloudflare/circl` is not needed; the module's only non-stdlib dependency is
  `golang.org/x/sys` (already pinned by the siblings). Seal reproduction with the fixed `ikm_e`
  isn't possible through `crypto/hpke`'s API (it draws the ephemeral key from `crypto/rand`); the
  `DeriveKeyPair(ikm_e) = pk_e` check plus opening the platform's ciphertext covers the same
  ground.
- **E2 cosign verifier: interface now, real implementation in P4.** `image.Verifier` with one
  production implementation, `image.Unconfigured`, which refuses every image
  (`image_signature_invalid`). Reasons: sigstore-go pulls in dozens of modules (protobuf specs,
  go-tuf, in-toto, transparency-log clients) against CLAUDE.md's "small" bar, and P2 has nothing to
  verify — no driver fetches images until P4, which is where image fetch, layer verification and
  the per-digest cache live. Failing closed means no image can run on a P2 agent. **P4 must**
  implement `Verifier` with sigstore-go (identity `kete-release.yml` on a `kete-v*` tag of
  kete-org/ketecode, issuer `https://token.actions.githubusercontent.com`, the Sigstore trusted
  root, offline-capable TUF cache), justify the dependency then, and move `Verify` out of the agent
  mutex (it will do I/O; today `check` holds the lock).
- **E3 no real driver ⇒ `run` refuses.** `newDriver` returns "not built yet (P4/P5)" and `run`
  exits 2 rather than running a fake (CLAUDE.md §10). The fake driver is a test package only.
- **E4 check order.** The contract's table order with cheap checks first: `deadline_passed` →
  `starts_blocked` → `no_free_slot` → `image_not_allowed` → `image_signature_invalid` → HPKE open
  (`config_undecryptable`) → `platform_url` (`platform_mismatch`, before any other plaintext field
  is used, ADR rule 13) → `config_invalid` → `generation_mismatch` → `driver_failed`. "Before it
  decrypts anything else" is read as: images before decryption, platform URL before using the rest
  of the plaintext (the URL is inside the ciphertext).
- **E5 stricter configuration check.** Besides strict decoding, the plaintext must equal its
  canonical encoding byte for byte (Go's JSON matching is case-insensitive, and the contract says
  compact, fields in order); the TypeScript sealer produces exactly that. Any difference is
  `config_invalid`.
- **E6 run entry without `config` for an unknown machine** (only after lost state) is
  `config_invalid` — no contract reason fits exactly; the machine never ran, so `failed` is right.
- **E7 response discard rules.** Discarded whole (nothing applied, phase lines resent, backoff):
  invalid body, `in_reply_to` ≠ nonce, `host_id` ≠ ours, `revision` below the applied one
  (equal is applied: idempotent). A duplicate machine id in `run` makes the body invalid.
- **E8 tombstones** are forgotten only when the answered report carried them in a terminal state
  (not merely carried them), so a machine that ended between report and response is always
  reported terminal at least once.
- **E9 halts.** `host_revoked` and `generation_mismatch`: destroy everything (`host_disabled`),
  persist the halt, exit 3 when no machine is left; restart refuses (re-enroll with `--replace`).
  `signature_invalid`: polling stops in memory only, machines are **not** destroyed (a platform
  misconfiguration shouldn't kill running jobs; the deadline killer still bounds them), exit 3
  once none is left. Unit: `RestartPreventExitStatus=2 3`.
- **E10 restart reconcile.** Driver machines without a live record: stopped, reported
  `destroyed`/`desired` with `job_id` null (only if the id is a UUID; anything else is stopped
  silently). Live records whose machine vanished: `destroyed`/`crashed` (or the pending stop
  reason). `preparing` records not in the driver are dropped (never started; the platform
  re-delivers the config). Running ones re-adopted; age (`max_age`) counts from the persisted
  acceptance time.
- **E11 slots.** Free slots = declared − live machines; `stopping` counts until destroyed.
- **E12 enrollment generation.** firecracker without a configured `generation` gets
  `g-YYYYMMDD-<8 hex>` at enrollment (stored in the state file); dedicated must configure it.
- **E13 client.** No environment proxy (`Proxy: nil`), no redirects, TLS ≥ 1.2 with system roots;
  backoff `10 s · 2^n` plus up to half of jitter, capped at 5 min, `max(backoff, Retry-After)`.
- **E14 logs** never include server `message` text (only `reason`, status and a sanitised
  `request_id`) or error strings from the platform.

### Open issues / for later phases

- **P3 (plat):** the fake platform (`internal/fakeplatform`) mirrors the routes as P2.0 describes;
  P3's real routes should be run against this agent once (optional cross-repo check in the
  overview). The platform's plan-overview status row for P2 (kc) can move to "built" (this repo
  can't edit it).
- **P4:** real `Verifier` (E2); image fetch + layer verification + per-digest cache; the
  firecracker driver must honour `driver.Driver`'s rules (config only via the config disk built by
  `seal.ConfigDisk`, `panic=1` on the guest command line per P1, scratch disk labelled
  `kete-scratch`); review the unit's `KillMode`/cgroup placement so VMs survive an agent restart;
  driver-specific `doctor` checks; install script; consider moving long driver calls out of the
  agent mutex (`Stop` holds it today).
- **P5:** dedicated driver (config pipe + `KETE_JOB_HOST_PROFILE=dedicated`, a reaper per P1's
  handoff), TPM-resident keys before `measured_boot` is accepted by `config.Parse`.
- **CI:** `kete-job-host.yml` hasn't run on GitHub yet (nothing pushed).
- Phase lines are memory-only: lines not yet acknowledged are lost on an agent restart (the
  contract doesn't require persistence).

## 2026-10-03 build agent — security review fixes (coordinator relay)

1. **MAJOR, enrollment overwrote keys before acceptance — fixed.** `enroll` now stages the new
   keys next to the current ones (`keys.SaveStaged`, `signing.key.new` / `sealing.key.new`), and
   only after the 201 is validated (shape, fingerprint) runs `keys.CommitStaged` (rename sealing,
   then signing, fsync the dir) and then writes `state.json` (state last). Any failure (network,
   refused token, `key_in_use`, 5xx, invalid response) runs `DiscardStaged` and leaves the old keys
   and state untouched; leftovers from an earlier crash are discarded first. Residual: a crash
   between the two renames, or between the renames and the state write, leaves keys that match no
   state; the agent refuses to start on that mismatch (re-enroll). Test
   `TestReplaceKeepsOldIdentityOnFailure` (network failure, invalid token, 5xx, success) and
   `keys.TestStaged`.
2. **fsutil.** Every check opens with `O_NOFOLLOW|O_CLOEXEC` (`O_DIRECTORY` for dirs) and checks
   the descriptor with fstat (kind, mode, owner); reads use that descriptor. Owner must be uid 0.
   `CheckAncestors`: every ancestor of a private directory (and of a private file's directory)
   must be a root-owned directory, not a symlink, without group/other write. Tests
   `fsutil.TestRefusals` (non-root file and dir, group-readable, symlink, world-writable /
   foreign-owned / symlinked ancestor), `TestPrivateDirAndFiles`. Consequence: the tests must run
   as root; they build their state under a fresh root-owned directory below `/`
   (`internal/testroot`, fails with an explanation for other users), and CI runs
   `sudo env PATH=$PATH go test -race ./...`.
3. **Config file.** `config.Load` uses `fsutil.OpenRootFile`: a root-owned regular file without
   group/other write (world-readable allowed), no symlink, root-owned non-writable ancestors.
   `doctor` reports a refused config as `FAIL config …` (exit 1) instead of exiting 2. Tests
   `config.TestLoadFileRules`, `fsutil.TestOpenRootFile`, `TestDoctorReportsConfigFile`.
4. **Killer independent of reconcile.** `Run` starts the supervise loop first, then retries
   `Reconcile` with backoff (10 → 300 s, scaled by `Interval`) until it succeeds; polling waits
   for it. Test `TestKillerRunsWhileReconcileFails` (List fails → the overdue known machine is
   destroyed, no poll is sent; List recovers → polling starts).
5. **Driver calls.** `DriverTimeouts` (Start 2 min, Stop 1 min, Status/Logs 10 s, List 30 s;
   options so tests use 300 ms). Every per-machine driver call runs in that machine's worker
   goroutine (`kick`/`work`/`step`), one worker per machine, with `a.mu` released; `Supervise`
   kicks idle workers and doesn't wait; `PollOnce` waits for workers (bounded by the timeouts); a
   start failure whose cleanup Stop fails is retried via `a.cleanup`. The driver contract (honour
   the context, no same-machine concurrency, idempotent Stop, List completeness) is in
   `internal/driver/driver.go`. Tests `TestHangingDriver` (one machine's Stop/Status/Logs hang:
   Supervise returns at once, the other overdue machine is destroyed well within the timeout,
   `Snapshot` isn't blocked, the hung one is destroyed once the hang clears) and
   `TestHangingStart` (a hung Start fails the machine `driver_failed`). Stress: the agent package
   passed `-race -count=8`.
6. **Halt at startup.** `Reconcile` destroys every machine (`host_disabled`) when the state file
   holds a durable halt; `Run` then exits halted. Test `TestHaltedAtStartupDestroysAll`.
7. `kete-job-host.yml`: checkout with `persist-credentials: false` (and tests via sudo, item 2).
8. **E9 kept**, documented in the README poll table, the agent code comment and the `job-host`
   card: while halted on `signature_invalid` with machines, the host reports nothing; the platform
   sees a stale host (`status` `unavailable`) until the machines end or the deadline killer
   destroys them (deadline + 5 min, 135 min).

Checks after the fixes: gofmt clean; `go vet` (linux, `GOOS=darwin`); `go test -race -count=1
./...` all 14 packages pass (golang:1.26-bookworm, as root); agent and enroll packages
`-race -count=8` pass; non-root run fails with the testroot explanation (intended); build ok;
actionlint, `bun run lint`, `upstream:check`, `card-check` pass. Docker image and volumes used
for the run removed.
