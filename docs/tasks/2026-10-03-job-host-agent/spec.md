# Spec: Self-hosted job hosts P2: kete-job-host agent core with a fake driver

- Task: `docs/tasks/2026-10-03-job-host-agent` · Size: large · Created: 2026-10-03
- Status: built (approved by the user, 2026-10-03: design + build all)

## Goal
Build the host agent of ADR 0023 (kete-code-platform `docs/adr/0023-self-hosted-job-hosts.md`,
rules 6, 9–13, 17, 19) up to, but not including, a real VM driver: a Go module
`packages/kete-job-host` that enrolls a host, polls the platform with RFC 9421-signed requests,
applies the desired state, opens HPKE-sealed machine configurations, runs machines through a
`Driver` interface (a fake driver in tests), and enforces deadlines even while offline. It speaks
the `job-host-v1` contract (platform `docs/contracts/job-host-v1.md`, P2.0) exactly and passes the
shared test vectors byte for byte, so P3 (platform routes) and P4/P5 (firecracker, dedicated
drivers) plug into it.

## Scope
New module `packages/kete-job-host` (new card `job-host`), on the conventions of
`packages/kete-root-helper` and `packages/kete-egress` (cards `root-helper`, `egress`):

- **Keys:** Ed25519 signing + X25519 sealing keys, generated at `enroll`, stored root-owned `0600`
  in a `0700` directory under the state directory; loading refuses group/world-accessible files and
  any non-canonical or small-order Ed25519 public key (P2.0 handoff). Fingerprint = hex SHA-256 of
  the raw Ed25519 then X25519 public keys, printed in groups of 4.
- **`kete-job-host enroll`:** single-use token from stdin (never argv, env or logs); signed
  enrollment request with `keyid` = fingerprint; stores `host_id`, generation, status.
- **Signer/verifier:** the fixed RFC 9421 profile (components, parameter order, `ed25519`, tag,
  `created`/`expires` = +60 s, 16-byte hex nonce), RFC 9530 `Content-Digest`; a Go verifier with the
  contract's order and reasons (used by the fake platform and the vector tests), canonical S, the
  libsodium small-order blocklist, the dummy-key path for unknown keys.
- **Poll/report loop:** every 10 s (`next_poll_after` 1–60 s), 15 s request timeout, exponential
  backoff 10 s → 5 min with jitter after network errors, 5xx and 429 (`Retry-After` honoured), 1 MiB
  response cap, TLS verification always on; never polls while the kernel reports the clock
  unsynchronised (`adjtimex`); every refusal reason handled as the contract's table says.
- **Desired state:** `in_reply_to` must equal the nonce just sent and `host_id` ours, else the
  response is discarded (no state change, phase lines not acknowledged); a `revision` below the
  applied one is discarded as stale; every held machine not in `run` is destroyed (`desired`);
  `destroy` honoured; tombstones kept until a fresh response that answered a report carrying them
  names them in neither list; a machine id is never started twice.
- **Assignment checks, in order:** deadline passed → starts blocked → no free slot → image ref in
  the local allowlist (exact `registry/repo@sha256:…`) → image signature (verifier interface) →
  HPKE open with the binding (`config_undecryptable`; binding values validated first) →
  `platform_url` equals the configured origin (`platform_mismatch`) → strict `JobMachineConfig`
  (`config_invalid`: job id equals the assignment's, profile `microvm` for firecracker / `dedicated`
  for dedicated) → dedicated `host_generation` equals the host's (`generation_mismatch`) → driver
  start (`driver_failed`).
- **Machine state machine:** `preparing → starting → running → stopping → destroyed`, or `failed`;
  reasons exactly the contract's (with their state); `since` per transition.
- **Durable state file** (`state.json`, atomic write + fsync, `0600`): host id, generation,
  applied revision, halt reason, machines (no configuration, no claim token, no keys). **Restart
  reconcile:** driver machines without a live state record are stopped (reported `destroyed`,
  `job_id` null); records whose machine vanished are reported `destroyed` `crashed`; running ones
  re-adopted.
- **Deadline killer:** independent of polling; destroys a machine past deadline + 5 min
  (`deadline`) or older than 135 min (`max_age`); runs while the platform is unreachable.
- **Driver interface** (`Start`, `Stop`, `Status`, `List`, `Logs`) and a **fake driver** (test
  package). The binary has no real driver yet: `run` with `firecracker` or `dedicated` refuses to
  start ("driver not built", P4/P5), as does `dedicated` without a verified reset and
  `measured_boot` without TPM-resident keys (P5).
- **Phase lines:** only lines that parse as `JobHostPhaseLine` (strict), raw lines over 512 bytes
  dropped, ≤ 200 per machine per report, the rest counted; resent after a lost response.
- **Config disk builder** (for P4) checked against `config-disk.json`.
- **Structured logs** (`log/slog` JSON): ids, states, reasons, request ids; never a token, key,
  ciphertext, plaintext configuration or server message text.
- **Packaging:** systemd unit, README (contract pointers, configuration, layout, security model,
  how to test), CI workflow `kete-job-host.yml` (path-filtered; gofmt, vet, `go test -race`).
- **Test vectors:** the three platform files copied byte for byte into
  `packages/kete-job-host/testdata/job-host-v1/` with a checked-in `SHA256SUMS`; a test fails when
  either drifts. Contract copied to `docs/platform/job-host-v1.md`.
- **Fake platform** (`internal/fakeplatform`): both routes per P2.0 (verification order, nonce
  store, host states, token single use, desired state with config until running/terminal,
  tombstone acknowledgement, revisions), with hooks to tamper responses.
- Docs: `job-host` card, INDEX, repo-map, commands, contracts §6f, kete-tools-ci card (workflow).

## Out of scope
Real drivers (firecracker P4, dedicated P5), image fetch/layer verification/rootfs conversion and
the real cosign verifier (P4, see AC6), host nftables table (P4), TPM keys and R1/R2 resets (P5),
platform routes and adapter (P3), install script and driver-specific `doctor` checks (P4).

## Acceptance criteria
- [ ] AC1 (vectors): every case of `signatures.json` (2 signed requests reproduced byte for byte,
  all 16 refusals with their reason, RFC 9421 B.2.6, RFC 9530 B.1), `hpke.json` (2 opens, 7
  refusals, RFC 9180 A.1.1, recipient/ephemeral key derivation) and `config-disk.json` pass; the
  copies match `SHA256SUMS` and the hashes of the platform's files.
- [ ] AC2 (lifecycle): against the fake platform over real TLS: enroll → pending → approved → poll
  → assignment → image allowed → config opened → fake machine started → reported running with
  phase lines → removed from desired → stopped → reported destroyed → tombstone acknowledged and
  forgotten.
- [ ] AC3 (refusals): each a test — image not allowlisted, signature verifier refusing, platform
  URL mismatch, tampered ciphertext / wrong binding, wrong job id or profile, dedicated generation
  mismatch, deadline passed, no free slot, starts blocked, driver failure.
- [ ] AC4 (replay and clock): a response with another `in_reply_to` or `host_id`, or a lower
  `revision`, changes nothing; the fake platform refuses a replayed nonce and a skewed `created`
  (`clock_skew`) and the agent retries with a fresh nonce; with the clock unsynchronised no request
  is sent.
- [ ] AC5 (host states): `host_pending` → keeps polling, no machines; `host_disabled` /
  `host_revoked` / `generation_mismatch` → every machine destroyed (`host_disabled`), revoked and
  generation mismatch halt polling durably; `signature_invalid` halts polling but keeps the
  deadline killer.
- [ ] AC6 (images): the allowlist is exact refs; the signature check is an interface whose only
  production implementation in P2 refuses everything (fail closed), so no image can run until P4
  wires sigstore-go; decision recorded in handoff.
- [ ] AC7 (restart and deadline): restart re-adopts a running machine, stops an unknown one and
  reports a vanished one; the deadline killer destroys at deadline + 5 min and at 135 min with the
  platform offline, and the next report carries the tombstone.
- [ ] AC8 (no secrets): the claim token, the enrollment token, both private keys and the plaintext
  configuration appear in no log line, state file or report body over a whole run (grep test); key
  and state files are `0600` in `0700` directories.
- [ ] AC9 (checks): gofmt, `go vet`, `go test -race ./...` (golang:1.26-bookworm), actionlint on the
  new workflow, `bun run lint`, `upstream:check`, `card-check`.

## Risks and constraints
- Security: this is a root daemon handling claim tokens. No change beyond ADR 0023: no listening
  port, TLS verification never off, signed requests only, fail closed on every check, secrets never
  persisted or logged. Stricter-than-contract choices are recorded in handoff.md.
- Contract: the shared vectors are the interop proof with P3; a drift test guards the copies.
- Dependencies: Go 1.26's standard library has `crypto/hpke`, so HPKE needs no third-party module;
  `golang.org/x/sys` (already used by the sibling modules) for `adjtimex` and `uname`.
- No upstream file is touched.
