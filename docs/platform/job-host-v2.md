<!-- Copied from kete-code-platform docs/contracts/job-host-v2.md at commit e5e32ee (kete-org/ketecode-portal#73, 2026-10-07). The platform copy is the source of truth; update both together, and re-copy the test vectors into packages/kete-job-host/testdata/job-host-v2/ with them. -->

# Job host API contract — v2

Standalone copy of the job host contract v2 for the `kete-code` repository (`kete-job-host` with the
`kubernetes` driver — the enterprise runner — and any other host enrolled under v2). The source of
truth is `packages/shared/src/api/v1/job-hosts-v2.ts` in `kete-code-platform`; the schema block below
is kept identical to it, and a test there fails if they differ. Crypto: `packages/shared/src/job-host-crypto.ts`
(`signJobHostV2Request`, `verifyJobHostV2Request`, `verifyJobHostV2Enrollment`,
`sealJobHostConfigV2`, `openJobHostConfigV2`). Design: platform ADR 0025 rule 7; kete-code ADR 0011;
kete-code `docs/tasks/2026-10-07-enterprise-runtime/spec.md` §3–§5, §9 and Appendix A (piece P0b).

**v2 builds on [job-host-v1](job-host-v1.md): every v1 rule applies unless this document changes
it** — the two routes, request strictness, the RFC 9421 profile and its verification order, key
hygiene, replay protection, HPKE suite and envelope, acknowledgements, phase lines, the deadline
killer, error handling. Kete's own fleet stays on v1; v1 is unchanged and stays served.

Status: **contract defined, not served.** The platform serves v2 from piece P4a/P4b, behind
`KETE_FLAG_ENTERPRISE_RUNTIME`; until then a v2-signed request is `400 signature_malformed` (the v1
verifier's answer to an unknown tag). v2 may still gain fields before it is first served — the
cross-runner orchestration work (O1, O11) is expected to add a desired-state `cleanup` list, its
report outcomes and a boundary key for titles; the schemas leave room for that (responses are
lenient, the boundary is one object).

**Test vectors** (both repos check them; kete-code copies them byte for byte):

| File | Holds |
|---|---|
| `docs/contracts/test-vectors/job-host-v2/signatures.json` | job-host-v1's keys; a v2-signed `enroll` (kubernetes facts) and `poll` (the report below); 8 refusals with the reason a v2 verifier must give (including the same request signed under the v1 profile); what a v1 verifier answers (`signature_malformed`) |
| `docs/contracts/test-vectors/job-host-v2/hpke.json` | a `kubevm` configuration sealed under the v2 label with a fixed ephemeral key (the poll response's `config` below); 5 refusals, including opening it under the v1 label |
| `docs/contracts/test-vectors/job-host-v2/messages.json` | 90 schema cases (value, schema, accepted or refused) covering drivers and profiles, `kubernetes` run machines without a repository, slots up to 128, `publishing`, the publish outcome and its boundary rules, served repositories, the effective boundary, image allowlists, new reasons and `version` |
| `docs/contracts/test-vectors/jobs-v1/claim-runtime-repo.json`, `result-boundary.json` | the jobs-v1 side (claim without `clone`, `finish { outbox: true }`, the bounded result) |
| `docs/contracts/test-vectors/egress-config-v2/configs.json` | egress config v2 ([egress-config-v2.md](egress-config-v2.md)), runtime-side |

Builders: `packages/shared/src/job-host-v2-test-vectors.ts` (secrets are SHA-256 of public labels).

## What v2 changes

| Area | v1 | v2 |
|---|---|---|
| Signature `tag` | `kete-job-host-v1` | `kete-job-host-v2` (else v1's profile exactly) |
| Bodies | no version | `"version": 2` in the enroll request, the report and both responses |
| Drivers | `firecracker`, `dedicated` | + `kubernetes` (one VM-isolated pod per machine) |
| Slots | 1–32 | `kubernetes` 1–128; `firecracker` 1–32; `dedicated` 1 |
| Facts | — | `versions.kubernetes`, `runtime_classes` (exactly for `kubernetes`) |
| Machines per report / `destroy` | ≤ 128 | ≤ 256 (every slot plus as many tombstones) |
| Poll body / response read | 1 MiB / 1 MiB | 4 MiB / 2 MiB |
| Report | — | `images`, `repositories`, `boundary`, `runtime_classes`; `machines[].publish` |
| Machine states | — | + `publishing` |
| Failure reasons | — | + `pod_unschedulable`, `image_pull_failed`, `repository_unknown`, `repository_unavailable` |
| `starts_blocked` | — | + `cluster_unhealthy`, `runtime_class_missing` |
| Run machine | — | `repository { name, base_ref }`, `publish { branch, open_mr, authorized }` |
| Machine configuration | `microvm`, `dedicated`, `cloudvm` | + `kubevm` |
| HPKE `info` label | `kete-job-host-v1 sealed-config` | `kete-job-host-v2 sealed-config` |
| Error reasons | — | + `contract_mismatch` |

## Version negotiation and signatures

- **The tag is the version.** A v2 agent signs every request with v1's profile but
  `tag="kete-job-host-v2"`, and puts `"version": 2` in every body. The platform reads the contract
  from the `Signature-Input` header before anything else (`jobHostContractOf`): a v1 tag selects the
  v1 verifier and schemas, a v2 tag the v2 ones, anything else is `400 signature_malformed`. The tag
  is covered by the signature, so it can't be changed in transit. A v2 tag with a body that isn't a
  v2 body (no `version`, v1 facts) is `400 malformed_request`; a v1 body has no `version` and v1
  bodies are strict, so a v2 body under a v1 tag is `400 malformed_request` too.
- **A host's contract is fixed at enrollment.** The platform records the contract a host enrolled
  under. A v2-signed request from a v1-enrolled host is `403 contract_mismatch`; a v1-signed request
  from a v2-enrolled host is `403 generation_mismatch` (v1 agents know no other reason; both mean
  "re-enroll"). Kete's fleet enrolls under v1, org-owned hosts (ADR 0025) under v2; which tokens may
  enroll under which contract is the platform's rule (P4a), not the wire's.
- **Responses** carry `"version": 2`; a v2 agent discards a response without it (exactly as it
  discards one whose `in_reply_to` isn't its nonce). Against a platform that doesn't serve v2 the
  agent gets `400 signature_malformed` on its first request and tells the operator; it never falls
  back to v1.
- The enrollment token, its single use, fingerprint approval, keys, nonces and windows are v1's.

The signed v2 `poll` request of `signatures.json`, its headers:

```text
Content-Type: application/json
Content-Digest: sha-256=:sRozfaHPlz+/Z26yTwfoBoJoCn/ROCZea3Gj3rGRJ7Q=:
Signature-Input: kete=("@method" "@authority" "@path" "content-type" "content-digest");created=1791363600;expires=1791363660;nonce="0f1e2d3c4b5a69788796a5b4c3d2e1f0";keyid="c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c";alg="ed25519";tag="kete-job-host-v2"
Signature: kete=:g5/Z2JH51CaWDzaL1TvSlsmm7IODMIrdeGh9fI+NI+rG16UOReBMrzQsB9/326IKIOTwY/uQEOkpThcHU2VaDg==:
```

and its signature base:

```text
"@method": POST
"@authority": portal.kete.example
"@path": /api/v1/job-hosts/poll
"content-type": application/json
"content-digest": sha-256=:sRozfaHPlz+/Z26yTwfoBoJoCn/ROCZea3Gj3rGRJ7Q=:
"@signature-params": ("@method" "@authority" "@path" "content-type" "content-digest");created=1791363600;expires=1791363660;nonce="0f1e2d3c4b5a69788796a5b4c3d2e1f0";keyid="c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c";alg="ed25519";tag="kete-job-host-v2"
```

## Enrollment

`JobHostV2EnrollRequest` = v1's request + `version`, with `JobHostV2Facts`:

| Driver | `slots` | `kvm` | `reset` | `versions` | `runtime_classes` |
|---|---|---|---|---|---|
| `firecracker` | 1–32 | `true` | `none` | `firecracker`, `guest_kernel` | absent |
| `dedicated` | 1 | any | `provider_rebuild` or `measured_boot` | neither | absent |
| `kubernetes` | 1–128 | `false` | `none` | `kubernetes` (the API server's `gitVersion`) | 1–8 VM-isolated RuntimeClass names (Kubernetes object names, no duplicates) |

`host_kernel` is the kernel the agent runs on (for `kubernetes`, the controller pod's node). For
`kubernetes`, `generation` is any fresh value fixed for the life of the keys (the keys live in a
Secret; rotation is re-enrollment, as v1). `JobHostV2EnrollResponse` = v1's + `version`.

## Poll

**Report (`JobHostV2Report`)** = v1's report with v2 limits, plus:

- `version`: `2`.
- `runtime_classes` (kubernetes hosts): the RuntimeClasses it currently allows — re-reported because
  a Helm upgrade may change them without re-enrollment. The platform checks it against the enrolled
  driver.
- `images` (1–16, by digest, no duplicates): the job images the host accepts — its allowlist. The
  platform names one of them in each run machine instead of one global image, so runners mid-upgrade
  keep working. An image outside the list fails `image_not_allowed` as in v1.
- `repositories`: the runtime repository names (`JobRuntimeRepoName`, e.g. `gitlab:payments/api`)
  the host serves, **names only** — or `null` when the host doesn't advertise (then the platform
  accepts any name at job creation and the machine fails `repository_unknown` if it's wrong).
- `boundary` (`JobDataBoundary`): the host's **effective** data boundary — `summary`
  (`none` | `redacted` | `full`), `denials` (`count` | `actions` | `full`), `publish_refs`
  (`omit` | `send`). The runner's configuration decides it; the platform shows it and may only
  narrow it further for its own storage, never widen it (spec §3, ADR 0025 rule 5). The report is
  refused if a machine's `publish` breaks it (below).
- `machines[]`: v2 states and reasons, and `publish`.

Machine states: v1's, plus **`publishing`** between `stopping` and `destroyed` for a machine whose
run carries `publish`: the job's pod has ended and the host waits for `publish.authorized`, then
validates the bundle as hostile, pushes, opens the merge request and ships the audit log to the
enterprise sink. New reasons:

| Reason | With | Meaning |
|---|---|---|
| `pod_unschedulable` | failed | the job pod couldn't be scheduled (resources, taints, RuntimeClass nodes) before its start timeout |
| `image_pull_failed` | failed | the cluster couldn't pull the job image (registry mirror, credentials) |
| `repository_unknown` | failed | `repository.name` isn't in the host's registry; nothing was started |
| `repository_unavailable` | failed | the repository host couldn't be reached, `base_ref` couldn't be resolved or a clone credential couldn't be minted |

`starts_blocked` adds `cluster_unhealthy` (the API server or nodes are unhealthy) and
`runtime_class_missing` (a configured RuntimeClass doesn't exist).

**Publish outcome (`machines[].publish`, `JobHostPublishOutcome`).** Present only on a machine
`destroyed` with reason `exited` whose run carried `publish`, and repeated on that tombstone while
the desired state names the machine (v1's acknowledgement rule: the platform records it, then drops
the machine from `run` and `destroy`). Fixed codes only — no free text, no diff, no file names.

| `status` (= `JobPushStatus`) | `reason` |
|---|---|
| `created` | none, or `mr_failed` (branch pushed, merge request not opened) |
| `no_changes` | none |
| `refused` | `symlink`, `unreadable` (the entrypoint built no bundle), `bundle_invalid` (the validator refused it), `base_unprotected`, `branch_exists`, `push_rejected` (a server-side rule or hook) |
| `failed` | `processes_alive`, `proxy_failed` (the entrypoint built no bundle), `provider_unavailable`, `provider_error`, `protection_unknown`, `hold_expired` (no authorization within the hold time; the outbox was deleted), `publisher_failed` |

`base_sha`, `commit_sha` and `mr { iid, url }` are **boundary-gated**: absent when the report's
`boundary.publish_refs` is `omit`; with `send`, `created` carries `branch`, `base_sha` and
`commit_sha` (and `mr` unless `mr_failed` or no merge request was asked for). `branch` is job
metadata the platform assigned (`publish.branch`, spec §3) and may be sent under either setting.
`commit_sha` and `mr` only with `created`. The `mr.url` is `https`, may name an internal host and
port, and its path is RFC 3986 `pchar`s only (no query, fragment or userinfo).

**Desired state (`JobHostV2PollResponse.desired`)** = v1's with v2 limits; each run machine may add:

- `repository { name, base_ref }`: a runtime repository's job. The host looks the name up in its
  registry, resolves and checks `base_ref` with its own credential, and only then creates the pod;
  an unknown name fails the machine `repository_unknown` before anything starts. **Required on a
  `kubernetes` host** (`JobHostV2KubernetesRunMachine`): a run machine without it — a GitHub or
  Harness job, or anything else a compromised platform places there — fails `config_invalid` and
  no pod is created. The host passes the resolved name to the job pod, whose `kubevm` entrypoint
  refuses a claim response that doesn't name exactly it (jobs-v1 "Runtime repositories").
- `publish { branch, open_mr, authorized }`: present when the job asked for a push (needs
  `repository`). **`authorized` is the platform's go-ahead:** it turns `true` once the platform has
  accepted the job's `finish` (`JobRuntimeFinishRequest`) and the job can no longer be cancelled
  (from then `cancel` answers `409`). The host publishes only for a machine that is in `run` with
  `authorized: true` in a fresh desired state; a machine dropped from `run` before that is destroyed
  with its outbox and never published (spec §4.5, Q5: no publishing without the platform's
  acknowledgement). Without `publish` the host never pushes. A machine waiting in `publishing`
  longer than the runner's hold time (Helm `publish.holdHours`, default 24 h) reports
  `failed`/`hold_expired`.

**Platform side (P4b).** The platform maps `publish.status` to `push_status` (the four values are
`JobPushStatus` values) and moves the job terminal; `finalizing` timeouts apply as today. It
refuses a report whose `boundary` or `publish` break the schema (`400 malformed_request`), and
checks against its own records that `images` contains the image it names, that `publish` appears
only for machines whose run had it, and that `runtime_classes` match the driver.

## Sealed configuration and machine configuration

v1's sealing (suite, envelope, empty AAD, binding values, open-failure rule) with the `info` label
`kete-job-host-v2 sealed-config`, so a v1 seal never opens as v2 and the reverse:

  ```text
  kete-job-host-v2 sealed-config
  host_id=c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c
  machine_id=2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e
  job_id=5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b
  generation=k8s-2026-10-07.1
  ```

The plaintext is `JobMachineConfigV2`: v1's fields in v1's order with `host_profile` `kubevm` added
(no `host_provider`, no `host_generation`). The platform seals `microvm` for `firecracker`,
`dedicated` for `dedicated` and `kubevm` for `kubernetes` hosts. A `kubevm` configuration is only
what the platform knows; the runner adds a **local section** (repository URL and clone credential,
model endpoints and keys, egress additions, boundary, outbox path) from its own configuration in
kete-code's in-repo machine configuration v2 — it never comes from, or goes to, the platform.
`storage_host` stays required for the shape's sake; a `kubevm` entrypoint never contacts it,
never puts it in an egress allowlist and never calls `uploads` — outputs go only to the runner's
outbox. It also refuses a configuration whose profile isn't `kubevm` on a `kubernetes` host
(`config_invalid`).

## Errors

v1's table, plus:

| Status | `code` | `reason` | Agent action |
|---|---|---|---|
| 403 | `forbidden` | `contract_mismatch` | the host is enrolled under v1: stop, tell the operator, re-enroll under v2 |

## Limits

| Constant | v2 value |
|---|---|
| Poll request body | 4 MiB (enroll 8 KiB as v1); the agent defers phase lines to the next poll rather than exceed it |
| Response read by the agent | 2 MiB |
| Slots | `kubernetes` 1–128, `firecracker` 1–32, `dedicated` 1 |
| Machines per report, `destroy` entries | ≤ 256; `run` ≤ 128 |
| Images / repositories / RuntimeClasses reported | ≤ 16 / ≤ 256 / ≤ 8 |

Everything else (signature window, nonces, poll interval, freshness, enrollment token, deadline
killer, configuration size) is v1's.

## Data boundary

Nothing in v2 carries source code, diffs, bundles, file contents, command output, prompts,
credentials, model keys or Kubernetes credentials. The report carries names (repositories,
RuntimeClasses, the platform-assigned job branch), digests, SHAs, fixed codes and counts; the
fields with enterprise content — the base and commit SHAs and the merge request URL — are gated by
`boundary.publish_refs`. On the jobs-v1 side the `kubevm` entrypoint fails closed (it accepts only a
runtime claim for its locally resolved repository and never uploads), so a compromised platform
can't pull source or outputs out of the enterprise. The result summary and denials travel on jobs-v1's `result` callback,
bounded by the same `boundary` (`boundJobRunResult`; jobs-v1 "Runtime repositories").

## Schemas (Zod)

```ts
import { z } from 'zod'
import { ErrorCode } from './errors'
import {
  Base64Url32,
  type JobHostConfigBinding,
  JOB_HOST_COVERED_COMPONENTS,
  JOB_HOST_FAILED_REASONS,
  JOB_HOST_MAX_SLOTS,
  JOB_HOST_PHASE_LINES_MAX,
  JOB_HOST_SIGNATURE_ALG,
  JOB_HOST_SIGNATURE_LABEL,
  JobHostArch,
  JobHostEnrollmentToken,
  JobHostFingerprint,
  JobHostGeneration,
  JobHostPhaseLine,
  JobHostProvider,
  JobHostReset,
  JobHostSealedConfig,
  JobHostSignatureParams,
  type JobHostSignedComponents,
  JobHostUuid,
  JobHostVersion,
  JobImageRef,
  isValidJobHostConfigBinding,
  parseJobHostSignatureInput,
} from './job-hosts'
import { GitSha, JobBranch, JobDataBoundary, JobGitRef, JobRuntimeRepoName } from './jobs'

/**
 * Job host API v2 — the enterprise runner (`kete-job-host` with the `kubernetes` driver, kete-code
 * ADR 0011) and any other host enrolled under v2 ↔ the platform (platform ADR 0025 rule 7). Same two
 * routes, signature profile, sealing and acknowledgements as v1 (`./job-hosts`, whose rules all
 * apply unless this module says otherwise); the differences are the signature `tag`
 * (`kete-job-host-v2`), `version: 2` in every body, the HPKE `info` label, the `kubernetes` driver and
 * `kubevm` profile, slots up to 128, the run machine's `repository` and `publish`, and the report's
 * `publish`, `repositories`, `boundary` and `images`. Kete's own fleet stays on v1. Crypto is in
 * `@kete/shared/job-host-crypto` (`…V2` functions); test vectors in
 * `docs/contracts/test-vectors/job-host-v2/`. Standalone copy for the kete-code repo:
 * docs/contracts/job-host-v2.md.
 */

// ---------------------------------------------------------------- version, limits

/** The `version` of every v2 request and response body. */
export const JOB_HOST_V2_VERSION = 2

/** Largest poll body the platform reads under v2 (enroll stays 8 KiB). */
export const JOB_HOST_V2_POLL_MAX_BYTES = 4_194_304
/** Largest response body a v2 agent reads. */
export const JOB_HOST_V2_RESPONSE_MAX_BYTES = 2_097_152

/** Slots a v2 host may declare: `kubernetes` up to this, `firecracker` up to 32, `dedicated` exactly 1. */
export const JOB_HOST_V2_MAX_SLOTS = 128
/** Machines in one report: every slot plus as many tombstones. */
export const JOB_HOST_V2_REPORT_MAX_MACHINES = 256
/** Job image digests in a host's allowlist (reported so the platform names one the host accepts). */
export const JOB_HOST_V2_MAX_IMAGES = 16
/** Repository names a host advertises. */
export const JOB_HOST_V2_MAX_REPOSITORIES = 256
/** VM-isolated RuntimeClasses a `kubernetes` host allows. */
export const JOB_HOST_V2_MAX_RUNTIME_CLASSES = 8

// ---------------------------------------------------------------- enums

/** v1's drivers plus `kubernetes` (one VM-isolated pod per machine). */
export const JobHostV2Driver = z.enum(['firecracker', 'dedicated', 'kubernetes'])
export type JobHostV2Driver = z.infer<typeof JobHostV2Driver>

/** The machine configuration profile each driver's machines get. */
export const JOB_HOST_V2_DRIVER_PROFILE = { firecracker: 'microvm', dedicated: 'dedicated', kubernetes: 'kubevm' } as const

/**
 * v1's states plus `publishing`: the job's guest or pod has ended and the host is waiting for the
 * platform's authorization to publish, or publishing (validating the bundle, pushing, opening the
 * merge request). Only for a machine whose run carries `publish`.
 */
export const JobHostV2MachineState = z.enum(['preparing', 'starting', 'running', 'stopping', 'publishing', 'destroyed', 'failed'])
export type JobHostV2MachineState = z.infer<typeof JobHostV2MachineState>

/** v1's reasons plus, for `failed`, the cluster and repository ones; the `destroyed` reasons are v1's. */
export const JobHostV2MachineReason = z.enum([
  // failed: refused or failed before the guest or pod ran
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
  'pod_unschedulable',
  'image_pull_failed',
  'repository_unknown',
  'repository_unavailable',
  // destroyed
  'exited',
  'desired',
  'deadline',
  'max_age',
  'host_disabled',
  'host_isolation_lost',
  'crashed',
])
export type JobHostV2MachineReason = z.infer<typeof JobHostV2MachineReason>

export const JOB_HOST_V2_FAILED_REASONS = [
  ...JOB_HOST_FAILED_REASONS,
  'pod_unschedulable',
  'image_pull_failed',
  'repository_unknown',
  'repository_unavailable',
] as const satisfies readonly JobHostV2MachineReason[]

/** v1's reasons plus `cluster_unhealthy` (API server or nodes) and `runtime_class_missing`. */
export const JobHostV2StartsBlocked = z.enum([
  'host_table',
  'disk_space',
  'driver_unhealthy',
  'operator',
  'generation_spent',
  'cluster_unhealthy',
  'runtime_class_missing',
])
export type JobHostV2StartsBlocked = z.infer<typeof JobHostV2StartsBlocked>

/** The publish outcome; each is also a `JobPushStatus`, which the platform records. */
export const JobHostPublishStatus = z.enum(['created', 'no_changes', 'refused', 'failed'])
export type JobHostPublishStatus = z.infer<typeof JobHostPublishStatus>

/**
 * Why a publish was refused or failed (or, with `created`, why no merge request was opened). Fixed
 * codes, never free text. The entrypoint's own no-bundle reasons are `JobPushError`'s, with the
 * statuses the platform gives them on the GitHub path.
 */
export const JOB_HOST_PUBLISH_REASONS = {
  created: ['mr_failed'],
  no_changes: [],
  refused: ['symlink', 'unreadable', 'bundle_invalid', 'base_unprotected', 'branch_exists', 'push_rejected'],
  failed: ['processes_alive', 'proxy_failed', 'provider_unavailable', 'provider_error', 'protection_unknown', 'hold_expired', 'publisher_failed'],
} as const satisfies Record<JobHostPublishStatus, readonly string[]>
export const JobHostPublishReason = z.enum([...JOB_HOST_PUBLISH_REASONS.created, ...JOB_HOST_PUBLISH_REASONS.refused, ...JOB_HOST_PUBLISH_REASONS.failed])
export type JobHostPublishReason = z.infer<typeof JobHostPublishReason>

// ---------------------------------------------------------------- signature profile (v1's, other tag)

export const JOB_HOST_V2_SIGNATURE_TAG = 'kete-job-host-v2'

/** The `@signature-params` value: v1's, with `tag="kete-job-host-v2"`. */
export function jobHostV2SignatureParamsValue(p: JobHostSignatureParams): string {
  const components = JOB_HOST_COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ')
  return (
    `(${components});created=${p.created};expires=${p.expires};nonce="${p.nonce}";keyid="${p.keyid}"` +
    `;alg="${JOB_HOST_SIGNATURE_ALG}";tag="${JOB_HOST_V2_SIGNATURE_TAG}"`
  )
}

/** The `Signature-Input` header value. */
export function jobHostV2SignatureInput(p: JobHostSignatureParams): string {
  return `${JOB_HOST_SIGNATURE_LABEL}=${jobHostV2SignatureParamsValue(p)}`
}

const V2_SIGNATURE_INPUT =
  /^kete=\("@method" "@authority" "@path" "content-type" "content-digest"\);created=([1-9][0-9]{0,15});expires=([1-9][0-9]{0,15});nonce="([0-9a-f]{32})";keyid="([0-9a-f-]{36}|[0-9a-f]{64})";alg="ed25519";tag="kete-job-host-v2"$/

/** Parses a v2 `Signature-Input` header (exactly the profile, tag `kete-job-host-v2`), or null. */
export function parseJobHostV2SignatureInput(header: string): JobHostSignatureParams | null {
  const m = V2_SIGNATURE_INPUT.exec(header)
  if (!m) return null
  const parsed = JobHostSignatureParams.safeParse({ created: Number(m[1]), expires: Number(m[2]), nonce: m[3], keyid: m[4] })
  return parsed.success ? parsed.data : null
}

/** The contract a `Signature-Input` header names (its `tag`), or null when it fits neither profile. */
export function jobHostContractOf(header: string): 1 | 2 | null {
  if (parseJobHostV2SignatureInput(header) !== null) return 2
  return parseJobHostSignatureInput(header) !== null ? 1 : null
}

/** The RFC 9421 signature base under the v2 profile. */
export function jobHostV2SignatureBase(c: JobHostSignedComponents, p: JobHostSignatureParams): string {
  return [
    `"@method": ${c.method}`,
    `"@authority": ${c.authority}`,
    `"@path": ${c.path}`,
    `"content-type": ${c.contentType}`,
    `"content-digest": ${c.contentDigest}`,
    `"@signature-params": ${jobHostV2SignatureParamsValue(p)}`,
  ].join('\n')
}

// ---------------------------------------------------------------- enrollment

/** A Kubernetes object name (DNS-1123 subdomain), as a RuntimeClass name. */
export const KubernetesName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/)

export const JobHostV2Versions = z.strictObject({
  agent: JobHostVersion,
  /** Firecracker driver only. */
  firecracker: JobHostVersion.optional(),
  /** Firecracker driver only. */
  guest_kernel: JobHostVersion.optional(),
  /** Kubernetes driver only: the API server's version (`gitVersion`). */
  kubernetes: JobHostVersion.optional(),
  /** The kernel the agent runs on (`uname -r`; for `kubernetes`, the controller's node). */
  host_kernel: JobHostVersion,
})
export type JobHostV2Versions = z.infer<typeof JobHostV2Versions>

const RuntimeClasses = z.array(KubernetesName).min(1).max(JOB_HOST_V2_MAX_RUNTIME_CLASSES)

/**
 * What a v2 agent declares. v1's driver rules for `firecracker` and `dedicated`; `kubernetes`:
 * 1–128 slots, `kvm: false` and `reset: "none"` (isolation comes from the VM-isolated RuntimeClass,
 * not the controller's node), `runtime_classes` and `versions.kubernetes` present.
 */
export const JobHostV2Facts = z
  .strictObject({
    arch: JobHostArch,
    driver: JobHostV2Driver,
    slots: z.number().int().min(1).max(JOB_HOST_V2_MAX_SLOTS),
    kvm: z.boolean(),
    reset: JobHostReset,
    generation: JobHostGeneration,
    versions: JobHostV2Versions,
    /** Kubernetes driver only: the VM-isolated RuntimeClasses job pods may use (Helm `jobs.runtimeClassNames`). */
    runtime_classes: RuntimeClasses.optional(),
  })
  .superRefine((f, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
    const fc = f.driver === 'firecracker'
    const k8s = f.driver === 'kubernetes'
    if (fc && !f.kvm) issue('kvm', 'The firecracker driver needs KVM.')
    if (fc && f.slots > JOB_HOST_MAX_SLOTS) issue('slots', 'A firecracker host has at most 32 slots.')
    if (f.driver === 'dedicated' && f.reset === 'none') issue('reset', 'A dedicated host needs a verified reset.')
    if (f.driver === 'dedicated' && f.slots !== 1) issue('slots', 'A dedicated host has exactly 1 slot.')
    if (f.driver !== 'dedicated' && f.reset !== 'none') issue('reset', 'Only a dedicated host declares a reset.')
    if (k8s && f.kvm) issue('kvm', 'A kubernetes host declares `kvm: false`.')
    if (fc !== (f.versions.firecracker !== undefined) || fc !== (f.versions.guest_kernel !== undefined))
      issue('versions', '`firecracker` and `guest_kernel` exactly for the firecracker driver.')
    if (k8s !== (f.versions.kubernetes !== undefined)) issue('versions', '`kubernetes` exactly for the kubernetes driver.')
    if (k8s !== (f.runtime_classes !== undefined)) issue('runtime_classes', '`runtime_classes` exactly for the kubernetes driver.')
    if (f.runtime_classes && new Set(f.runtime_classes).size !== f.runtime_classes.length) issue('runtime_classes', 'Duplicate RuntimeClass.')
  })
export type JobHostV2Facts = z.infer<typeof JobHostV2Facts>

/** POST /api/v1/job-hosts/enroll body under v2 (signed with tag `kete-job-host-v2`). */
export const JobHostV2EnrollRequest = z.strictObject({
  version: z.literal(JOB_HOST_V2_VERSION),
  enrollment_token: JobHostEnrollmentToken,
  signing_key: Base64Url32,
  sealing_key: Base64Url32,
  facts: JobHostV2Facts,
})
export type JobHostV2EnrollRequest = z.infer<typeof JobHostV2EnrollRequest>

/** POST …/enroll → 201 under v2. */
export const JobHostV2EnrollResponse = z.object({
  version: z.literal(JOB_HOST_V2_VERSION),
  host_id: JobHostUuid,
  status: z.enum(['pending', 'active']),
  fingerprint: JobHostFingerprint,
  next_poll_after: z.number().int().min(1).max(60),
})
export type JobHostV2EnrollResponse = z.infer<typeof JobHostV2EnrollResponse>

// ---------------------------------------------------------------- report (poll request)

/**
 * A merge or pull request URL as the provider returns it: `https`, a lowercase host, an optional
 * port, an absolute path of RFC 3986 `pchar`s and `/` (unreserved, percent-encoded, sub-delims,
 * `:`, `@`); no userinfo, query or fragment.
 */
export const JobHostChangeRequestUrl = z
  .string()
  .max(500)
  .regex(/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9][0-9]{0,4})?\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$/)

/**
 * A machine's publish outcome (spec §4.4 item 3), reported once on its `destroyed` (`exited`)
 * tombstone and repeated while the desired state names the machine. `reason`: required for
 * `refused` and `failed`, only `mr_failed` with `created`, never with `no_changes`. `branch` is job
 * metadata the platform assigned (`publish.branch`) and may always be sent. `base_sha`,
 * `commit_sha` and `mr` are present only when the report's `boundary.publish_refs` is `send`, and
 * then `created` carries `branch`, `base_sha` and `commit_sha`; `commit_sha` and `mr` only with
 * `created`.
 */
export const JobHostPublishOutcome = z
  .strictObject({
    status: JobHostPublishStatus,
    reason: JobHostPublishReason.optional(),
    branch: JobBranch.optional(),
    base_sha: GitSha.optional(),
    commit_sha: GitSha.optional(),
    mr: z.strictObject({ iid: z.number().int().positive().max(2_147_483_647), url: JobHostChangeRequestUrl }).optional(),
  })
  .superRefine((p, ctx) => {
    const allowed: readonly string[] = JOB_HOST_PUBLISH_REASONS[p.status]
    const needsReason = p.status === 'refused' || p.status === 'failed'
    if (needsReason && p.reason === undefined) ctx.addIssue({ code: 'custom', path: ['reason'], message: '`reason` is required.' })
    if (p.reason !== undefined && !allowed.includes(p.reason)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reason does not fit the status.' })
    if (p.status !== 'created' && (p.commit_sha !== undefined || p.mr !== undefined))
      ctx.addIssue({ code: 'custom', path: ['commit_sha'], message: '`commit_sha` and `mr` only with `created`.' })
    if (p.mr !== undefined && p.reason === 'mr_failed') ctx.addIssue({ code: 'custom', path: ['mr'], message: '`mr` contradicts `mr_failed`.' })
  })
export type JobHostPublishOutcome = z.infer<typeof JobHostPublishOutcome>

/** v1's observed machine with v2 states and reasons, and `publish`. */
export const JobHostV2ObservedMachine = z
  .strictObject({
    machine_id: JobHostUuid,
    job_id: JobHostUuid.nullable(),
    state: JobHostV2MachineState,
    since: z.iso.datetime({ offset: true }),
    reason: JobHostV2MachineReason.optional(),
    phase_lines: z.array(JobHostPhaseLine).max(JOB_HOST_PHASE_LINES_MAX),
    phase_lines_dropped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Only on a `destroyed` machine with reason `exited` whose run carried `publish`. */
    publish: JobHostPublishOutcome.optional(),
  })
  .superRefine((m, ctx) => {
    const terminal = m.state === 'failed' || m.state === 'destroyed'
    if (terminal !== (m.reason !== undefined))
      ctx.addIssue({ code: 'custom', path: ['reason'], message: '`reason` exactly with `failed` or `destroyed`.' })
    if (m.reason !== undefined && terminal && (m.state === 'failed') !== (JOB_HOST_V2_FAILED_REASONS as readonly string[]).includes(m.reason))
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reason does not fit the state.' })
    if (m.publish !== undefined && !(m.state === 'destroyed' && m.reason === 'exited'))
      ctx.addIssue({ code: 'custom', path: ['publish'], message: '`publish` only on a machine destroyed with reason `exited`.' })
  })
export type JobHostV2ObservedMachine = z.infer<typeof JobHostV2ObservedMachine>

const unique = (xs: readonly string[]) => new Set(xs).size === xs.length

/**
 * POST /api/v1/job-hosts/poll body under v2. v1's report plus `version`, `runtime_classes`
 * (kubernetes hosts; re-reported because a Helm upgrade may change them without re-enrollment),
 * `images` (the job image digests the host accepts), `repositories` (the runtime repository names
 * it serves; null when it doesn't advertise) and `boundary` (its effective data boundary, which
 * every machine's `publish` must respect).
 */
export const JobHostV2Report = z
  .strictObject({
    version: z.literal(JOB_HOST_V2_VERSION),
    generation: JobHostGeneration,
    versions: JobHostV2Versions,
    slots: z.strictObject({
      total: z.number().int().min(1).max(JOB_HOST_V2_MAX_SLOTS),
      free: z.number().int().min(0).max(JOB_HOST_V2_MAX_SLOTS),
    }),
    starts_blocked: JobHostV2StartsBlocked.nullable(),
    applied_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    runtime_classes: RuntimeClasses.optional(),
    images: z.array(JobImageRef).min(1).max(JOB_HOST_V2_MAX_IMAGES),
    repositories: z.array(JobRuntimeRepoName).max(JOB_HOST_V2_MAX_REPOSITORIES).nullable(),
    boundary: JobDataBoundary,
    machines: z.array(JobHostV2ObservedMachine).max(JOB_HOST_V2_REPORT_MAX_MACHINES),
  })
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })
    if (r.slots.free > r.slots.total) issue(['slots', 'free'], '`free` exceeds `total`.')
    if (!unique(r.machines.map((m) => m.machine_id))) issue(['machines'], 'Duplicate machine id.')
    if (!unique(r.images)) issue(['images'], 'Duplicate image.')
    if (r.repositories && !unique(r.repositories)) issue(['repositories'], 'Duplicate repository.')
    if (r.runtime_classes && !unique(r.runtime_classes)) issue(['runtime_classes'], 'Duplicate RuntimeClass.')
    r.machines.forEach((m, i) => {
      const p = m.publish
      if (p === undefined) return
      const refs = p.base_sha !== undefined || p.commit_sha !== undefined || p.mr !== undefined
      if (r.boundary.publish_refs === 'omit' && refs) issue(['machines', i, 'publish'], 'The boundary omits publish references.')
      if (r.boundary.publish_refs === 'send' && p.status === 'created' && (p.branch === undefined || p.base_sha === undefined || p.commit_sha === undefined))
        issue(['machines', i, 'publish'], '`created` carries `branch`, `base_sha` and `commit_sha` when the boundary sends references.')
    })
  })
export type JobHostV2Report = z.infer<typeof JobHostV2Report>

// ---------------------------------------------------------------- sealed configuration

/** The first line of the v2 HPKE `info` (otherwise v1's sealing, suite and envelope). */
export const JOB_HOST_V2_HPKE_INFO_LABEL = 'kete-job-host-v2 sealed-config'

/** The v2 HPKE `info`: v1's layout under the v2 label. Throws on an invalid binding. */
export function jobHostV2ConfigInfo(b: JobHostConfigBinding): string {
  if (!isValidJobHostConfigBinding(b)) throw new Error('invalid job host config binding')
  return [JOB_HOST_V2_HPKE_INFO_LABEL, `host_id=${b.hostId}`, `machine_id=${b.machineId}`, `job_id=${b.jobId}`, `generation=${b.generation}`].join('\n')
}

// ---------------------------------------------------------------- machine configuration

const DNS_HOST = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?'

/**
 * v1's machine configuration (kete-code `bootenv.Config`) with profile `kubevm` added: the same
 * fields in the same order, `host_provider` exactly for `cloudvm`, `host_generation` exactly for
 * `dedicated`. A `kubevm` configuration is what the platform seals; the runner's local section
 * (repository, clone credential, models, egress additions, boundary, outbox) is never in it.
 */
export const JobMachineConfigV2 = z
  .strictObject({
    job_id: JobHostUuid,
    platform_url: z.string().max(261).regex(new RegExp(`^https://${DNS_HOST}$`)),
    claim_token: z.string().regex(/^[0-9a-f]{64}$/),
    storage_host: z.string().max(253).regex(new RegExp(`^${DNS_HOST}$`)),
    host_profile: z.enum(['microvm', 'dedicated', 'cloudvm', 'kubevm']),
    host_provider: JobHostProvider.optional(),
    host_generation: JobHostGeneration.optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.host_profile === 'cloudvm') !== (c.host_provider !== undefined))
      ctx.addIssue({ code: 'custom', path: ['host_provider'], message: '`host_provider` exactly for cloudvm.' })
    if ((c.host_profile === 'dedicated') !== (c.host_generation !== undefined))
      ctx.addIssue({ code: 'custom', path: ['host_generation'], message: '`host_generation` exactly for dedicated.' })
  })
export type JobMachineConfigV2 = z.infer<typeof JobMachineConfigV2>

// ---------------------------------------------------------------- desired state (poll response)

export const JobHostV2RunMachine = z
  .object({
    machine_id: JobHostUuid,
    job_id: JobHostUuid,
    /** One of the host's reported `images`. */
    image: JobImageRef,
    deadline: z.iso.datetime({ offset: true }),
    resources: z.object({
      vcpus: z.number().int().min(1).max(16),
      memory_mib: z.number().int().min(512).max(65_536),
      scratch_gib: z.number().int().min(1).max(200),
    }),
    /**
     * A runtime repository's job: the name to look up in the host's registry (unknown: the machine
     * fails `repository_unknown` before any pod starts) and the base ref to resolve and check.
     * Required on a `kubernetes` host (`JobHostV2KubernetesRunMachine`): such a host runs only
     * runtime repositories' jobs and fails any other run machine `config_invalid`.
     */
    repository: z.object({ name: JobRuntimeRepoName, base_ref: JobGitRef }).optional(),
    /**
     * Present when the job asked for a push. `authorized` turns true once the platform accepted the
     * job's `finish` and the job can no longer be cancelled; the host publishes only then, and never
     * for a machine the desired state no longer runs.
     */
    publish: z.object({ branch: JobBranch, open_mr: z.boolean(), authorized: z.boolean() }).optional(),
    config: JobHostSealedConfig.optional(),
  })
  .refine((m) => m.publish === undefined || m.repository !== undefined, { path: ['publish'], message: '`publish` needs `repository`.' })
export type JobHostV2RunMachine = z.infer<typeof JobHostV2RunMachine>

/**
 * What a `kubernetes` host accepts per run machine (fail closed against a compromised platform):
 * `repository` present. A run machine that fails this is not started; it is reported `failed`
 * with reason `config_invalid`. The host also checks that the opened configuration's profile is
 * `kubevm`.
 */
export const JobHostV2KubernetesRunMachine = JobHostV2RunMachine.refine((m) => m.repository !== undefined, {
  path: ['repository'],
  message: 'A kubernetes host runs only runtime repositories’ jobs.',
})

export const JobHostV2DesiredState = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  run: z.array(JobHostV2RunMachine).max(JOB_HOST_V2_MAX_SLOTS),
  destroy: z.array(JobHostUuid).max(JOB_HOST_V2_REPORT_MAX_MACHINES),
})
export type JobHostV2DesiredState = z.infer<typeof JobHostV2DesiredState>

/** POST …/poll → 200 under v2. The agent discards a response without `version: 2`. */
export const JobHostV2PollResponse = z.object({
  version: z.literal(JOB_HOST_V2_VERSION),
  in_reply_to: z.string().regex(/^[0-9a-f]{32}$/),
  host_id: JobHostUuid,
  status: z.enum(['active', 'draining']),
  next_poll_after: z.number().int().min(1).max(60),
  desired: JobHostV2DesiredState,
})
export type JobHostV2PollResponse = z.infer<typeof JobHostV2PollResponse>

// ---------------------------------------------------------------- errors

/**
 * v1's reasons plus `contract_mismatch` (403 `forbidden`): a v2-signed request from a host enrolled
 * under v1. (A v1-signed request from a v2-enrolled host gets v1's `generation_mismatch`: v1 agents
 * know no other reason, and re-enrollment is the right action either way.)
 */
export const JobHostV2ErrorReason = z.enum([
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
  'contract_mismatch',
  // 409 conflict
  'key_in_use',
  // 429 rate_limited, 503 unavailable, 500 internal
  'rate_limited',
  'unavailable',
  'internal',
])
export type JobHostV2ErrorReason = z.infer<typeof JobHostV2ErrorReason>

export const JobHostV2ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    request_id: z.string(),
    reason: JobHostV2ErrorReason,
  }),
})
export type JobHostV2ErrorResponse = z.infer<typeof JobHostV2ErrorResponse>
```

## Examples

`POST /api/v1/job-hosts/enroll` request (`JobHostV2EnrollRequest`), a kubernetes runner:

```json
{
  "version": 2,
  "enrollment_token": "kete_jhe_WfNp8lP4D462xJo4bB-cYfBS18gGIyyGwHiDSYSm0kg",
  "signing_key": "aqvKk_cQiwy0qZqDflMnLRaTOhufBkHzqORXp6BveqU",
  "sealing_key": "9sT08dK32cQC5495pwlgLlwyRS1Im9elh8UkfgJxpnE",
  "facts": {
    "arch": "amd64",
    "driver": "kubernetes",
    "slots": 16,
    "kvm": false,
    "reset": "none",
    "generation": "k8s-2026-10-07.1",
    "versions": {
      "agent": "0.10.0",
      "kubernetes": "v1.31.4",
      "host_kernel": "6.8.0-1015-azure"
    },
    "runtime_classes": [
      "kata-mshv-vm-isolation"
    ]
  }
}
```

`201` response (`JobHostV2EnrollResponse`):

```json
{
  "version": 2,
  "host_id": "c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c",
  "status": "pending",
  "fingerprint": "03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a",
  "next_poll_after": 30
}
```

`POST /api/v1/job-hosts/poll` request (`JobHostV2Report`): one job running, one waiting to publish,
one published (branch pushed, merge request opened), one refused because its repository isn't in the
runner's registry:

```json
{
  "version": 2,
  "generation": "k8s-2026-10-07.1",
  "versions": {
    "agent": "0.10.0",
    "kubernetes": "v1.31.4",
    "host_kernel": "6.8.0-1015-azure"
  },
  "slots": {
    "total": 16,
    "free": 14
  },
  "starts_blocked": null,
  "applied_revision": 12,
  "runtime_classes": [
    "kata-mshv-vm-isolation"
  ],
  "images": [
    "registry.corp.example/kete/kete-job@sha256:8e1f4a7c2b9d6e3f0a5c8b1d4e7f2a9c6b3d0e5f8a1c4b7d2e9f6a3c0b5d8e1f",
    "registry.corp.example/kete/kete-job@sha256:1c6e9b2f5a8d3c0e7b4a1f8c5d2e9b6a3f0c7d4e1b8a5f2c9e6d3b0a7f4c1e8d"
  ],
  "repositories": [
    "gitlab:payments/api",
    "gitlab:payments/ledger"
  ],
  "boundary": {
    "summary": "none",
    "denials": "actions",
    "publish_refs": "send"
  },
  "machines": [
    {
      "machine_id": "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "job_id": "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d",
      "state": "running",
      "since": "2026-10-07T08:52:10Z",
      "phase_lines": [
        {
          "ts": "2026-10-07T08:52:31.402Z",
          "step": "claim",
          "event": "ok"
        },
        {
          "ts": "2026-10-07T08:52:44.918Z",
          "step": "clone",
          "event": "ok",
          "code": "clone_done"
        }
      ],
      "phase_lines_dropped": 0
    },
    {
      "machine_id": "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      "job_id": "8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f",
      "state": "publishing",
      "since": "2026-10-07T08:58:02Z",
      "phase_lines": [],
      "phase_lines_dropped": 0
    },
    {
      "machine_id": "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
      "job_id": "d3e4f5a6-b7c8-4d9e-8f0a-1b2c3d4e5f6a",
      "state": "destroyed",
      "since": "2026-10-07T08:59:40Z",
      "reason": "exited",
      "phase_lines": [
        {
          "ts": "2026-10-07T08:57:12.003Z",
          "step": "job",
          "event": "exit",
          "exit_code": 0
        }
      ],
      "phase_lines_dropped": 0,
      "publish": {
        "status": "created",
        "branch": "kete/job/7f3a9c21",
        "base_sha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
        "commit_sha": "e83c5163316f89bfbde7d9ab23ca2e25604af290",
        "mr": {
          "iid": 412,
          "url": "https://gitlab.corp.example/payments/api/-/merge_requests/412"
        }
      }
    },
    {
      "machine_id": "e5f6a7b8-c9d0-4e1f-9a2b-3c4d5e6f7a8b",
      "job_id": "f7a8b9c0-d1e2-4f3a-8b4c-5d6e7f8a9b0c",
      "state": "failed",
      "since": "2026-10-07T08:59:55Z",
      "reason": "repository_unknown",
      "phase_lines": [],
      "phase_lines_dropped": 0
    }
  ]
}
```

`200` response (`JobHostV2PollResponse`): the running job kept (it will publish, not yet authorized),
the waiting one authorized to publish, a new kubevm machine with its sealed configuration (the
`hpke.json` case), and the published and refused machines acknowledged by their absence:

```json
{
  "version": 2,
  "in_reply_to": "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  "host_id": "c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c",
  "status": "active",
  "next_poll_after": 10,
  "desired": {
    "revision": 13,
    "run": [
      {
        "machine_id": "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
        "job_id": "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d",
        "image": "registry.corp.example/kete/kete-job@sha256:8e1f4a7c2b9d6e3f0a5c8b1d4e7f2a9c6b3d0e5f8a1c4b7d2e9f6a3c0b5d8e1f",
        "deadline": "2026-10-07T09:22:00Z",
        "resources": {
          "vcpus": 4,
          "memory_mib": 4096,
          "scratch_gib": 20
        },
        "repository": {
          "name": "gitlab:payments/api",
          "base_ref": "main"
        },
        "publish": {
          "branch": "kete/job/1b4d7e2a",
          "open_mr": true,
          "authorized": false
        }
      },
      {
        "machine_id": "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
        "job_id": "8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f",
        "image": "registry.corp.example/kete/kete-job@sha256:1c6e9b2f5a8d3c0e7b4a1f8c5d2e9b6a3f0c7d4e1b8a5f2c9e6d3b0a7f4c1e8d",
        "deadline": "2026-10-07T09:25:00Z",
        "resources": {
          "vcpus": 4,
          "memory_mib": 4096,
          "scratch_gib": 20
        },
        "repository": {
          "name": "gitlab:payments/ledger",
          "base_ref": "release/2026.10"
        },
        "publish": {
          "branch": "kete/job/c0ffee42",
          "open_mr": false,
          "authorized": true
        }
      },
      {
        "machine_id": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
        "job_id": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
        "image": "registry.corp.example/kete/kete-job@sha256:8e1f4a7c2b9d6e3f0a5c8b1d4e7f2a9c6b3d0e5f8a1c4b7d2e9f6a3c0b5d8e1f",
        "deadline": "2026-10-07T09:40:00Z",
        "resources": {
          "vcpus": 4,
          "memory_mib": 4096,
          "scratch_gib": 20
        },
        "repository": {
          "name": "gitlab:payments/api",
          "base_ref": "main"
        },
        "config": {
          "kem_id": 32,
          "kdf_id": 1,
          "aead_id": 1,
          "enc": "RzN5UBdfzNVzTFNQJQMUoHFYK8D6oFmR0Ek8GTKKV20",
          "ciphertext": "dtjEZrnabdZQCExzSSWG65_zEeQoVJPwAxAL6czF6W9iSJypG-g9oBt2J0phfbg8FcM5rWQnRFTHYL5SJYYnlOcHOi_XyDb0yPiAP137HY6mjUJeds9tNKmPf_HdtnPs3fT-gHuC7FlQdRxH1GgPFt9ABbDbHqZuMDJw2BDCFrbmydeKDlFb0IxhMD2V-6TNZBZv9Mq-dfPM0uoE-mHPJ307-YXaW_0FNZnK7MSvRPZVaJaTGe5pMsAhR6XHJdTBacD5QJZo2OWoE1H1N0AfJv8dGHmrDbgpBHwoiHY7qgEbWWpiwBUx0QFBWVmqTGwO6BS3svjNf3G3tgo04w"
        }
      }
    ],
    "destroy": []
  }
}
```

Machine configuration, `kubevm` (`JobMachineConfigV2`; the plaintext of the sealed `config` above):

```json
{"job_id":"5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b","platform_url":"https://portal.kete.example","claim_token":"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210","storage_host":"storage.kete.example","host_profile":"kubevm"}
```

`403` for a v2 request from a v1-enrolled host:

```json
{ "error": { "code": "forbidden", "message": "This host is enrolled under job-host-v1.", "request_id": "req_5c2e9a1b", "reason": "contract_mismatch" } }
```
