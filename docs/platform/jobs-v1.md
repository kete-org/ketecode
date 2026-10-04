<!-- Copied from kete-code-platform docs/contracts/jobs-v1.md at commit a2e3fbf (2026-10-02; unchanged through bc95a41). The platform copy is the source of truth; update both together. -->

# Job API contract — v1

Standalone copy of the cloud-job API contract for the `kete-code` repository (the job
entrypoint and, later, `kete` clients). The source of truth is
`packages/shared/src/api/v1/jobs.ts` in `kete-code-platform`; the schema block below is kept
identical to it, and a test there fails if they differ. Design: `docs/jobs.md` §2; decisions:
ADRs 0018–0021. The runtime's own side (job spec v1, `--json` result v1, exit codes) is
kete-code's `docs/jobs.md`.

Status: **contract defined, routes not served yet.** The user routes land with build task 5,
the container callbacks with build task 7 (`docs/jobs.md` §10).

## Conventions

As every `/api/v1` route (`docs/platform-api.md` §1): JSON, UTF-8, `x-kete-request-id` on
every response, errors as `{ "error": { "code", "message", "request_id" } }`. Money is integer
USD micros as a JSON number. Times are RFC 3339 with an offset.

- **Request bodies are strict**: an unknown field is `400 invalid_request`. The one exception
  is the `result` callback, whose body is the runtime's own result v1: unknown fields are
  ignored there.
- **Responses only gain fields** within v1. Ignore unknown fields; anything breaking ships as
  `/api/v2`.
- The job API adds three error codes to the platform's set: `insufficient_balance` (402),
  `conflict` (409) and `not_permitted` (422).

## User routes

Auth: a portal session, or `Authorization: Bearer <kete key>` of kind `user` or `cli`. A `job`
key is refused (`403 forbidden`, ADR 0020 rule 3).

| Route | Permission | Body | Success |
|---|---|---|---|
| `POST /api/v1/jobs` | `agents.run`; `push`/`open_pr` also `jobs.push` | `CreateJobRequest`; optional header `Idempotency-Key` | `201 JobResponse`; a repeat of the same key by the same requester returns the first job with `200` |
| `GET /api/v1/jobs/{id}` | `agents.read` | — | `200 JobResponse`; `job.prompt` only for the requester or `agents.write` |
| `GET /api/v1/jobs?project_id=&status=&cursor=` | `agents.read` | `ListJobsQuery` as query parameters | `200 JobListResponse`, newest first, 50 per page; no prompts |
| `POST /api/v1/jobs/{id}/cancel` | own job `agents.run`; anyone's `agents.write` | — | `202 JobResponse` |

`POST /api/v1/jobs` errors:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | validation failed |
| 402 | `insufficient_balance` | credit-billed model and balance < `budget_micros` (ADR 0020 rule 12) |
| 403 | `forbidden` | missing `agents.run`, or `jobs.push` for `push`/`open_pr`, or jobs not enabled for the organization, or a job key |
| 404 | `not_found` | project, repository or agent not in the organization; `jobs` flag off |
| 409 | `conflict` | organization or platform concurrency limit; an `Idempotency-Key` already used by another member of the organization |
| 422 | `not_permitted` | an `allow` rule the agent or an organization policy doesn't permit; a repository the GitHub App installation doesn't cover; an unprotected default branch or `base_ref` when `push` is set |

`GET` answers `404 not_found` for another organization's job. `cancel` answers `409 conflict`
for a terminal job or one whose branch creation has begun.

- **Idempotency:** an `Idempotency-Key` (1–100 printable ASCII characters) is unique in its
  organization forever, not for a time window. The same requester repeating it gets the first job
  back (`200`); another member using it gets `409 conflict`.
- **Defaults** (applied when the field is absent): `allow` `[]`, `budget_micros` 2,000,000
  (max 25,000,000), `timeout_minutes` 30 (max 120), `push` and `open_pr` `false`, `base_ref`
  the repository's default branch, `branch_suffix` 8 hex characters (the branch is
  `kete/job/<suffix>`).
- **`Job`:** `status` is the platform's (`queued`, `provisioning`, `running`, `finalizing`,
  `cancelling`, then `succeeded`, `failed`, `cancelled` or `timed_out`). `outcome` is the
  runtime's outcome verbatim, one the entrypoint reports itself, or a platform outcome — a
  string, not an enum. `push_status`: `not_requested`, `pending`, `created`, `no_changes`,
  `refused`, `failed`, `incomplete`. `warnings`: `create_trigger`,
  `pull_request_target_trigger` (the base commit has workflows `[skip ci]` doesn't stop).
  `spent_micros` is the gateway's measured spend. `reported` holds what the **container
  reported** (redacted): show it labelled so.

## Container callbacks

`claim` authenticates with the claim token in its body; every other callback with the callback
token as `Authorization: Bearer`. A wrong token, another job's token, a gateway key, a job in
the wrong state or a time past the deadline all answer the same `404 not_found`: stop, kill
everything and make no more callbacks.

| Route | Accepted in | Body | Success |
|---|---|---|---|
| `POST /api/v1/jobs/{id}/claim` | `provisioning`, before the deadline; once | `JobClaimRequest` | `200 JobClaimResponse`. A second claim is `409 conflict` and fails the job. |
| `POST /api/v1/jobs/{id}/events` | `running`, `finalizing` | `JobEventRequest` | `204`. At least every 60 s; `effective_timeout_minutes` once, with the first `agent` event, 1 ≤ it ≤ `timeout_minutes` (else 400). |
| `POST /api/v1/jobs/{id}/result` | `running`; once | `JobRunResult` | `204`; the job moves to `finalizing`. |
| `POST /api/v1/jobs/{id}/uploads` | `finalizing`; once | `JobUploadsRequest` | `200 JobUploadsResponse`: single-use signed `PUT` URLs, 10 minutes. |
| `POST /api/v1/jobs/{id}/finish` | `finalizing`; once | `JobFinishRequest` | `202`; the platform validates the bundle and creates the branch afterwards. |

- **Claim response:** the only response carrying the job's secrets (gateway key, callback
  token, clone token); never log it. `spec` is a kete job spec v1 with `agent`, `model`
  (`kete/<model_id>`), `policy` (`version` 1, `allow`, `budget` in USD, `timeout` in minutes)
  and `branch` always set, never `prompt_file`. `clone.base_sha` is the commit the clone must
  be at. URLs follow the entrypoint's rules: `https`, a plain lowercase DNS host, port 443 or
  none, no userinfo, query or fragment, no `..`; `platform_url` is an origin (no path). `deadline` is the hard deadline of every later step.
- **Result:** the `kete job run --json` result v1, forwarded verbatim, or one the entrypoint
  writes itself (`error`, `refused`, `deadline`, `proxy_failed`, `time_limit`). The platform
  maps it to a terminal status (ADR 0018 rule 5); an unknown `outcome` is stored as reported
  with status `failed`. `text` is cut to 4 KB and `denied` to 100 entries, both redacted.
  `cost_usd` is informational.
- **Uploads:** signed URLs follow the same URL rules, except that they carry a query (the
  signature), and all name the machine configuration's storage host. `audit` (≤ 20 MB, `application/x-ndjson`), `proxy_log` (≤ 10 MB) and, when
  `bundle: true`, `bundle` (≤ 10 MB, `application/gzip`).
- **Finish:** `push_error` says why there is no bundle (`processes_alive`, `symlink`,
  `unreadable`, `proxy_failed`); omit it when a bundle was uploaded.

## Schemas (Zod)

```ts
import { z } from 'zod'
import { AgentSlug } from './sync'

/**
 * Job API v1 — cloud jobs (ADRs 0018–0021, docs/jobs.md §2).
 *
 * User routes (`POST/GET /api/v1/jobs`, `GET /api/v1/jobs/{id}`, `POST …/{id}/cancel`)
 * authenticate with a portal session or a `user`/`cli` Kete key, never a `job` key.
 * Container callbacks (`POST …/{id}/claim|events|result|uploads|finish`) authenticate with
 * the job's claim token (`claim`) or callback token (the rest, `Authorization: Bearer`).
 * Request bodies the platform defines are strict (unknown fields are a 400); the `result`
 * body is the runtime's own v1 object, whose unknown fields are ignored. Money is integer
 * USD micros. Standalone copy for the kete-code repo: docs/contracts/jobs-v1.md.
 */

// ---------------------------------------------------------------- limits and defaults

/** A prompt is 1 byte to 256 KiB of UTF-8, not empty after trimming. */
export const JOB_PROMPT_MAX_BYTES = 262_144
export const JOB_BUDGET_DEFAULT_MICROS = 2_000_000
export const JOB_BUDGET_MAX_MICROS = 25_000_000
export const JOB_TIMEOUT_DEFAULT_MINUTES = 30
export const JOB_TIMEOUT_MAX_MINUTES = 120
export const JOB_ALLOW_MAX_RULES = 50
export const JOB_LIST_PAGE_SIZE = 50
/** `reported.summary_text`: the result's `text`, redacted and cut at a UTF-8 boundary. */
export const JOB_SUMMARY_MAX_BYTES = 4096
/** The result's `denied` is cut to this many entries before storing. */
export const JOB_DENIED_MAX_STORED = 100
export const JOB_EVENT_MESSAGE_MAX_CHARS = 500

/**
 * `POST /api/v1/jobs` header. A key is unique in its organization forever (`create_job`, N2):
 * a repeat by the same requester returns the first job with 200; the same key from another
 * requester is `409 conflict`.
 */
export const JOB_IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
export const JobIdempotencyKey = z.string().regex(/^[\x21-\x7E]{1,100}$/)

// ---------------------------------------------------------------- enums

/** Mirrors the `job_status` database enum; extend both together (docs/jobs.md §1). */
export const JobStatus = z.enum([
  'queued',
  'provisioning',
  'running',
  'finalizing',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
])
export type JobStatus = z.infer<typeof JobStatus>

export const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const satisfies readonly JobStatus[]

/** Mirrors the `jobs.push_status` check. */
export const JobPushStatus = z.enum(['not_requested', 'pending', 'created', 'no_changes', 'refused', 'failed', 'incomplete'])
export type JobPushStatus = z.infer<typeof JobPushStatus>

/** Platform-computed notices (ADR 0021 rule 8); mirrors the `jobs.warnings` check. */
export const JobWarning = z.enum(['create_trigger', 'pull_request_target_trigger'])
export type JobWarning = z.infer<typeof JobWarning>

/**
 * `Job.outcome`: the runtime's `outcome` verbatim (ADR 0018 rule 5), one the entrypoint
 * reports itself, or a platform outcome. Not an enum: an unknown outcome is stored as
 * reported. These lists name the values known today.
 */
export const JOB_RUN_OUTCOMES = ['completed', 'error', 'refused', 'audit_failed', 'time_limit', 'budget', 'interrupted'] as const
export const JOB_ENTRYPOINT_OUTCOMES = ['deadline', 'proxy_failed'] as const
export const JOB_PLATFORM_OUTCOMES = [
  'host_unavailable',
  'claim_timeout',
  'claim_replayed',
  'lost',
  'deadline',
  'org_disabled',
  'requested',
  'flag_off',
  'requester_removed',
] as const
export const JobOutcome = z.string().min(1).max(40)

// ---------------------------------------------------------------- shared pieces

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

export const JobPrompt = z
  .string()
  .refine((s) => s.trim().length > 0, 'The prompt is empty.')
  .refine((s) => utf8Bytes(s) <= JOB_PROMPT_MAX_BYTES, 'The prompt is larger than 256 KiB.')

/** A git ref the platform accepts: the database's `job_git_ref_valid`, a conservative subset of git-check-ref-format. */
export function isJobGitRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]{1,255}$/.test(ref) && !/(^[-/.]|\/$|\.$|\/\/|\.\.|\/\.|\.lock(\/|$)|@\{)/.test(ref)
}
export const JobGitRef = z.string().refine(isJobGitRef, 'Not a valid branch name.')

export const JOB_BRANCH_PREFIX = 'kete/job/'
/** Always `kete/job/<suffix>`. */
export const JobBranch = z.string().refine((b) => b.startsWith(JOB_BRANCH_PREFIX) && b.length > JOB_BRANCH_PREFIX.length && isJobGitRef(b))
/** The branch is `kete/job/<suffix>`; the suffix must make it a valid ref. Default: 8 hex characters. */
export const JobBranchSuffix = z.string().refine((s) => s.length > 0 && isJobGitRef(`${JOB_BRANCH_PREFIX}${s}`), 'Not a valid branch suffix.')

/** A full commit SHA-1, as the entrypoint checks it. */
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/)

/** A plain DNS host as the entrypoint accepts it (`bootenv.ValidHost`): lowercase labels, a letter-led last label. */
const DNS_HOST = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?'
const hostOk = (url: string) => (url.slice('https://'.length).split(/[:/?]/, 1)[0] ?? '').length <= 253

/**
 * The entrypoint's `NormalizeHTTPSURL`: `https`, a plain DNS host, port 443 or none, no userinfo,
 * query or fragment, no `..` in the path. `HttpsOrigin` also allows no path but `/`.
 */
const HttpsUrl = z
  .string()
  .max(2000)
  .regex(new RegExp(`^https://${DNS_HOST}(?::443)?(?:/[\\x21-\\x22\\x24-\\x3E\\x40-\\x7E]*)?$`))
  .refine((u) => hostOk(u) && !u.includes('..'), 'Not an accepted https URL.')
const HttpsOrigin = z
  .string()
  .max(300)
  .regex(new RegExp(`^https://${DNS_HOST}(?::443)?/?$`))
  .refine(hostOk, 'Not an accepted https origin.')
/** The entrypoint's upload URL rule (`ParseUploads`): as `HttpsUrl`, but a query (the signature) is allowed. */
const HttpsSignedUrl = z
  .string()
  .max(4000)
  .regex(new RegExp(`^https://${DNS_HOST}(?::443)?(?:/[\\x21-\\x22\\x24-\\x3E\\x40-\\x7E]*)?(?:\\?[\\x21-\\x22\\x24-\\x7E]*)?$`))
  .refine(hostOk, 'Not an accepted upload URL.')
const Timestamp = z.iso.datetime({ offset: true })
const Micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** A rule the job may proceed on without asking (compiled per docs/jobs.md §5; anything not permitted is 422). */
export const JobAllowRule = z.strictObject({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
})
export type JobAllowRule = z.infer<typeof JobAllowRule>

// ---------------------------------------------------------------- user routes

/** POST /api/v1/jobs body. Needs `agents.run`; `push` or `open_pr` also need `jobs.push`. */
export const CreateJobRequest = z
  .strictObject({
    project_id: z.guid(),
    /** A GitHub `project_repositories` row of that project (ADR 0021 rules 3, 8). */
    repository_id: z.guid(),
    /** Default: the repository's `default_branch`. */
    base_ref: JobGitRef.optional(),
    /** Slug of an enabled agent of the organization. */
    agent: AgentSlug,
    prompt: JobPrompt,
    allow: z.array(JobAllowRule).max(JOB_ALLOW_MAX_RULES).default([]),
    budget_micros: z.number().int().positive().max(JOB_BUDGET_MAX_MICROS).default(JOB_BUDGET_DEFAULT_MICROS),
    timeout_minutes: z.number().int().min(1).max(JOB_TIMEOUT_MAX_MINUTES).default(JOB_TIMEOUT_DEFAULT_MINUTES),
    branch_suffix: JobBranchSuffix.optional(),
    /** The platform creates the job branch (ADR 0021). */
    push: z.boolean().default(false),
    /** A draft PR; needs `push: true`. */
    open_pr: z.boolean().default(false),
  })
  .refine((r) => !r.open_pr || r.push, { path: ['open_pr'], message: '`open_pr` needs `push`.' })
export type CreateJobRequest = z.infer<typeof CreateJobRequest>

/** A job as members see it. Container-reported values are only under `reported` (ADR 0018 rule 11). */
export const Job = z.object({
  id: z.guid(),
  status: JobStatus,
  outcome: JobOutcome.nullable(),
  exit_code: z.number().int().min(0).max(255).nullable(),
  project_id: z.guid(),
  repository: z.object({ id: z.guid(), full_name: z.string().min(1).max(200), base_ref: JobGitRef }),
  /** The agent and the version compiled into the spec (the gateway's pin). */
  agent: z.object({ id: z.guid(), slug: AgentSlug, version: z.number().int().positive() }),
  branch: JobBranch,
  push: z.boolean(),
  push_status: JobPushStatus,
  pr_url: z.string().regex(/^https:\/\//).max(500).nullable(),
  warnings: z.array(JobWarning),
  budget_micros: Micros.positive(),
  /** The gateway's measured spend (authoritative), not the runtime's `cost_usd`. */
  spent_micros: Micros,
  timeout_minutes: z.number().int().min(1).max(JOB_TIMEOUT_MAX_MINUTES),
  /** The timeout the entrypoint gave `kete` (ADR 0018 rule 9); null until the agent phase starts. */
  effective_timeout_minutes: z.number().int().min(1).max(JOB_TIMEOUT_MAX_MINUTES).nullable(),
  /** The requester. */
  created_by: z.guid(),
  created_at: Timestamp,
  started_at: Timestamp.nullable(),
  ended_at: Timestamp.nullable(),
  /** What the container reported, redacted by the platform; labelled so wherever it's shown. */
  reported: z.object({
    denied_count: z.number().int().nonnegative(),
    summary_text: z.string().nullable(),
  }),
})
export type Job = z.infer<typeof Job>

/**
 * POST /api/v1/jobs → 201 (200 for an idempotent repeat); GET /api/v1/jobs/{id} → 200;
 * POST /api/v1/jobs/{id}/cancel → 202. `prompt` is present only on GET /api/v1/jobs/{id},
 * and only for the requester or a holder of `agents.write`.
 */
export const JobResponse = z.object({ job: Job.extend({ prompt: z.string().optional() }) })
export type JobResponse = z.infer<typeof JobResponse>

/** GET /api/v1/jobs query. Needs `agents.read`. Newest first, `JOB_LIST_PAGE_SIZE` per page. */
export const ListJobsQuery = z.strictObject({
  project_id: z.guid().optional(),
  status: JobStatus.optional(),
  /** Opaque keyset cursor on (created_at, id): a previous page's `next_cursor`. */
  cursor: z.string().regex(/^[\x21-\x7E]{1,200}$/).optional(),
})
export type ListJobsQuery = z.infer<typeof ListJobsQuery>

/** GET /api/v1/jobs → 200. Never carries prompts. */
export const JobListResponse = z.object({
  jobs: z.array(Job).max(JOB_LIST_PAGE_SIZE),
  next_cursor: z.string().nullable(),
})
export type JobListResponse = z.infer<typeof JobListResponse>

// ---------------------------------------------------------------- container callbacks

/** POST /api/v1/jobs/{id}/claim body. Accepted once, in `provisioning`, before the deadline. */
export const JobClaimRequest = z.strictObject({
  /** The single-use claim token from the machine configuration (256-bit, hex). */
  claim_token: z.string().regex(/^[0-9a-f]{64}$/),
})
export type JobClaimRequest = z.infer<typeof JobClaimRequest>

/**
 * A kete job spec v1 as the platform compiles it (docs/jobs.md §5; the runtime's own rules are
 * kete-code docs/jobs.md "Spec v1"). The platform always sets `agent`, `model`, `policy.budget`,
 * `policy.timeout` and `branch`, and never `prompt_file`.
 */
export const JobSpec = z.strictObject({
  version: z.literal(1),
  prompt: JobPrompt,
  agent: AgentSlug,
  /** The agent's resolved catalog model, `kete/<model_id>`; the gateway pins it (ADR 0020 rule 9). */
  model: z.string().regex(/^kete\/\S+$/).max(205),
  policy: z.strictObject({
    version: z.literal(1),
    allow: z.array(JobAllowRule).max(JOB_ALLOW_MAX_RULES),
    /** USD, the exact decimal of `budget_micros`. */
    budget: z.number().positive().max(JOB_BUDGET_MAX_MICROS / 1_000_000),
    /** Minutes; the entrypoint may lower it to fit the deadline. */
    timeout: z.number().int().min(1).max(JOB_TIMEOUT_MAX_MINUTES),
  }),
  branch: JobBranch,
})
export type JobSpec = z.infer<typeof JobSpec>

/** POST …/claim → 200. The only response that ever carries these secrets. */
export const JobClaimResponse = z.object({
  spec: JobSpec,
  /** The job's gateway key (`api_keys.kind = 'job'`), valid until `deadline`. */
  gateway_key: z.string().regex(/^[\x21-\x7E]{1,200}$/),
  /** Authenticates every later callback (256-bit, hex); valid until `deadline`. */
  callback_token: z.string().regex(/^[0-9a-f]{64}$/),
  /** A read-only GitHub installation token for one repository; revoke it after the clone. */
  clone: z.object({
    url: HttpsUrl,
    token: z.string().regex(/^[\x21-\x7E]{1,500}$/),
    ref: JobGitRef,
    /** The commit the platform resolved for `ref`; the clone must be at exactly this commit. */
    base_sha: GitSha,
  }),
  gateway_url: HttpsUrl,
  /** Equals the machine configuration's platform URL: an origin, no path. */
  platform_url: HttpsOrigin,
  /** The hard deadline of every later step. */
  deadline: Timestamp,
})
export type JobClaimResponse = z.infer<typeof JobClaimResponse>

export const JobEventPhase = z.enum(['clone', 'agent', 'report', 'done'])
export type JobEventPhase = z.infer<typeof JobEventPhase>

/** POST …/events body → 204. A heartbeat at least every 60 s, in `running` and `finalizing`. */
export const JobEventRequest = z.strictObject({
  phase: JobEventPhase,
  /** Redacted before storing. */
  message: z.string().max(JOB_EVENT_MESSAGE_MAX_CHARS).optional(),
  /** Accepted once, with the first `agent` event; must be ≤ the job's `timeout_minutes`. */
  effective_timeout_minutes: z.number().int().min(1).max(JOB_TIMEOUT_MAX_MINUTES).optional(),
  /** Processes besides `kete` in the `kete` user's cgroup (ADR 0019 rule 5); above 0 is a job error. */
  kete_cgroup_extra: z.number().int().nonnegative().optional(),
})
export type JobEventRequest = z.infer<typeof JobEventRequest>

/** One denial in the runtime's result. */
export const JobRunDenial = z.object({
  action: z.string(),
  resources: z.array(z.string()),
  message: z.string().optional(),
})
export type JobRunDenial = z.infer<typeof JobRunDenial>

/**
 * POST …/result body → 204: the `kete job run --json` result v1 (kete-code docs/jobs.md
 * "Output"), forwarded verbatim by the entrypoint, or one it writes itself. Additive: unknown
 * fields are ignored and an unknown `outcome` is accepted (stored as reported, status `failed`).
 * Accepted once, in `running`. Container-reported: `text` is cut to `JOB_SUMMARY_MAX_BYTES`
 * and `denied` to `JOB_DENIED_MAX_STORED` entries, both redacted, before storing.
 */
export const JobRunResult = z.object({
  version: z.literal(1),
  outcome: JobOutcome,
  exit_code: z.number().int().min(0).max(255),
  session_id: z.string().optional(),
  text: z.string().optional(),
  isolated: z.boolean().optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  directory: z.string().optional(),
  /** Informational; the gateway's `spent_micros` is authoritative. */
  cost_usd: z.number().nonnegative().optional(),
  cost_scope: z.enum(['family', 'root']).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  audit_log: z.string().optional(),
  audit_local: z.boolean().optional(),
  denied: z.array(JobRunDenial),
  message: z.string().optional(),
})
export type JobRunResult = z.infer<typeof JobRunResult>

/** POST …/uploads body. Accepted once, in `finalizing`. */
export const JobUploadsRequest = z.strictObject({
  /** False when the entrypoint has no change bundle to upload. */
  bundle: z.boolean(),
})
export type JobUploadsRequest = z.infer<typeof JobUploadsRequest>

/** A single-use signed upload URL (PUT), valid for 10 minutes. */
export const JobSignedUpload = z.object({ url: HttpsSignedUrl, expires_at: Timestamp })
export type JobSignedUpload = z.infer<typeof JobSignedUpload>

/**
 * POST …/uploads → 200. `audit` ≤ 20 MB `application/x-ndjson`, `proxy_log` ≤ 10 MB,
 * `bundle` (only when asked for) ≤ 10 MB `application/gzip`.
 */
export const JobUploadsResponse = z.object({
  audit: JobSignedUpload,
  proxy_log: JobSignedUpload,
  bundle: JobSignedUpload.optional(),
})
export type JobUploadsResponse = z.infer<typeof JobUploadsResponse>

/** Why the entrypoint built no bundle (ADR 0021 rule 5); it then uploaded none. */
export const JobPushError = z.enum(['processes_alive', 'symlink', 'unreadable', 'proxy_failed'])
export type JobPushError = z.infer<typeof JobPushError>

/** POST …/finish body → 202. Accepted once, in `finalizing`. */
export const JobFinishRequest = z.strictObject({
  push_error: JobPushError.optional(),
})
export type JobFinishRequest = z.infer<typeof JobFinishRequest>
```

## Examples

`POST /api/v1/jobs` request (`CreateJobRequest`):

```json
{
  "project_id": "2f1c7e0a-5b8d-4c3e-9a71-0d6b4e2f8a13",
  "repository_id": "7a4e1b9c-3d2f-4e8a-b6c5-1f0e9d8c7b6a",
  "base_ref": "main",
  "agent": "developer",
  "prompt": "Upgrade the lodash dependency and fix anything that breaks",
  "allow": [{ "action": "shell", "resource": "npm test*" }],
  "budget_micros": 2000000,
  "timeout_minutes": 30,
  "branch_suffix": "upgrade-lodash",
  "push": true,
  "open_pr": false
}
```

`201` (`JobResponse`):

```json
{
  "job": {
    "id": "c3d8f1a2-6b4e-4f7a-9c2d-8e1f0a3b5c7d",
    "status": "running",
    "outcome": null,
    "exit_code": null,
    "project_id": "2f1c7e0a-5b8d-4c3e-9a71-0d6b4e2f8a13",
    "repository": { "id": "7a4e1b9c-3d2f-4e8a-b6c5-1f0e9d8c7b6a", "full_name": "acme/shop", "base_ref": "main" },
    "agent": { "id": "5e9a2c4b-8f1d-4a6e-b3c7-2d0f1e8a9b4c", "slug": "developer", "version": 3 },
    "branch": "kete/job/upgrade-lodash",
    "push": true,
    "push_status": "pending",
    "pr_url": null,
    "warnings": [],
    "budget_micros": 2000000,
    "spent_micros": 184000,
    "timeout_minutes": 30,
    "effective_timeout_minutes": 28,
    "created_by": "9b1e4d7a-2c5f-4e8b-a1d3-6f0c9e2b5a8d",
    "created_at": "2026-09-28T10:00:00Z",
    "started_at": "2026-09-28T10:00:40Z",
    "ended_at": null,
    "reported": { "denied_count": 0, "summary_text": null }
  }
}
```

`GET /api/v1/jobs?project_id=2f1c7e0a-5b8d-4c3e-9a71-0d6b4e2f8a13` → `200` (`JobListResponse`):

```json
{
  "jobs": [
    {
      "id": "e1a4c7d2-9b3f-4e6a-8c1d-5f2b0e7a9c3d",
      "status": "succeeded",
      "outcome": "completed",
      "exit_code": 0,
      "project_id": "2f1c7e0a-5b8d-4c3e-9a71-0d6b4e2f8a13",
      "repository": { "id": "7a4e1b9c-3d2f-4e8a-b6c5-1f0e9d8c7b6a", "full_name": "acme/shop", "base_ref": "main" },
      "agent": { "id": "5e9a2c4b-8f1d-4a6e-b3c7-2d0f1e8a9b4c", "slug": "developer", "version": 3 },
      "branch": "kete/job/1a2b3c4d",
      "push": true,
      "push_status": "created",
      "pr_url": "https://github.com/acme/shop/pull/42",
      "warnings": ["create_trigger"],
      "budget_micros": 2000000,
      "spent_micros": 912000,
      "timeout_minutes": 30,
      "effective_timeout_minutes": 30,
      "created_by": "9b1e4d7a-2c5f-4e8b-a1d3-6f0c9e2b5a8d",
      "created_at": "2026-09-27T15:00:00Z",
      "started_at": "2026-09-27T15:00:35Z",
      "ended_at": "2026-09-27T15:21:10Z",
      "reported": { "denied_count": 1, "summary_text": "Upgraded lodash to 4.17.21; all tests pass." }
    }
  ],
  "next_cursor": null
}
```

`409` (`ErrorResponse`):

```json
{
  "error": {
    "code": "conflict",
    "message": "Your organization already has 2 jobs running. Wait for one to finish.",
    "request_id": "b7748580-c34d-40ee-9d03-817e4455eddd"
  }
}
```

`POST /api/v1/jobs/{id}/claim` request (`JobClaimRequest`):

```json
{ "claim_token": "4f9c2a7e1b8d3f6a0c5e9b2d7f1a4c8e6b3d0f9a2c7e5b1d8f4a6c0e3b9d2f7a" }
```

`200` (`JobClaimResponse`):

```json
{
  "spec": {
    "version": 1,
    "prompt": "Upgrade the lodash dependency and fix anything that breaks",
    "agent": "developer",
    "model": "kete/claude-sonnet-4-5",
    "policy": {
      "version": 1,
      "allow": [{ "action": "shell", "resource": "npm test*" }],
      "budget": 2,
      "timeout": 30
    },
    "branch": "kete/job/upgrade-lodash"
  },
  "gateway_key": "kete_live_example",
  "callback_token": "a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2a4c6e8f0b2d4a6c8e0f2b4d",
  "clone": {
    "url": "https://github.com/acme/shop.git",
    "token": "ghs_EXAMPLE_installation_token",
    "ref": "main",
    "base_sha": "3f786850e387550fdab836ed7e6dc881de23001b"
  },
  "gateway_url": "https://gateway.kete.example",
  "platform_url": "https://portal.kete.example",
  "deadline": "2026-09-28T10:40:00Z"
}
```

`POST /api/v1/jobs/{id}/events` (`JobEventRequest`):

```json
{ "phase": "agent", "effective_timeout_minutes": 28, "kete_cgroup_extra": 0 }
```

`POST /api/v1/jobs/{id}/result` (`JobRunResult`, as `kete job run --json` prints it in a job):

```json
{
  "version": 1,
  "outcome": "completed",
  "exit_code": 0,
  "session_id": "ses_01J8ZQ4M7N2P3R5S6T8V9W0X1Y",
  "text": "Upgraded lodash to 4.17.21; all tests pass.",
  "isolated": true,
  "branch": "kete/job/upgrade-lodash",
  "worktree": "/srv/kete-job/work/repo",
  "directory": "/srv/kete-job/work/repo",
  "cost_usd": 0.18,
  "cost_scope": "family",
  "duration_ms": 1234567,
  "audit_local": true,
  "denied": [{ "action": "edit", "resources": [".kete/kete.jsonc"], "message": "Kete configuration can't be edited in a job." }]
}
```

`POST /api/v1/jobs/{id}/uploads` request (`JobUploadsRequest`):

```json
{ "bundle": true }
```

`200` (`JobUploadsResponse`):

```json
{
  "audit": { "url": "https://storage.kete.example/upload/sign/job-audit/acme/c3d8f1a2.jsonl?token=9f8e7d6c5b4a", "expires_at": "2026-09-28T10:31:00Z" },
  "proxy_log": { "url": "https://storage.kete.example/upload/sign/job-audit/acme/c3d8f1a2.proxy.jsonl?token=9f8e7d6c5b4a", "expires_at": "2026-09-28T10:31:00Z" },
  "bundle": { "url": "https://storage.kete.example/upload/sign/job-bundles/acme/c3d8f1a2.tar.gz?token=9f8e7d6c5b4a", "expires_at": "2026-09-28T10:31:00Z" }
}
```

`POST /api/v1/jobs/{id}/finish` (`JobFinishRequest`), when no bundle could be built:

```json
{ "push_error": "processes_alive" }
```
