# CLI login contract, v1

The contract between `kete login` / `kete logout` and `kete-code-platform`. The platform
implementation is the source of truth. This copy was taken from `kete-code-platform` at commit
`cb4ae82` (2026-09-25):

- `apps/portal/lib/cli-login.ts`: authorize parameters and callback URL
- `packages/shared/src/api/v1/cli.ts`: token request and response
- `packages/shared/src/api/v1/errors.ts`: error envelope
- `apps/portal/lib/platform-api/handlers.ts`: token handler behaviour
- `docs/portal.md` §7 and `docs/platform-api.md`

If the platform changes any of these, update this file and `packages/cli/src/kete/cli-login.ts`
together.

## 1. Flow

1. The CLI makes a PKCE verifier (43–128 characters from `A-Z a-z 0-9 - . _ ~`) and its S256
   challenge, `base64url(sha256(verifier))` without padding (always 43 characters), plus a
   random `state`.
2. The CLI listens on `127.0.0.1:<port>` and opens the authorize page in the browser.
3. The user signs in to the portal if needed, sees the device name, account and organization,
   and approves or denies.
4. The portal redirects the browser to the CLI's listener.
5. The CLI checks `state` and exchanges the code and verifier for a key.

## 2. `GET <platform>/cli/authorize`

| Parameter               | Rule                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `port`                  | 4–5 digits, 1024–65535                                             |
| `state`                 | `^[A-Za-z0-9._~-]{8,256}$`, echoed back unchanged                  |
| `code_challenge`        | `^[A-Za-z0-9_-]{43}$`                                              |
| `code_challenge_method` | optional; must be `S256`                                           |
| `device_name`           | optional; 1–100 characters after trimming, no control characters  |

Invalid or repeated parameters show an error and never redirect. A signed-out user is sent to
`/login?next=…` first.

## 3. Callback

Always `http://127.0.0.1:<port>/callback`; the host is fixed by the platform, never taken from
the request.

- Approved: `?code=<code>&state=<state>`. The code is 32 random bytes in base64url, single use
  and short-lived; the platform stores only its hash.
- Denied: `?error=access_denied&state=<state>`.

## 4. `POST <platform>/api/v1/cli/token`

Request (JSON):

```json
{ "code": "…", "code_verifier": "…", "device_name": "my-laptop" }
```

`code` 1–256 characters, `code_verifier` `^[A-Za-z0-9\-._~]{43,128}$`, `device_name` 1–100
characters.

Response `200`:

```json
{
  "api_key": "kete_live_…",
  "key_id": "<uuid>",
  "organization": { "id": "<uuid>", "name": "Acme" },
  "gateway_url": "https://…"
}
```

The plaintext key is returned once. Errors:

| Status | Code              | When                                                                     |
| ------ | ----------------- | ------------------------------------------------------------------------ |
| 400    | `expired`         | A known code that has expired or was already used                        |
| 400    | `invalid_request` | Malformed body, unknown code, or a verifier that doesn't match           |
| 429    | `rate_limited`    | More than 10 requests a minute from one address (`retry-after` is set)   |
| 500    | `internal`        | Platform failure                                                         |

## 5. `POST <platform>/api/v1/cli/logout`

`Authorization: Bearer <api_key>`. Revokes the calling key if it is a CLI key and returns
`204`. `403 forbidden` for a portal (`user`) key; `401 invalid_key` for a missing, invalid,
expired or revoked key.

## 6. Errors

```json
{ "error": { "code": "expired", "message": "…", "request_id": "…" } }
```

Codes: `invalid_request`, `invalid_key`, `forbidden`, `not_found`, `expired`, `rate_limited`,
`internal`. The request id is also in the `x-kete-request-id` header.

## 7. Not in v1

- Refresh tokens: the key lives until logout or revocation.
- A flow without a local listener (see `requests/manual-login.md`).
