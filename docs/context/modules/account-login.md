---
module: account-login
paths: [packages/util/src/kete/account.ts, packages/util/src/kete/secret-store.ts, packages/cli/src/kete/cli-login.ts, packages/cli/src/kete/account-flow.ts, packages/cli/src/kete/account-io.ts, packages/cli/src/kete/login.ts, packages/cli/src/kete/logout.ts, packages/cli/src/kete/whoami.ts, packages/cli/src/kete/commands.ts]
verified-at: 4e26b57120
---
## Quick answers
- Do MCP presets share the account's secret store? The same `KeteSecretStore` module and `kete-code` service, under separate `mcp:<server>` entries (`util/src/kete/mcp-secret.ts`); `kete logout` doesn't remove them. See the `mcp-presets` card.
- Does `kete login` work offline? No: `login.ts` calls `KeteCliOffline.refused` first (exit 2); `logout`/`whoami` are unchanged. See the `local-models` card.
- Does `kete login`/the credential store work in job mode (`KETE_JOB_MODE`)? No — `secret-store.ts:178`
  calls `KeteJobMode.refuseSpawn("OS credential store")` before spawning the OS keychain CLI
  (`run()`, `secret-store.ts:176-183`), since this spawn is outside the shared `ChildProcessSpawner`
  service job mode otherwise replaces wholesale. Not expected to matter in practice — job mode is a
  server-side, unattended build with no interactive sign-in flow — but it's fail-closed the same way
  as every other spawn site. See the `job-mode` card.
- What does `kete login` do? Runs a PKCE browser flow against the platform (`cli-login.ts`), then stores the key via `account-flow.ts:32` `login()`.
- Where is the account's non-secret state stored? `<config>/account.json`, written by `account.ts:64-81` `save()` (write-then-rename).
- Where does the API key itself live? An OS credential store (macOS Keychain / Linux Secret Service / Windows Credential Manager) via `secret-store.ts`, or a user-only fallback file when none works.
- Does `kete auth` still work? Yes — it stays upstream's command for model-provider keys; `kete login`/`logout`/`whoami` are Kete's own commands for the platform account (`commands.ts:1-2`).

## Purpose
Signs a user in to a Kete Code account through the platform's browser-based CLI login (`kete login`), stores the resulting API key OS-natively, and exposes it to `kete logout`/`kete whoami`/the gateway provider/the sync plugin. Implements docs/platform/cli-login-v1.md end to end on the client.

## Entry points
- `packages/cli/src/kete/login.ts:9-25`, `logout.ts:9-18`, `whoami.ts:9-18` — Effect `Runtime.handler`s wired into the CLI command tree via `commands.ts:22-72` (`login`/`logout`/`sync`/`whoami` specs, part of `KeteCommands.specs`), spread into `cli/src/commands/commands.ts` (upstream seam) and `cli/src/index.ts` (handler map entries). `commands.ts` also now defines the unrelated `job run` spec (`:73-88`) — see the `cli` card; this card only covers the account-sign-in specs in the same file.
- `account-flow.ts:32` `login()`, `:241` `logout()`, `:298` `whoami()` / `:274` `whoamiJSON()`, `:105` `sync()` (see the `sync` module card) — plain functions over injected `IO`, so tests run them end to end against a fake platform (`account-flow.ts:1-2`).
- `account-io.ts:24-33` `AccountIO.make()` — the real terminal I/O: stdout/stderr, `KeteAccount.defaults()`, and a reload of the background service only if one is already running.

## Key files
- `account.ts:19-30` `Account` schema (`account.json` shape: platform/gateway URL, organization, key id, device name, storage kind); `:64-81` `save()`, `:50-61` `read()`, `:94-110` `clear()`.
- `account.ts:113-119` `store()` picks the credential store by `Account["storage"]` kind; `:122-124` `entry()` keys credentials by `<platform host>/<key_id>` so accounts on different platforms never collide.
- `secret-store.ts:35-141` the four `Store` implementations (`keychain`, `secretService`, `credentialManager`, `file`) — each drives an OS tool via stdin/stdout only, never argv (`secret-store.ts:6-8`); `:148-165` `save()` writes then reads back to verify before trusting a store.
- `cli-login.ts:22-40` PKCE (`pkce()`, `challengeFor()`, RFC 7636 S256); `:110-198` `listen()` — the 127.0.0.1-only loopback callback listener, Host/state checked per request (`:157-191`).
- `cli-login.ts:272-315` `exchange()`/`revoke()`/`me()` — the `/api/v1/cli/token`, `/api/v1/cli/logout`, `/api/v1/me` calls; `:331-358` `failure()` maps HTTP status/error code to a typed `PlatformError`.
- `account-flow.ts:32-101` `login()` — orchestrates PKCE, browser open, token exchange, `KeteAccount.save`, retiring a previous account, and a first sync.
- `account-flow.ts:241-268` `logout()` — revokes the key, removes the organization's sync cache, clears the account.
- `account-flow.ts:299-339` `whoami()` — prints account details plus a live `/api/v1/me` status check; also resolves and prints `kete.runtime.type`/`KETE_RUNTIME_TYPE` (`:312-317`, via `@opencode/util/kete/runtime-registration`'s `resolveRuntimeType`) — a `"local"`/unset type prints nothing, a non-`"local"` type prints `Runtime:      <type>`, an invalid value warns naming the source and that registration is skipped. `:275-296` `whoamiJSON()` is local-state-only (no network, no runtime-type field), used by the VS Code extension.

## Data flow
`kete login` → `cli-login.ts` PKCE + loopback listener opens `<platform>/cli/authorize` in the browser (docs/platform/cli-login-v1.md) → user approves in the portal → platform redirects the browser to `127.0.0.1:<port>/callback?code=…&state=…` → `cli-login.ts:110-198` `listen()` validates Host/state and resolves the code → `account-flow.ts:66-79` exchanges it via `POST /api/v1/cli/token` → `KeteAccount.save()` (`account.ts:64-81`) stores the key in the first working credential store and writes `account.json` → `account-flow.ts:96-99` runs one `KeteSync.sync()` so managed agents are ready on next start → `announceReload()` (`account-flow.ts:409-414`) asks a running background service to pick up the change.

## Data and APIs used
- Platform API (`kete-code-platform`, never the database — CLAUDE.md §3): `POST /api/v1/cli/token` (`cli-login.ts:272-292`), `POST /api/v1/cli/logout` (`:295-303`), `GET /api/v1/me` (`:305-315`).
- OS credential stores: macOS `security`, Linux `secret-tool` (Secret Service / libsecret-tools), Windows PowerShell + Win32 Credential Manager API (`secret-store.ts:35-105`); 15s timeout per call (`secret-store.ts:29`).
- Filesystem: `<config>/account.json` (`account.ts:45-47`), fallback key file under `<data>` (`secret-store.ts:108-133`).

## Rules that must not break
- The API key, PKCE verifier and authorization code never appear in an error message, log line, or anything printed (`cli-login.ts:6-7`, `account-flow.ts:4-5`).
- Loopback listener only binds `127.0.0.1`, never another interface, and only accepts a request whose `Host` matches `127.0.0.1:<port>` exactly — guards DNS rebinding and cross-site requests (`cli-login.ts:104-109,159-161`).
- Plain `http://` is only accepted for the platform URL when the host is loopback; otherwise `https:` is required, since the key returns in the response (`cli-login.ts:47-58`).
- Credential entry names and secrets are restricted to printable ASCII without quotes/backslashes so no OS tool re-parses them (`secret-store.ts:31-33,167-170`).
- `save()` verifies a store actually kept the secret (read-back check) before trusting it, and removes a half-written entry from a store it won't use (`secret-store.ts:148-165`).
- Replacing an account revokes and forgets the previous one rather than accumulating keys (`account-flow.ts:81-82,397-407`).

## Testing
- `packages/cli/test/kete/login.test.ts` — `bun test ./test/kete/login.test.ts` inside `packages/cli`. Note: `cli-login.ts:4` names this file `test/kete/cli-login.test.ts` in its header comment; the actual file is `login.test.ts`.
- `packages/util/test/kete/account.test.ts` — `bun test ./test/kete/account.test.ts` inside `packages/util`.

## Changes
- docs/upstream-patches.md "Account sign-in" (feature/kete-login) — introduced all files in this card plus `core/src/kete/gateway.ts` reading the account; upstream seams: `cli/src/commands/commands.ts` (spreads `KeteCommands.specs`), `cli/src/index.ts` (handler map).
- docs/upstream-patches.md "VS Code extension" (feature/vscode-extension) — added `kete whoami --format json` for the extension's account display.

## Gotchas
- `kete auth` (upstream, model-provider keys) and `kete login` (Kete platform account) are separate systems; both `--help` texts point at the other (`commands.ts:11`). Check on sync that upstream hasn't added its own top-level `login`/`logout`/`whoami` command, which would collide with the spread.
- `whoami`'s live status check calls `/api/v1/me`; `whoamiJSON` deliberately makes no network request, so the two can disagree if the key was just revoked (`account-flow.ts:275-296` vs `299-339`). The runtime-type line has a matching split: `whoami` reads and prints it, `whoamiJSON` doesn't carry it at all (a separate decision, not an oversight — see the plan in `docs/tasks/2026-09-28-runtime-type`).
- A signed-in account's gateway URL/key take precedence over hand-configured `providers.kete` settings or `OPENCODE_GATEWAY_*` env vars while signed in (`account-flow.ts:29-30,350-357`); see the `gateway` module card for the consuming side.
- `resolvePlatform()` precedence: `--platform-url` > `KETE_PLATFORM_URL` > `kete.platform.url` in global config > the previous account's platform > `Brand.urls.platform` (undefined today) (`account-flow.ts:344-354`). `globalConfig()` (`:367-391`) also now returns the raw `kete.runtime.type` value (later config file wins, same merge rule as `platform`) for `whoami` to resolve — it reads only the *global* config, so a project-level `kete.runtime.type` is invisible to `whoami` even though the sync plugin's registration call (which reads full `Config.entries()`) sees it; documented in the schema description (`packages/schema/src/config/kete.ts`'s `Runtime.type`).
