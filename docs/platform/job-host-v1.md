<!-- Copied from kete-code-platform docs/contracts/job-host-v1.md at commit 04d406a (2026-10-03). The platform copy is the source of truth; update both together, and re-copy the test vectors into packages/kete-job-host/testdata/job-host-v1/ with them. -->

# Job host API contract — v1

Standalone copy of the self-hosted job host contract for the `kete-code` repository (the host
agent `kete-job-host`, `packages/kete-job-host`). The source of truth is
`packages/shared/src/api/v1/job-hosts.ts` in `kete-code-platform`; the schema block below is kept
identical to it, and a test there fails if they differ. Crypto (digest, signing, HPKE) is
`packages/shared/src/job-host-crypto.ts`. Design: ADR 0023 rules 6–13 and 16–19; program
`docs/tasks/2026-10-03-self-hosted-job-hosts/plan-overview.md` (P2.0).

Status: **contract defined, routes not served yet** (they land in P3).

**Test vectors** (both repos check them; kete-code copies them byte for byte):

| File | Holds |
|---|---|
| `docs/contracts/test-vectors/job-host-v1/signatures.json` | fixed Ed25519 and X25519 keys and their fingerprint; a signed `enroll` and a signed `poll` request (body, headers, signature base, verify time); 16 refusals with the reason each must produce (including an enroll `keyid` that isn't the body keys' fingerprint, a malleated S + L signature and a small-order public key); RFC 9421 B.2.6 and RFC 9530 B.1 references |
| `docs/contracts/test-vectors/job-host-v1/hpke.json` | the recipient key; two seals (`microvm`, `dedicated`) with a fixed ephemeral key (`ikm_e`), the `info`, plaintext, ciphertext and wire envelope; 7 refusals that must fail to open; the RFC 9180 A.1.1 reference |
| `docs/contracts/test-vectors/job-host-v1/config-disk.json` | a config disk's header, JSON, size and the SHA-256 of the whole image |

Every secret in them is SHA-256 of a public label (the builder is
`packages/shared/src/job-host-test-vectors.ts`), so none is a real key. A change to them is a
contract change.

## Conventions

- Two routes, both `POST`, both `Content-Type: application/json` (exactly, no parameters), UTF-8,
  compact JSON. Responses carry `x-kete-request-id` and `Cache-Control: no-store`.
- Every request is **signed** (below). No bearer token, cookie or API key is ever used.
- **Request bodies are strict**: an unknown field is `400 malformed_request`. **Responses only gain
  fields** within v1: the agent ignores fields it doesn't know.
- Size limits: enroll body ≤ 8 KiB, poll body ≤ 1 MiB (larger: `400 body_too_large`, read
  before anything else); the agent reads at most 1 MiB of a response.
- Ids (host, machine, job) are lowercase UUIDs. Keys and the HPKE `enc` are raw 32 bytes in
  canonical unpadded base64url. Times are RFC 3339 with an offset; signature times are integer
  Unix seconds.
- Timeouts: the agent gives each request 15 s and backs off exponentially (from 10 s, to at most
  5 min, with jitter) after a network error, a 5xx or a 429 (honouring `Retry-After`).
- The agent never polls while NTP reports its clock unsynchronised (ADR 0023 rule 9).

## Signatures (RFC 9421 profile)

The agent signs every request with its Ed25519 key. The profile is fixed — one label, one
component list, one parameter order — so neither side needs a general structured-field parser,
and a verifier refuses anything else as `signature_malformed`.

- Headers: `Content-Type`, `Content-Digest` (RFC 9530, exactly one member, `sha-256`, over the
  exact body bytes), `Signature-Input` and `Signature` (one member each, label `kete`). A repeated
  header or another label is `signature_malformed`.
- Covered components, in order: `"@method"`, `"@authority"`, `"@path"`, `"content-type"`,
  `"content-digest"`.
- Parameters, in order: `created` (Unix seconds), `expires` (1–60 s after `created`; the agent
  sets `created + 60`), `nonce` (16 random bytes, lowercase hex, never reused), `keyid`,
  `alg="ed25519"`, `tag="kete-job-host-v1"`.
- `keyid`: the host id on `poll`; on `enroll` (no host id yet) the fingerprint of the keys in the
  body — the platform verifies with the body's `signing_key` and requires `keyid` to equal their
  fingerprint, which proves the agent holds the signing key. The enroll route must use
  `verifyJobHostEnrollment` (`job-host-crypto.ts`), which does exactly that; the poll route
  `verifyJobHostRequest` with the host's stored key.
- **Key and signature hygiene** (both sides): a public key that is non-canonical (y ≥ p) or of
  small order (the libsodium blocklist, sign bit ignored) is refused, and so is a signature whose S
  is not below the group order L (RFC 8032 §5.1.7). This is explicit in code: Web Crypto in Node
  accepts the identity key with the forged signature R = identity, S = 0 for any message, which
  `signatures.json` includes as a refusal. Enrollment refuses such a `signing_key` the same way.
- **Unknown keys cost the same as bad signatures:** when `keyid` names no key (or an unacceptable
  one), the verifier still runs a verification against a fixed dummy key and discards the result,
  then answers `signature_invalid`.
- `@authority`: the verifier uses **its configured public host**, never the received `Host` header
  (proxies). Lowercase, no port. `@path`: the route path, no query.
- Signature base (RFC 9421 §2.5): one `"<component>": <value>` line per component, then the
  `"@signature-params"` line, joined by `\n`, no trailing newline. `Signature` is
  `kete=:<standard base64 of the 64-byte signature>:`.
- **Verification order** (the first failure is the answer): content type (`malformed_request`) →
  `Content-Digest` present and well formed (`signature_malformed`) and equal to the body's
  (`digest_mismatch`) → `Signature-Input` and `Signature` exactly per profile
  (`signature_malformed`) → `|now − created| ≤ 60` and `now ≤ expires` (`clock_skew`) → key
  known and signature valid (`signature_invalid`, one reason for both: no oracle) → nonce not seen
  for this `keyid` in the last 120 s (`nonce_replayed`; the platform keeps each pair until
  `created + 120`) → host state (`host_pending`, `host_disabled`, `host_revoked`) → body schema
  (`malformed_request`) → `generation` (`generation_mismatch`).
- **Responses are not signed.** Their authenticity and integrity come only from TLS to the
  agent's configured platform URL (certificate verification on, never pinned off). A poll
  response echoes the request's nonce as `in_reply_to`, and the agent discards a response whose
  `in_reply_to` isn't the nonce it just sent. The sealed configuration is confidential and bound to
  its host, machine, job and generation, but HPKE base mode does **not** authenticate the sender:
  anyone with the host's public key can seal a configuration, so it proves nothing about who sent
  it. What limits a forged or compromised platform is the agent's own checks (configured platform
  origin, image digest allowlist and signature, ADR 0023 rules 13 and 17).

The signed `poll` request of `signatures.json`, its headers:

```text
Content-Type: application/json
Content-Digest: sha-256=:6wORMGyX85X9rFt4nK9T02ad1xLSygvTiiILmJ3hD78=:
Signature-Input: kete=("@method" "@authority" "@path" "content-type" "content-digest");created=1790992800;expires=1790992860;nonce="f0e1d2c3b4a5968778695a4b3c2d1e0f";keyid="7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f";alg="ed25519";tag="kete-job-host-v1"
Signature: kete=:ddaaXs1RY3XF0m/bVvGd/nYCBEv4JE+JEDKSf6Ra+VfjrI0AOLHY30iXuWJTkf9RKExjgCHLpPgAvd/zF0M7Cg==:
```

and its signature base (the exact bytes signed):

```text
"@method": POST
"@authority": portal.kete.example
"@path": /api/v1/job-hosts/poll
"content-type": application/json
"content-digest": sha-256=:6wORMGyX85X9rFt4nK9T02ad1xLSygvTiiILmJ3hD78=:
"@signature-params": ("@method" "@authority" "@path" "content-type" "content-digest");created=1790992800;expires=1790992860;nonce="f0e1d2c3b4a5968778695a4b3c2d1e0f";keyid="7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f";alg="ed25519";tag="kete-job-host-v1"
```

The signed `enroll` request's signature base (`keyid` is the fingerprint):

```text
"@method": POST
"@authority": portal.kete.example
"@path": /api/v1/job-hosts/enroll
"content-type": application/json
"content-digest": sha-256=:g/WdUO00UEfXJt0EmmIpyInAsKwawbfvyEVa1+0G3Lw=:
"@signature-params": ("@method" "@authority" "@path" "content-type" "content-digest");created=1790992800;expires=1790992860;nonce="000102030405060708090a0b0c0d0e0f";keyid="03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a";alg="ed25519";tag="kete-job-host-v1"
```

## Enrollment — `POST /api/v1/job-hosts/enroll`

1. A platform admin creates the host on `/admin/job-hosts` (P3), which shows a single-use
   **enrollment token** (`kete_jhe_…`, valid 1 hour, only its SHA-256 stored).
2. `kete-job-host enroll` reads the token from stdin, generates an Ed25519 signing key and an
   X25519 sealing key (root `0600`; TPM-resident for `measured_boot`), prints the **fingerprint**
   (hex SHA-256 of the raw Ed25519 public key followed by the raw X25519 public key, shown in
   groups of 4), and sends `JobHostEnrollRequest` signed with the new key.
3. `201 JobHostEnrollResponse`: `pending` until an admin approves after comparing fingerprints;
   `active` only for an R1 re-enrollment the platform started (ADR 0023 rule 8). The agent stores
   `host_id` and polls.

Facts the agent declares, and the rules the schema enforces: `firecracker` needs `kvm: true`,
`reset: "none"` and the `firecracker` and `guest_kernel` versions; `dedicated` has exactly 1 slot,
`reset` `provider_rebuild` or `measured_boot` (ADR 0023 rule 8: anything else is refused), and no
Firecracker versions. `generation` is fixed for the life of the keys: a dedicated host's verified
reset generation; on a firecracker host any fresh value. Same pattern as kete-code's
`host_generation`.

Refusals: a token that is unknown, used, expired or revoked is one reason,
`401 enrollment_token_invalid`, and the token is spent by any signed attempt; a signing key
already enrolled for another host is `409 key_in_use`.

## Poll — `POST /api/v1/job-hosts/poll`

Every 10 s while idle (`next_poll_after` overrides, 1–60 s), the agent sends its **report** and
receives the **desired state**. Both are idempotent: a lost response is simply repeated on the
next poll.

**Report (`JobHostReport`).** `generation` (must equal the enrolled one), `versions`, `slots`
(`total`, `free`), `starts_blocked` (null, or why the agent has stopped starting machines — e.g.
`host_table` when the nftables table is missing or changed), `applied_revision` (the last
`desired.revision` it applied, null before the first), and `machines`: every machine it holds plus
tombstones (below), each with `state`, `since`, `reason` (exactly with `failed`/`destroyed`) and
the phase lines since the last **answered** report (≤ 200 per machine; every field is bounded, so
that stays under 46 KiB; the rest, and any raw line over 512 bytes, are dropped and counted in
`phase_lines_dropped`). Phase lines are only lines
that parse as the entrypoint's or kete-job-init's phase-line JSON (ADR 0023 rule 19); never
anything else from the guest, and never the configuration.

Machine states: `preparing` (assignment accepted: image fetch, verification, disks) →
`starting` → `running` → `stopping` → `destroyed`; or `failed` when it never ran. `failed`
and `destroyed` are terminal: nothing of the machine remains.

| Reason | With | Meaning |
|---|---|---|
| `image_not_allowed` | failed | digest not in the agent's allowlist (ADR 0023 rule 17) |
| `image_signature_invalid` | failed | the release signature didn't verify against the release identity |
| `image_unavailable` | failed | the image couldn't be fetched or a layer failed verification |
| `platform_mismatch` | failed | the sealed configuration's `platform_url` isn't the agent's configured origin |
| `config_undecryptable` | failed | HPKE open failed (wrong binding, tampered, other key) |
| `config_invalid` | failed | the plaintext isn't a valid configuration for this assignment |
| `generation_mismatch` | failed | a dedicated configuration's `host_generation` isn't the host's |
| `no_free_slot` | failed | more assignments than free slots |
| `deadline_passed` | failed | the assignment arrived after its deadline |
| `starts_blocked` | failed | starts are blocked (`starts_blocked` says why) |
| `driver_failed` | failed | the driver couldn't start the machine |
| `exited` | destroyed | the guest powered off by itself (the job ended) |
| `desired` | destroyed | the desired state no longer runs it |
| `deadline` | destroyed | the deadline killer: past deadline + 5 min |
| `max_age` | destroyed | the deadline killer: older than 135 min |
| `host_disabled` | destroyed | the platform answered `host_disabled` or `host_revoked` |
| `crashed` | destroyed | the VMM or process died unexpectedly |

**Desired state (`JobHostPollResponse.desired`).**

- `run`: every machine that should exist and run — machine id, job id, image by digest,
  deadline, resources (default 4 vCPU, 4096 MiB, 20 GiB scratch) and, until the host reports the
  machine `running` or terminal, its sealed `config`. A machine the agent already holds is a no-op;
  a new one is prepared and started. The agent checks the image digest against its allowlist and
  the platform URL against its own configured origin before it decrypts anything else.
- `destroy`: machines the platform wants gone and hasn't yet seen `destroyed` or `failed`.
- On every fresh response the agent destroys every machine it holds whose id isn't in `run`
  (ADR 0023 rule 12), reported with reason `desired`.

**Acknowledgements.** All implicit in the state exchange, so a lost message never needs a retry
protocol:

- The **report acknowledges assignments**: a machine id in the report (any state) means the
  assignment was received. The platform keeps sending `config` until the machine is reported
  `running` or terminal, then deletes the ciphertext (ADR 0023 rule 13) and omits it.
- The **desired state acknowledges terminal states**: a machine stays in `destroy` until the
  platform has recorded it `destroyed` or `failed`. The agent keeps reporting a terminal machine
  (a tombstone) while any desired state names it, and forgets it after the first fresh response
  that names it in neither `run` nor `destroy`.
- `applied_revision` acknowledges the whole desired state (the platform shows it to admins).
- Phase lines are acknowledged by an answered poll: lines sent in a report whose response the
  agent received and accepted are not sent again; after a lost response they are resent.

**Refusals and host states.** `403 host_pending`: not approved yet — retry every 30–60 s, hold no
machines. `403 host_disabled` / `host_revoked`: treat as an empty desired state (destroy
everything, reason `host_disabled`); retry `host_disabled` every 60 s, stop polling on
`host_revoked` (its keys are refused forever) and tell the operator. A `draining` host keeps
polling and is served its existing machines but no new ones. `403 generation_mismatch`: the host
needs re-enrollment; destroy everything. `401 clock_skew`: check NTP before the next poll (the
`Date` header may be logged for diagnosis, never used to set the clock).

## Sealed configuration (RFC 9180)

- HPKE **base mode**, suite DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001`,
  AES-128-GCM `0x0001`, single-shot seal (sequence number 0), to the host's X25519 key.
- `info` (UTF-8) binds the ciphertext to its host, machine, job and the host's generation, one
  per line, no trailing newline:

  ```text
  kete-job-host-v1 sealed-config
  host_id=7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f
  machine_id=3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b
  job_id=9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61
  generation=g-2026-10-03.1
  ```

  The AEAD additional data is **empty**: the binding is in the key schedule, so a ciphertext
  moved to another host, machine, job or generation fails to open exactly as an AAD mismatch
  would.
- Envelope (`JobHostSealedConfig`): the three suite ids, `enc` (the ephemeral public key) and
  `ciphertext` (plaintext + 16-byte tag), both unpadded base64url. A fresh ephemeral key per seal.
- Base mode gives confidentiality and binding, not sender authentication (see "Responses are not
  signed" above): authenticity comes from TLS to the configured platform URL.
- The binding values are validated before use: ids must be lowercase UUIDs and the generation a
  valid generation (`isValidJobHostConfigBinding`), so no value can inject a line into `info`;
  seal and open refuse anything else (`invalid_config`).
- The agent opens it only after the image and platform checks above, then validates the
  plaintext as `JobMachineConfig`: `job_id` equal to the assignment's, `host_profile` `microvm`
  for firecracker and `dedicated` for dedicated (with `host_generation` equal to its own
  generation). Every open failure is one error (`config_undecryptable`).
- The database holds only the ciphertext, until the machine is reported running or withdrawn.

## Machine configuration

The plaintext is kete-code's config payload (`bootenv.Config`; kete-code task
`2026-10-03-job-host-profiles` decision D2), unchanged: one compact JSON object, ≤ 4096 bytes, no
unknown field, fields in this order — `job_id`, `platform_url` (the normalized origin,
`https://host`), `claim_token`, `storage_host`, `host_profile`, `host_provider` (exactly for
`cloudvm`), `host_generation` (exactly for `dedicated`); absent optionals are omitted, never
null. The same object is the dedicated driver's config pipe (`--config-fd`, with
`KETE_JOB_HOST_PROFILE=dedicated` in the entrypoint's environment), the JSON on the firecracker
config disk, and (unsealed, ADR 0023 rule 14) a cloud VM's user data. ADR 0023 rule 13 lists a
`network` value too: the agent owns guest networking (its tap device, /30 and resolvers come from
its own configuration and become the kernel's `ip=` argument), so it is not part of the
configuration. Never on a kernel command line, in Firecracker's API or MMDS, in a log, a report or
`job_events`.

## Config disk

For the firecracker driver: a raw image of exactly **8192 bytes** — the header
`kete-job-config v1\n` (kete-code `hostprofile.ConfigDiskHeader`), the configuration JSON (profile
`microvm`), then NUL bytes to the end. Owned by the VM's jail uid, `0600`, attached read-only,
unlinked once the VM has started; kete-job-init reads it and the entrypoint refuses to run while
any block device still starts with the header. `config-disk.json` gives the SHA-256 of one image.

## Errors

Every non-2xx body is the platform error shape plus a `reason` the agent acts on
(`JobHostErrorResponse`).

| Status | `code` | `reason` | Agent action |
|---|---|---|---|
| 400 | `invalid_request` | `malformed_request`, `body_too_large`, `digest_mismatch`, `signature_malformed` | a bug: log, back off, don't retry the same body unchanged |
| 401 | `invalid_key` | `signature_invalid` | wrong or unknown key: stop, tell the operator |
| 401 | `invalid_key` | `clock_skew` | check NTP, retry |
| 401 | `invalid_key` | `nonce_replayed` | retry with a fresh nonce |
| 401 | `invalid_key` | `enrollment_token_invalid` | enrollment failed: get a new token |
| 403 | `forbidden` | `host_pending`, `host_disabled`, `host_revoked`, `generation_mismatch` | see "Refusals and host states" |
| 409 | `conflict` | `key_in_use` | generate new keys, get a new token |
| 429 | `rate_limited` | `rate_limited` | honour `Retry-After` |
| 503 | `unavailable` | `unavailable` | back off, retry |
| 500 | `internal` | `internal` | back off, retry |

## Limits and timings

| Constant | Value |
|---|---|
| Enroll / poll request body | 8 KiB / 1 MiB; response read by the agent ≤ 1 MiB |
| Slots per host | 1–32 (dedicated: 1) |
| Machines per report | ≤ 128 |
| Phase lines per machine per report | ≤ 200 lines (< 46 KiB); raw lines over 512 bytes dropped |
| Signature window | `|now − created|` ≤ 60 s, `expires − created` 1–60 s, nonces kept 120 s |
| Poll interval | 10 s idle; `next_poll_after` 1–60 s |
| Fresh / stale report (platform) | ≤ 60 s eligible for placement; > 90 s `unavailable` |
| Enrollment token | single use, 1 hour |
| Deadline killer (agent, offline too) | deadline + 5 min; any machine older than 135 min |
| Machine configuration | ≤ 4096 bytes; config disk exactly 8192 bytes |

## Schemas (Zod)

```ts
import { z } from 'zod'
import { ErrorCode } from './errors'

/**
 * Job host API v1 — the self-hosted job host agent (`kete-job-host`, kete-code) ↔ the platform
 * (ADR 0023 rules 6–13). Two routes, both `POST`, both signed with HTTP Message Signatures
 * (RFC 9421, `ed25519`) under the profile below; no bearer token is ever used. Request bodies are
 * strict (unknown fields are a 400); response bodies are `z.object` (an agent ignores fields it
 * doesn't know, so the platform may add fields within v1). Crypto operations (digest, signing,
 * HPKE) are in `@kete/shared/job-host-crypto`; shared test vectors are in
 * `docs/contracts/test-vectors/job-host-v1/`. Standalone copy for the kete-code repo:
 * docs/contracts/job-host-v1.md.
 */

// ---------------------------------------------------------------- routes and limits

export const JOB_HOST_ENROLL_PATH = '/api/v1/job-hosts/enroll'
export const JOB_HOST_POLL_PATH = '/api/v1/job-hosts/poll'

/** Largest request bodies the platform reads (larger: 400 `body_too_large`, before any parse). */
export const JOB_HOST_ENROLL_MAX_BYTES = 8_192
export const JOB_HOST_POLL_MAX_BYTES = 1_048_576
/** Largest response body an agent reads. */
export const JOB_HOST_RESPONSE_MAX_BYTES = 1_048_576

/** Slots a host may declare (a dedicated host always declares 1). */
export const JOB_HOST_MAX_SLOTS = 32
/** Machines in one report (held machines plus tombstones). */
export const JOB_HOST_REPORT_MAX_MACHINES = 128
/** Phase lines per machine per report (ADR 0023 rule 19); the rest are dropped and counted. */
export const JOB_HOST_PHASE_LINES_MAX = 200
/**
 * The agent drops a raw console or stdout line longer than this unparsed (counted as dropped).
 * Parsed lines are bounded by `JobHostPhaseLine`, so 200 of them stay under 46 KiB (ADR 0023
 * rule 19's 64 KB per machine per report).
 */
export const JOB_HOST_PHASE_LINE_MAX_BYTES = 512

/** Idle poll interval; `next_poll_after` may shorten or lengthen it (1–60 s). */
export const JOB_HOST_POLL_INTERVAL_SECONDS = 10
/** A report this recent makes a host eligible for placement (ADR 0023 rule 11). */
export const JOB_HOST_REPORT_FRESH_SECONDS = 60
/** Past this, `status`/`list` answer `unavailable` instead of trusting the report. */
export const JOB_HOST_REPORT_STALE_SECONDS = 90
/** Enrollment tokens are single-use and valid this long after the admin creates them. */
export const JOB_HOST_ENROLLMENT_TOKEN_TTL_SECONDS = 3_600
/** The agent's deadline killer: a machine past its deadline plus this is destroyed. */
export const JOB_HOST_DEADLINE_GRACE_SECONDS = 300
/** The agent's deadline killer: any machine older than this is destroyed (130 + 5 minutes). */
export const JOB_HOST_MACHINE_MAX_AGE_SECONDS = 8_100

// ---------------------------------------------------------------- ids and encodings

/** Host, machine and job ids: lowercase UUIDs (canonical, so the HPKE `info` is unambiguous). */
export const JobHostUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

/**
 * A 32-byte key or encapsulated key: unpadded base64url (RFC 4648 §5) in canonical form (43
 * characters, the last one's two unused bits zero).
 */
export const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)

/** The single-use enrollment token the admin page shows once: `kete_jhe_` + 32 random bytes, base64url. */
export const JobHostEnrollmentToken = z.string().regex(/^kete_jhe_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)

/**
 * The host key fingerprint: lowercase hex SHA-256 of the raw Ed25519 public key (32 bytes)
 * followed by the raw X25519 public key (32 bytes). The agent prints it at `enroll`, the admin
 * page shows it, and the admin approves only when they match. Displayed in groups of 4.
 */
export const JobHostFingerprint = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * A host's identity generation: set by the agent at enrollment (a dedicated host's verified reset
 * generation; on a firecracker host any fresh value) and fixed for the life of its keys. Same rule
 * as kete-code `hostprofile.ValidGeneration`.
 */
export const JobHostGeneration = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)

/** A version string: agent, Firecracker, guest kernel, host kernel. */
export const JobHostVersion = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/)

/** A job image by digest: `<registry>[:port]/<repository>@sha256:<64 hex>` (ADR 0023 rule 17). */
export const JobImageRef = z
  .string()
  .max(300)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/[a-z0-9]+(?:(?:[._]|__|-+|\/)[a-z0-9]+)*@sha256:[0-9a-f]{64}$/)

const Timestamp = z.iso.datetime({ offset: true })

// ---------------------------------------------------------------- enums

export const JobHostArch = z.enum(['amd64', 'arm64'])
export type JobHostArch = z.infer<typeof JobHostArch>

/** ADR 0023 rules 7–8. */
export const JobHostDriver = z.enum(['firecracker', 'dedicated'])
export type JobHostDriver = z.infer<typeof JobHostDriver>

/** ADR 0023 rule 8: a dedicated host must declare a verified reset; a firecracker host declares `none`. */
export const JobHostReset = z.enum(['none', 'provider_rebuild', 'measured_boot'])
export type JobHostReset = z.infer<typeof JobHostReset>

/** ADR 0023 rule 10. Only `active` and `draining` hosts are served a desired state. */
export const JobHostStatus = z.enum(['pending', 'active', 'draining', 'disabled', 'revoked'])
export type JobHostStatus = z.infer<typeof JobHostStatus>

/**
 * A machine's observed state. `preparing`: assignment accepted (image fetch, verification, disks).
 * `failed` and `destroyed` are terminal: nothing of the machine remains on the host.
 */
export const JobHostMachineState = z.enum(['preparing', 'starting', 'running', 'stopping', 'destroyed', 'failed'])
export type JobHostMachineState = z.infer<typeof JobHostMachineState>

/** Why a machine is `failed` (never ran) or `destroyed`. Required with those states, absent otherwise. */
export const JobHostMachineReason = z.enum([
  // failed: refused or failed before the guest ran
  'image_not_allowed',
  'image_signature_invalid',
  'image_unavailable',
  'platform_mismatch',
  'config_undecryptable',
  'config_invalid',
  'generation_mismatch',
  'no_free_slot',
  'deadline_passed',
  'starts_blocked',
  'driver_failed',
  // destroyed
  'exited',
  'desired',
  'deadline',
  'max_age',
  'host_disabled',
  'crashed',
])
export type JobHostMachineReason = z.infer<typeof JobHostMachineReason>

export const JOB_HOST_FAILED_REASONS = [
  'image_not_allowed',
  'image_signature_invalid',
  'image_unavailable',
  'platform_mismatch',
  'config_undecryptable',
  'config_invalid',
  'generation_mismatch',
  'no_free_slot',
  'deadline_passed',
  'starts_blocked',
  'driver_failed',
] as const satisfies readonly JobHostMachineReason[]

/** Why the agent has stopped starting machines (reported until it clears). */
export const JobHostStartsBlocked = z.enum(['host_table', 'disk_space', 'driver_unhealthy', 'operator'])
export type JobHostStartsBlocked = z.infer<typeof JobHostStartsBlocked>

// ---------------------------------------------------------------- signature profile (RFC 9421)

export const JOB_HOST_SIGNATURE_LABEL = 'kete'
export const JOB_HOST_SIGNATURE_ALG = 'ed25519'
export const JOB_HOST_SIGNATURE_TAG = 'kete-job-host-v1'
/** Covered components, in this order, always all of them. */
export const JOB_HOST_COVERED_COMPONENTS = ['@method', '@authority', '@path', 'content-type', 'content-digest'] as const
/** Requests carry exactly this content type (no parameters). */
export const JOB_HOST_CONTENT_TYPE = 'application/json'
/** `created` may be at most this far from the verifier's clock, either way; `expires - created` at most this. */
export const JOB_HOST_SIGNATURE_WINDOW_SECONDS = 60

/**
 * The signature parameters. `keyid`: the host id (poll) or, at enrollment, the fingerprint of the
 * keys in the body. `nonce`: 16 random bytes, lowercase hex, never reused; the platform refuses a
 * (`keyid`, `nonce`) pair it has seen within the window.
 */
export const JobHostSignatureParams = z
  .strictObject({
    created: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expires: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    keyid: z.union([JobHostUuid, JobHostFingerprint]),
  })
  .refine((p) => p.expires > p.created && p.expires - p.created <= JOB_HOST_SIGNATURE_WINDOW_SECONDS, {
    path: ['expires'],
    message: '`expires` must be 1–60 s after `created`.',
  })
export type JobHostSignatureParams = z.infer<typeof JobHostSignatureParams>

/** The `@signature-params` value (also the `Signature-Input` member's value). */
export function jobHostSignatureParamsValue(p: JobHostSignatureParams): string {
  const components = JOB_HOST_COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ')
  return (
    `(${components});created=${p.created};expires=${p.expires};nonce="${p.nonce}";keyid="${p.keyid}"` +
    `;alg="${JOB_HOST_SIGNATURE_ALG}";tag="${JOB_HOST_SIGNATURE_TAG}"`
  )
}

/** The `Signature-Input` header value. */
export function jobHostSignatureInput(p: JobHostSignatureParams): string {
  return `${JOB_HOST_SIGNATURE_LABEL}=${jobHostSignatureParamsValue(p)}`
}

const SIGNATURE_INPUT =
  /^kete=\("@method" "@authority" "@path" "content-type" "content-digest"\);created=([1-9][0-9]{0,15});expires=([1-9][0-9]{0,15});nonce="([0-9a-f]{32})";keyid="([0-9a-f-]{36}|[0-9a-f]{64})";alg="ed25519";tag="kete-job-host-v1"$/

/**
 * Parses a `Signature-Input` header under this profile: exactly the label, components, parameter
 * order and values above, or null (400 `signature_malformed`). The profile is fixed, so a verifier
 * never needs a general RFC 8941 parser.
 */
export function parseJobHostSignatureInput(header: string): JobHostSignatureParams | null {
  const m = SIGNATURE_INPUT.exec(header)
  if (!m) return null
  const parsed = JobHostSignatureParams.safeParse({ created: Number(m[1]), expires: Number(m[2]), nonce: m[3], keyid: m[4] })
  return parsed.success ? parsed.data : null
}

/** The `Signature` header value for a 64-byte Ed25519 signature in standard base64. */
export function jobHostSignatureHeader(signatureBase64: string): string {
  return `${JOB_HOST_SIGNATURE_LABEL}=:${signatureBase64}:`
}

/** The signature (standard base64, 88 characters) from a `Signature` header, or null. */
export function parseJobHostSignature(header: string): string | null {
  return /^kete=:([A-Za-z0-9+/]{86}==):$/.exec(header)?.[1] ?? null
}

/** The SHA-256 (standard base64) from a `Content-Digest` header (RFC 9530): exactly one `sha-256` member. */
export function parseContentDigest(header: string): string | null {
  return /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(header)?.[1] ?? null
}

export interface JobHostSignedComponents {
  /** Always `POST`. */
  method: string
  /** The platform's public host as the verifier has it configured (never the received `Host`), lowercase, no port. */
  authority: string
  /** `JOB_HOST_ENROLL_PATH` or `JOB_HOST_POLL_PATH`; no query. */
  path: string
  /** `JOB_HOST_CONTENT_TYPE`. */
  contentType: string
  /** The `Content-Digest` header value, `sha-256=:…:`. */
  contentDigest: string
}

/** The RFC 9421 signature base: one line per component, `\n`-separated, no trailing newline. */
export function jobHostSignatureBase(c: JobHostSignedComponents, p: JobHostSignatureParams): string {
  return [
    `"@method": ${c.method}`,
    `"@authority": ${c.authority}`,
    `"@path": ${c.path}`,
    `"content-type": ${c.contentType}`,
    `"content-digest": ${c.contentDigest}`,
    `"@signature-params": ${jobHostSignatureParamsValue(p)}`,
  ].join('\n')
}

// ---------------------------------------------------------------- enrollment

export const JobHostVersions = z.strictObject({
  agent: JobHostVersion,
  /** Firecracker driver only. */
  firecracker: JobHostVersion.optional(),
  /** Firecracker driver only: the guest kernel the agent runs (ADR 0023 rule 21). */
  guest_kernel: JobHostVersion.optional(),
  /** The host's own kernel (`uname -r`), shown to admins. */
  host_kernel: JobHostVersion,
})
export type JobHostVersions = z.infer<typeof JobHostVersions>

/** What the agent declares about itself (ADR 0023 rule 9), checked against the driver's rules. */
export const JobHostFacts = z
  .strictObject({
    arch: JobHostArch,
    driver: JobHostDriver,
    slots: z.number().int().min(1).max(JOB_HOST_MAX_SLOTS),
    /** `/dev/kvm` is present and usable. */
    kvm: z.boolean(),
    reset: JobHostReset,
    generation: JobHostGeneration,
    versions: JobHostVersions,
  })
  .superRefine((f, ctx) => {
    const fc = f.driver === 'firecracker'
    if (fc && !f.kvm) ctx.addIssue({ code: 'custom', path: ['kvm'], message: 'The firecracker driver needs KVM.' })
    if (fc && f.reset !== 'none') ctx.addIssue({ code: 'custom', path: ['reset'], message: 'A firecracker host declares reset `none`.' })
    if (!fc && f.reset === 'none') ctx.addIssue({ code: 'custom', path: ['reset'], message: 'A dedicated host needs a verified reset.' })
    if (!fc && f.slots !== 1) ctx.addIssue({ code: 'custom', path: ['slots'], message: 'A dedicated host has exactly 1 slot.' })
    if (fc !== (f.versions.firecracker !== undefined) || fc !== (f.versions.guest_kernel !== undefined))
      ctx.addIssue({ code: 'custom', path: ['versions'], message: '`firecracker` and `guest_kernel` exactly for the firecracker driver.' })
  })
export type JobHostFacts = z.infer<typeof JobHostFacts>

/**
 * POST /api/v1/job-hosts/enroll body, signed with the new Ed25519 key (`keyid` = the fingerprint
 * of the two keys below). The token is single-use: any second use, valid or not, is refused.
 */
export const JobHostEnrollRequest = z.strictObject({
  enrollment_token: JobHostEnrollmentToken,
  /** Ed25519 public key, raw 32 bytes, base64url. Signs every later request. */
  signing_key: Base64Url32,
  /** X25519 public key, raw 32 bytes, base64url. Configurations are sealed to it. */
  sealing_key: Base64Url32,
  facts: JobHostFacts,
})
export type JobHostEnrollRequest = z.infer<typeof JobHostEnrollRequest>

/** POST …/enroll → 201. `active` only for an R1 re-enrollment the platform started (ADR 0023 rule 8). */
export const JobHostEnrollResponse = z.object({
  host_id: JobHostUuid,
  status: z.enum(['pending', 'active']),
  fingerprint: JobHostFingerprint,
  /** Seconds until the first poll. */
  next_poll_after: z.number().int().min(1).max(60),
})
export type JobHostEnrollResponse = z.infer<typeof JobHostEnrollResponse>

// ---------------------------------------------------------------- report (poll request)

/**
 * One phase line as the entrypoint or kete-job-init writes it (kete-code `phaselog`): fixed step,
 * event and code names, never free text. The agent forwards only lines that parse as this.
 */
export const JobHostPhaseLine = z.strictObject({
  ts: Timestamp,
  step: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  event: z.enum(['start', 'ok', 'failed', 'note', 'exit']),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(),
  class: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(),
  errno: z.number().int().min(0).max(4095).optional(),
  exit_code: z.number().int().min(0).max(255).optional(),
})
export type JobHostPhaseLine = z.infer<typeof JobHostPhaseLine>

/** A machine the agent holds, or a tombstone it keeps reporting while the desired state names it. */
export const JobHostObservedMachine = z
  .strictObject({
    machine_id: JobHostUuid,
    /** The assignment's job id; null only for a machine the agent can't attribute. */
    job_id: JobHostUuid.nullable(),
    state: JobHostMachineState,
    /** When the machine entered `state`. */
    since: Timestamp,
    reason: JobHostMachineReason.optional(),
    /** New lines since the last report that the platform answered (oldest first). */
    phase_lines: z.array(JobHostPhaseLine).max(JOB_HOST_PHASE_LINES_MAX),
    /** Lines dropped since the last answered report: not phase lines, or over the caps. */
    phase_lines_dropped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((m, ctx) => {
    const terminal = m.state === 'failed' || m.state === 'destroyed'
    if (terminal !== (m.reason !== undefined))
      ctx.addIssue({ code: 'custom', path: ['reason'], message: '`reason` exactly with `failed` or `destroyed`.' })
    if (m.reason !== undefined && terminal && (m.state === 'failed') !== (JOB_HOST_FAILED_REASONS as readonly string[]).includes(m.reason))
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reason does not fit the state.' })
  })
export type JobHostObservedMachine = z.infer<typeof JobHostObservedMachine>

/** POST /api/v1/job-hosts/poll body: the agent's report (ADR 0023 rule 9). Idempotent. */
export const JobHostReport = z
  .strictObject({
    /** Must equal the enrolled generation (else 403 `generation_mismatch`). */
    generation: JobHostGeneration,
    versions: JobHostVersions,
    slots: z.strictObject({
      total: z.number().int().min(1).max(JOB_HOST_MAX_SLOTS),
      free: z.number().int().min(0).max(JOB_HOST_MAX_SLOTS),
    }),
    /** Null while the agent starts machines; else why it doesn't (ADR 0023 rule 7: host table). */
    starts_blocked: JobHostStartsBlocked.nullable(),
    /** The `desired.revision` of the last poll response the agent applied; null before the first. */
    applied_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    machines: z.array(JobHostObservedMachine).max(JOB_HOST_REPORT_MAX_MACHINES),
  })
  .superRefine((r, ctx) => {
    if (r.slots.free > r.slots.total) ctx.addIssue({ code: 'custom', path: ['slots', 'free'], message: '`free` exceeds `total`.' })
    if (new Set(r.machines.map((m) => m.machine_id)).size !== r.machines.length)
      ctx.addIssue({ code: 'custom', path: ['machines'], message: 'Duplicate machine id.' })
  })
export type JobHostReport = z.infer<typeof JobHostReport>

// ---------------------------------------------------------------- sealed configuration (RFC 9180)

/** HPKE suite: base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. */
export const JOB_HOST_HPKE_KEM_ID = 0x0020
export const JOB_HOST_HPKE_KDF_ID = 0x0001
export const JOB_HOST_HPKE_AEAD_ID = 0x0001
/** The first line of the HPKE `info`. The AEAD's additional data is empty. */
export const JOB_HOST_HPKE_INFO_LABEL = 'kete-job-host-v1 sealed-config'

/** What a sealed configuration is bound to: a different host, machine, job or generation fails to open. */
export interface JobHostConfigBinding {
  hostId: string
  machineId: string
  jobId: string
  generation: string
}

/** The binding's ids are lowercase UUIDs and its generation a `JobHostGeneration` (so no value can carry a newline). */
export function isValidJobHostConfigBinding(b: JobHostConfigBinding): boolean {
  return (
    JobHostUuid.safeParse(b.hostId).success &&
    JobHostUuid.safeParse(b.machineId).success &&
    JobHostUuid.safeParse(b.jobId).success &&
    JobHostGeneration.safeParse(b.generation).success
  )
}

/** The HPKE `info` (UTF-8): the label and the four bindings, one per line, no trailing newline. Throws on an invalid binding. */
export function jobHostConfigInfo(b: JobHostConfigBinding): string {
  if (!isValidJobHostConfigBinding(b)) throw new Error('invalid job host config binding')
  return [JOB_HOST_HPKE_INFO_LABEL, `host_id=${b.hostId}`, `machine_id=${b.machineId}`, `job_id=${b.jobId}`, `generation=${b.generation}`].join('\n')
}

/** The machine configuration's largest JSON encoding (kete-code `bootenv.MaxConfig`). */
export const JOB_MACHINE_CONFIG_MAX_BYTES = 4_096

/** The sealed envelope: `ciphertext` is the AEAD output (plaintext + 16-byte tag), base64url. */
export const JobHostSealedConfig = z.object({
  kem_id: z.literal(JOB_HOST_HPKE_KEM_ID),
  kdf_id: z.literal(JOB_HOST_HPKE_KDF_ID),
  aead_id: z.literal(JOB_HOST_HPKE_AEAD_ID),
  /** The encapsulated key (the ephemeral X25519 public key), base64url. */
  enc: Base64Url32,
  ciphertext: z
    .string()
    .min(22)
    .max(Math.ceil(((JOB_MACHINE_CONFIG_MAX_BYTES + 16) * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/),
})
export type JobHostSealedConfig = z.infer<typeof JobHostSealedConfig>

// ---------------------------------------------------------------- machine configuration

/** cloudvm providers (kete-code `hostprofile.Providers`). */
export const JobHostProvider = z.enum(['gcp', 'digitalocean', 'hetzner', 'oci'])
export type JobHostProvider = z.infer<typeof JobHostProvider>

/** A plain DNS host as the entrypoint accepts it (`bootenv.ValidHost`). */
const DNS_HOST = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DnsHost = z.string().max(253).regex(new RegExp(`^${DNS_HOST}$`))

/**
 * The machine configuration: kete-code's config pipe payload (`bootenv.Config`), the JSON after
 * the config disk's header and the cloudvm user data — exactly these fields, in this order, one
 * compact JSON object (the field limits keep it far below `JOB_MACHINE_CONFIG_MAX_BYTES`). `platform_url` is the normalized origin
 * (`https://host`); `host_provider` exactly for `cloudvm`, `host_generation` exactly for
 * `dedicated`, both absent (not null) otherwise. Never on a kernel command line, in a log or report.
 */
export const JobMachineConfig = z
  .strictObject({
    job_id: JobHostUuid,
    platform_url: z.string().max(261).regex(new RegExp(`^https://${DNS_HOST}$`)),
    /** The job's single-use claim token (jobs-v1 `JobClaimRequest.claim_token`). */
    claim_token: z.string().regex(/^[0-9a-f]{64}$/),
    storage_host: DnsHost,
    host_profile: z.enum(['microvm', 'dedicated', 'cloudvm']),
    host_provider: JobHostProvider.optional(),
    host_generation: JobHostGeneration.optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.host_profile === 'cloudvm') !== (c.host_provider !== undefined))
      ctx.addIssue({ code: 'custom', path: ['host_provider'], message: '`host_provider` exactly for cloudvm.' })
    if ((c.host_profile === 'dedicated') !== (c.host_generation !== undefined))
      ctx.addIssue({ code: 'custom', path: ['host_generation'], message: '`host_generation` exactly for dedicated.' })
  })
export type JobMachineConfig = z.infer<typeof JobMachineConfig>

/**
 * The firecracker config disk (ADR 0023 rule 13): this header, the configuration's JSON (profile
 * `microvm`), then NUL bytes up to exactly `JOB_CONFIG_DISK_BYTES`. Owned by the VM's jail uid,
 * `0600`, attached read-only, unlinked once the VM has started.
 */
export const JOB_CONFIG_DISK_HEADER = 'kete-job-config v1\n'
export const JOB_CONFIG_DISK_BYTES = 8_192

// ---------------------------------------------------------------- desired state (poll response)

export const JobHostRunMachine = z.object({
  machine_id: JobHostUuid,
  job_id: JobHostUuid,
  /** Must be in the agent's local allowlist and carry a valid release signature (ADR 0023 rule 17). */
  image: JobImageRef,
  /** The job's hard deadline; the agent destroys the machine at deadline + 5 min regardless. */
  deadline: Timestamp,
  resources: z.object({
    vcpus: z.number().int().min(1).max(16),
    memory_mib: z.number().int().min(512).max(65_536),
    /** The per-job scratch disk (firecracker), GiB. */
    scratch_gib: z.number().int().min(1).max(200),
  }),
  /**
   * Sealed to the host's X25519 key with this machine's binding. Present until the host reports the
   * machine `running` or terminal; the platform then deletes it and omits it.
   */
  config: JobHostSealedConfig.optional(),
})
export type JobHostRunMachine = z.infer<typeof JobHostRunMachine>

export const JobHostDesiredState = z.object({
  /** Increases whenever the platform changes this host's desired state. */
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Every machine that should exist and run; any other machine the agent holds is destroyed. */
  run: z.array(JobHostRunMachine).max(JOB_HOST_MAX_SLOTS),
  /** Machines the platform wants gone and hasn't yet seen reported `destroyed` or `failed`. */
  destroy: z.array(JobHostUuid).max(JOB_HOST_REPORT_MAX_MACHINES),
})
export type JobHostDesiredState = z.infer<typeof JobHostDesiredState>

/** POST …/poll → 200 (`Cache-Control: no-store`). */
export const JobHostPollResponse = z.object({
  /** The request's signature `nonce`: the agent discards a response that doesn't echo its own. */
  in_reply_to: z.string().regex(/^[0-9a-f]{32}$/),
  host_id: JobHostUuid,
  status: z.enum(['active', 'draining']),
  /** Seconds until the next poll. */
  next_poll_after: z.number().int().min(1).max(60),
  desired: JobHostDesiredState,
})
export type JobHostPollResponse = z.infer<typeof JobHostPollResponse>

// ---------------------------------------------------------------- errors

/** `error.reason` of every non-2xx job host response (the agent acts on it; `code` is the usual ErrorCode). */
export const JobHostErrorReason = z.enum([
  // 400 invalid_request
  'malformed_request',
  'body_too_large',
  'digest_mismatch',
  'signature_malformed',
  // 401 invalid_key
  'signature_invalid',
  'clock_skew',
  'nonce_replayed',
  'enrollment_token_invalid',
  // 403 forbidden
  'host_pending',
  'host_disabled',
  'host_revoked',
  'generation_mismatch',
  // 409 conflict
  'key_in_use',
  // 429 rate_limited, 503 unavailable, 500 internal
  'rate_limited',
  'unavailable',
  'internal',
])
export type JobHostErrorReason = z.infer<typeof JobHostErrorReason>

export const JobHostErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    request_id: z.string(),
    reason: JobHostErrorReason,
  }),
})
export type JobHostErrorResponse = z.infer<typeof JobHostErrorResponse>
```

## Examples

`POST /api/v1/job-hosts/enroll` request (`JobHostEnrollRequest`; the vector's body):

```json
{
  "enrollment_token": "kete_jhe_6VYcQvAovMFvzajh-0vmcx7RWhVSTIIG3X0p3qtdzHk",
  "signing_key": "aqvKk_cQiwy0qZqDflMnLRaTOhufBkHzqORXp6BveqU",
  "sealing_key": "9sT08dK32cQC5495pwlgLlwyRS1Im9elh8UkfgJxpnE",
  "facts": {
    "arch": "amd64",
    "driver": "firecracker",
    "slots": 4,
    "kvm": true,
    "reset": "none",
    "generation": "g-2026-10-03.1",
    "versions": { "agent": "0.9.0", "firecracker": "1.13.1", "guest_kernel": "6.1.141-kete.1", "host_kernel": "6.8.0-45-generic" }
  }
}
```

`201` response (`JobHostEnrollResponse`):

```json
{
  "host_id": "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f",
  "status": "pending",
  "fingerprint": "03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a",
  "next_poll_after": 30
}
```

`POST /api/v1/job-hosts/poll` request (`JobHostReport`): two machines running, one that ended, one
refused assignment:

```json
{
  "generation": "g-2026-10-03.1",
  "versions": { "agent": "0.9.0", "firecracker": "1.13.1", "guest_kernel": "6.1.141-kete.1", "host_kernel": "6.8.0-45-generic" },
  "slots": { "total": 4, "free": 2 },
  "starts_blocked": null,
  "applied_revision": 7,
  "machines": [
    {
      "machine_id": "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b",
      "job_id": "2b3c4d5e-6f70-4a81-9b2c-3d4e5f6a7b8c",
      "state": "running",
      "since": "2026-10-03T01:40:12Z",
      "phase_lines": [],
      "phase_lines_dropped": 0
    },
    {
      "machine_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "job_id": "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f",
      "state": "running",
      "since": "2026-10-03T01:59:31Z",
      "phase_lines": [
        { "ts": "2026-10-03T01:59:38.004Z", "step": "isolation", "event": "ok" },
        { "ts": "2026-10-03T01:59:40.125Z", "step": "claim", "event": "ok" }
      ],
      "phase_lines_dropped": 0
    },
    {
      "machine_id": "c4d5e6f7-0a1b-4c2d-8e3f-405162738495",
      "job_id": "e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7",
      "state": "destroyed",
      "since": "2026-10-03T01:58:02Z",
      "reason": "exited",
      "phase_lines": [{ "ts": "2026-10-03T01:58:01.500Z", "step": "job", "event": "exit", "exit_code": 0 }],
      "phase_lines_dropped": 0
    },
    {
      "machine_id": "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
      "job_id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      "state": "failed",
      "since": "2026-10-03T01:59:55Z",
      "reason": "image_not_allowed",
      "phase_lines": [],
      "phase_lines_dropped": 0
    }
  ]
}
```

`200` response (`JobHostPollResponse`): one running machine kept, a new one to start (with its
sealed configuration), the other running machine to destroy (its job was cancelled; it is also
absent from `run`), and the ended and refused machines acknowledged by their absence from both
lists:

```json
{
  "in_reply_to": "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  "host_id": "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f",
  "status": "active",
  "next_poll_after": 10,
  "desired": {
    "revision": 8,
    "run": [
      {
        "machine_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "job_id": "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f",
        "image": "ghcr.io/kete-org/kete-job@sha256:4f9c2b7a1e8d3c6f5a0b9e2d7c4f1a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f",
        "deadline": "2026-10-03T02:31:00Z",
        "resources": { "vcpus": 4, "memory_mib": 4096, "scratch_gib": 20 }
      },
      {
        "machine_id": "3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b",
        "job_id": "9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61",
        "image": "ghcr.io/kete-org/kete-job@sha256:4f9c2b7a1e8d3c6f5a0b9e2d7c4f1a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f",
        "deadline": "2026-10-03T02:45:00Z",
        "resources": { "vcpus": 4, "memory_mib": 4096, "scratch_gib": 20 },
        "config": {
          "kem_id": 32,
          "kdf_id": 1,
          "aead_id": 1,
          "enc": "fOTSDeSmiAMF_4GMF3idK0HPMqRDtCEDHBuaeyMbDxI",
          "ciphertext": "0v8vF98HxZlvt91SiBTd6wOwYDaKWmFNrAsMeRoDnJD8fisLgNX1ZUQg7QFJ8iFebi1O_u6yVPMVljzziRLuakVKKK_HtA9-FH_kezGyadiRu1RjLQMXk0IpMjQiBsZBaIUbTmN67-gVzE00I0842h16kHhKyacjchK6myJayn6WnXy4wN1wfruM2S5kkaydnjDS7dZN9u-tvwDIjeDpLa0iK0ZR6ExZ7c2nk1YrvaJRfXSoaNfr9nskBla_3zRaMNKdjI4_-1uEgs2K-GcdDlkYQ6rCeFd5AhNO3j1qzUT6n9CwAYlQCd_Tox8CJrwKestp4IWhi5AbJHMl0Hs"
        }
      }
    ],
    "destroy": ["f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b"]
  }
}
```

The new machine's `config` is the `microvm` case of `hpke.json` (host `7d0f3c2e-…`, generation
`g-2026-10-03.1`), so the vector's recipient key opens it.

Machine configuration, `microvm` (`JobMachineConfig`; the config disk's JSON):

```json
{"job_id":"9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61","platform_url":"https://portal.kete.example","claim_token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","storage_host":"storage.kete.example","host_profile":"microvm"}
```

`dedicated` (the agent's config pipe):

```json
{"job_id":"9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61","platform_url":"https://portal.kete.example","claim_token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","storage_host":"storage.kete.example","host_profile":"dedicated","host_generation":"g-2026-10-03.1"}
```

`cloudvm` (a cloud VM's user data, unsealed):

```json
{"job_id":"9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61","platform_url":"https://portal.kete.example","claim_token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","storage_host":"storage.kete.example","host_profile":"cloudvm","host_provider":"gcp"}
```

`401` (`JobHostErrorResponse`):

```json
{ "error": { "code": "invalid_key", "message": "The signature is outside the 60-second window.", "request_id": "req_3k9d2f7a", "reason": "clock_skew" } }
```

`403` while the host awaits approval:

```json
{ "error": { "code": "forbidden", "message": "This host is waiting for approval.", "request_id": "req_8b1c4e0d", "reason": "host_pending" } }
```
