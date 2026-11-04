# [platform] Short-lived desktop token exchange

Repository: `kete-code-platform`. Raised by `docs/desktop-enhancement-plan.md` (Q1, brief §3.5).

## Problem

`kete login` stores a long-lived organization API key (`kete_sk_…`) in the OS key store
(`packages/cli/src/kete/account-flow.ts`), and the runtime sends it to the gateway on every call. The
desktop brief requires the desktop to hold only a short-lived token, except in BYO-key mode. Until this
issue ships, Phase A keeps the key-store credential (decision 2026-11-04).

## Contract the runtime expects

`POST /api/v1/cli/token/exchange`
- Auth: `Authorization: Bearer <long-lived device credential>`. This is a device-bound refresh credential
  issued by the existing `/api/v1/cli/token` PKCE flow, replacing the org API key there.
- Request: `{ "device_id": "<uuid>", "audience": "gateway" }`
- 200: `{ "access_token": "<opaque>", "expires_in": 900, "token_type": "Bearer", "organization": { "id": "…", "name": "…" } }`
- 401 `{ "error": { "code": "revoked" | "expired", "message": "…" } }`: the runtime signs out and shows
  "Sign in to Kete Code".
- The gateway accepts `access_token` wherever it accepts an org key today, including `GET /api/v1/me`.

Requirements:
- Access tokens last 15 minutes or less and are bound to `device_id`.
- The refresh credential can be revoked from the portal, and `POST /api/v1/cli/logout` revokes it.
- Rate limits apply per device.
- Neither the refresh credential nor the access token appears in logs or audit records; record key ids only.
- Migration: existing org keys keep working until the user signs in again; the portal shows which devices
  still use a long-lived key.

## Runtime changes once available (kete-code, later PR)

- `kete login` stores the refresh credential in the OS key store instead of the org key.
- The gateway client exchanges it for an access token, refreshes before expiry, and keeps the token in
  memory only.
- `kete.account` status and the desktop footer are unchanged.
