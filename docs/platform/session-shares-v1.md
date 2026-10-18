<!-- Copied from kete-code-platform docs/contracts/session-shares-v1.md (branch feature/session-shares, 2026-10-18). The platform copy is the source of truth; update both together. -->

# Session shares API contract — v1

Standalone copy of the session shares contract for the `kete-code` repository. The source of
truth is `packages/shared/src/api/v1/shares.ts` in `kete-code-platform`; the schema block below is
kept identical to it, and a test there fails if they differ. The sync field `share` (the
organization's sharing policy) is in `sync-v1.md`.

## Routes

All three take `Authorization: Bearer <kete key>`: a user's key (the one `kete login` stores). A
cloud job's key gets `403 forbidden`. Every response carries `x-kete-request-id` and
`Cache-Control: no-store`.

| Route | Who | Success |
|---|---|---|
| `POST /api/v1/shares` | any member | `201` `ShareResponse` |
| `PUT /api/v1/shares/{id}` | the share's owner | `200` `ShareResponse`; replaces `title` and `snapshot`, keeps the expiry |
| `DELETE /api/v1/shares/{id}` | the owner, or a member with `shares.manage` | `204`, no body |

- **Body:** JSON, at most 2 MiB + 8 KiB (`SHARE_BODY_MAX_BYTES`); the serialized snapshot alone at
  most 2 MiB (`SHARE_SNAPSHOT_MAX_BYTES`). Over either: `413 payload_too_large`. A NUL character
  anywhere: `400 invalid_request`.
- **Redaction:** the runtime redacts secrets before uploading. The platform redacts every string
  in the body again, as defence in depth; `redactions` stays the runtime's count.
- **Expiry:** `expires_at` = creation + the organization's `share_max_days` days (default 30,
  1–365). Expired shares are deleted for good within the hour.
- **`url`:** for a `link` share created by this call, `<portal>/s/<token>`: the token is returned
  only here, once, and only its SHA-256 is stored. Otherwise (an `org` share, or any `PUT`)
  `<portal>/shares/{id}`, which only signed-in members can open. Keep the link from the create
  response.
- **Policy:** the organization's mode (`disabled`, `org`, `link`) is checked on every call and on
  every read: lowering it below `link` revokes every link at once and for good (the shares become
  `org` shares; raising the mode again doesn't revive them), and `disabled` hides every share
  (owners and `shares.manage` members can still delete). A link also stops working when its
  creator leaves the organization.
- **Rate limit:** 30 creates and updates per user per hour; over it, `429 rate_limited` with
  `Retry-After`.

| Status | Code | When |
|---|---|---|
| `400` | `invalid_request` | the body isn't JSON, has a NUL or fails the schema |
| `401` | `invalid_key` | missing, malformed, unknown, revoked or expired key |
| `403` | `forbidden` | a job key |
| `403` | `share_disabled` | the organization has turned sharing off (`POST`, `PUT`) |
| `403` | `share_link_not_allowed` | `visibility: "link"` (or a `PUT` on a link share) while the organization allows only `org` |
| `404` | `not_found` | the share is gone, expired, in another organization, or (`PUT`) not yours |
| `413` | `payload_too_large` | over the body or snapshot cap |
| `429` | `rate_limited` | over the rate limit |
| `500` / `503` | `internal` / `unavailable` | retry later |

Compatibility: v1 only gains optional fields. Ignore unknown fields; a new snapshot shape ships as
a new `version`.

## Schemas (Zod)

```ts
import { z } from 'zod'

/**
 * Session shares — POST /api/v1/shares, PUT and DELETE /api/v1/shares/{id}.
 *
 * Authenticated with a user's Kete API key (a job key gets 403). The runtime uploads a redacted
 * snapshot of one session; members of the organization read it in the portal, and anyone with
 * the link can when the organization allows `link` shares. Standalone copy for the kete-code
 * repo: docs/contracts/session-shares-v1.md. Caps are string lengths in UTF-16 code units.
 */

/** The serialized snapshot, at most. */
export const SHARE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
/** The whole request body, at most: the snapshot plus 8 KiB for `session_id`, `title` and `visibility`. */
export const SHARE_BODY_MAX_BYTES = SHARE_SNAPSHOT_MAX_BYTES + 8 * 1024
/** Days a share lives when the organization hasn't set its own `share_max_days`. */
export const SHARE_DEFAULT_DAYS = 30

/** Who can read a share: the organization's members, or anyone with the link. */
export const ShareVisibility = z.enum(['org', 'link'])
export type ShareVisibility = z.infer<typeof ShareVisibility>

export const ShareTool = z.object({
  name: z.string().max(128),
  status: z.string().max(32),
  /** Truncated by the runtime. */
  input: z.string().max(2048),
  output: z.string().max(4096),
})
export type ShareTool = z.infer<typeof ShareTool>

export const ShareMessage = z.discriminatedUnion('type', [
  /** `files` are file names only, never contents. */
  z.object({ type: z.literal('user'), text: z.string().max(262144), files: z.array(z.string().max(1024)).max(200) }),
  z.object({ type: z.literal('assistant'), text: z.string().max(262144), tools: z.array(ShareTool).max(500) }),
  z.object({ type: z.literal('shell'), command: z.string().max(8192), exit: z.number().int().nullable(), output: z.string().max(4096) }),
  /** A marker only; the summary isn't sent. */
  z.object({ type: z.literal('compaction') }),
])
export type ShareMessage = z.infer<typeof ShareMessage>

export const ShareDiff = z.object({
  /** Relative to the workspace. */
  path: z.string().max(1024),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(16384),
})
export type ShareDiff = z.infer<typeof ShareDiff>

/** Snapshot v1. A breaking change ships as a new `version`. */
export const ShareSnapshot = z.object({
  version: z.literal(1),
  created_at: z.iso.datetime({ offset: true }),
  runtime_version: z.string().min(1).max(64),
  title: z.string().max(200),
  /** `<provider>/<model>`; display only. */
  model: z.string().regex(/^[^/\s]+\/.+$/).max(200).optional(),
  /** The runtime dropped messages or diffs to fit the caps. */
  truncated: z.boolean(),
  /** Secrets the runtime redacted. The platform redacts again and doesn't change this count. */
  redactions: z.number().int().nonnegative(),
  messages: z.array(ShareMessage).max(10000),
  diffs: z.array(ShareDiff).max(2000),
})
export type ShareSnapshot = z.infer<typeof ShareSnapshot>

/** POST /api/v1/shares */
export const ShareCreateRequest = z.object({
  session_id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  visibility: ShareVisibility,
  snapshot: ShareSnapshot,
})
export type ShareCreateRequest = z.infer<typeof ShareCreateRequest>

/** PUT /api/v1/shares/{id}: replaces the title and snapshot; the expiry stays. */
export const ShareUpdateRequest = z.object({
  title: z.string().min(1).max(200),
  snapshot: ShareSnapshot,
})
export type ShareUpdateRequest = z.infer<typeof ShareUpdateRequest>

/**
 * POST → 201, PUT → 200. For a `link` share created by this call, `url` carries the link token,
 * returned only once; otherwise `url` is the portal's `/shares/{id}`.
 */
export const ShareResponse = z.object({
  id: z.guid(),
  url: z.url(),
  visibility: ShareVisibility,
  expires_at: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
})
export type ShareResponse = z.infer<typeof ShareResponse>
```

## Example: create

```http
POST /api/v1/shares HTTP/1.1
Authorization: Bearer kete_live_…
Content-Type: application/json
```

```json
{
  "session_id": "ses_01JAB3C4D5E6F7G8H9J0K1M2N3",
  "title": "Fix the login redirect",
  "visibility": "link",
  "snapshot": {
    "version": 1,
    "created_at": "2026-10-18T09:30:00Z",
    "runtime_version": "0.2.8",
    "title": "Fix the login redirect",
    "model": "anthropic/claude-sonnet-4-5",
    "truncated": false,
    "redactions": 1,
    "messages": [
      { "type": "user", "text": "The login page loops after sign-in. Fix it.", "files": ["proxy.ts"] },
      {
        "type": "assistant",
        "text": "The redirect drops the `next` parameter. I'll keep it and add a test.",
        "tools": [{ "name": "read", "status": "completed", "input": "{\"filePath\":\"proxy.ts\"}", "output": "export function proxy(…" }]
      },
      { "type": "shell", "command": "pnpm test", "exit": 0, "output": "Tests  42 passed" },
      { "type": "compaction" }
    ],
    "diffs": [
      { "path": "proxy.ts", "additions": 3, "deletions": 1, "patch": "@@ -10,1 +10,3 @@\n-  return redirect('/login')\n+  const next = encodeURIComponent(pathname)\n+  return redirect(`/login?next=${next}`)" }
    ]
  }
}
```

`201 Created`:

```json
{
  "id": "6b2f0c3e-9a1d-4e7b-8c5f-2d3a4b5c6d7e",
  "url": "https://portal.example.com/s/q8Xv2mN4pL7rT1wY9zB3cF6hJ0kD5gS8aE2uI4oP7nM",
  "visibility": "link",
  "expires_at": "2026-11-17T09:30:01Z",
  "created_at": "2026-10-18T09:30:01Z"
}
```

## Example: 403

```json
{
  "error": {
    "code": "share_link_not_allowed",
    "message": "This organization allows only members-only shares.",
    "request_id": "b7748580-c34d-40ee-9d03-817e4455eddd"
  }
}
```
