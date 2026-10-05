---
module: mcp-presets
paths: [packages/schema/src/kete/mcp-presets.ts, packages/util/src/kete/mcp-secret.ts, packages/util/src/kete/sync/integrations.ts, packages/core/src/kete/mcp-secrets.ts, packages/cli/src/kete/mcp-preset.ts, packages/cli/src/kete/mcp-preset-io.ts, packages/cli/src/kete/mcp-presets-command.ts]
verified-at: 8421b4e431
---
## Quick answers
- What is a preset? A named template that expands to an ordinary upstream `mcp.servers` entry plus top-level `permissions` rules (`schema/src/kete/mcp-presets.ts:147` `harness`, `:185` `slack`). `kete mcp add <preset>` writes both into the same file upstream's `kete mcp add` writes; nothing about a preset exists at runtime.
- Why is the catalogue in `@opencode/schema`, not core? The CLI doesn't depend on core, and both the CLI (writes the expansion) and core (offline skip) need it; schema also has the `Mcp.ServerConfig`/`Permission.Ruleset` schemas the expansion is validated with.
- Which Harness version runs? An exact pin, `harnessVersion` (`mcp-presets.ts:26`), as `npx -y harness-mcp-v2@<pin>`; never `@latest`. Upgrading = change the pin, run the tests, re-run `kete mcp add harness` (docs/integrations/harness.md).
- How are MCP tool permissions named? `<server>_<tool>` (`core/src/tool/mcp.ts:17`; `action` at `mcp-presets.ts:35` mirrors it). Harness tools already start with `harness_`, so rules read `harness_harness_create`. Rules: catch-all `<server>_*` ask, known reads allow, known writes ask (last match wins, `core/src/permission.ts:86`).
- How does config refer to a stored secret? `{kete-secret:mcp:<server>}` as a whole `environment` value (`util/src/kete/mcp-secret.ts:38`). `core/src/mcp/client.ts:200-210` (marked) calls `KeteMcpSecrets.prepare` (`core/src/kete/mcp-secrets.ts:57`) before the spawn; only `mcp:` entries resolve, so config can't name the account key. Not `ConfigVariable` (`{env:}`/`{file:}`), which substitutes into the config the config API returns.
- Can a project's `.kete/` config get the stored key? No: the store keeps `kete-mcp-v1:<sha256>:<secret>` (`mcp-secret.ts:103` `encode`), the fingerprint (`:79`) covering name, `local`, command, cwd and every non-reference env entry. `resolve` (`:158`) releases it only to a local server named after the entry whose current definition has that fingerprint, else refuses the server (error names server and entry, never the value). A value without a fingerprint is never released. Config sources aren't known at spawn, so the fingerprint is the guarantee.
- Why does Harness run outside the project directory? A server that gets a stored secret spawns in `<data>/mcp-servers/<name>` (`mcp-secrets.ts:49`), so a repo's `.npmrc`/`node_modules`/`.env` can't redirect `npx` or the server.
- Where is the secret stored? `KeteSecretStore` (OS store, then `<data>/mcp-secrets/` file fallback), entry `mcp:<server>`, service `kete-code` (`mcp-secret.ts:58`).
- Does re-running `kete mcp add harness` ask for the key again? No: it reuses the stored key and re-binds it to the new definition (`cli/src/kete/mcp-preset.ts:122`); `--new-key` asks again.
- What happens to my own rules on a re-run? `mergePermissions` (`mcp-presets.ts:236`) keeps stricter (`deny`, or `ask` where the preset allows) and narrower-resource rules on preset actions after the preset's rules; an `allow` where the preset asks is replaced and the CLI warns.
- Where does `kete mcp add slack` get the client ID? `--client-id`, then `kete.integrations.slack.clientId` (project then global config files, `cli/src/kete/mcp-preset-io.ts:33`), then the sync cache's `integrations.slack.client_id` (`util/src/kete/sync/integrations.ts`), else it explains the Slack app requirement and exits 2. It prints the ID and its source before writing (`mcp-preset.ts:256`).
- Does Slack sign-in need a client secret? Slack's metadata lists only `client_secret_post`; the preset writes `client_id` + a pinned `redirect_uri` and no secret (upstream's `oauth.ts` then uses PKCE with `token_endpoint_auth_method: "none"`). The platform's server-side token exchange is the planned fallback (docs/integrations/slack.md).
- What does offline mode do? `KeteOffline.skip` (`core/src/kete/offline.ts:94`) disables remote servers and any local server `KeteMcpPresets.detect` recognises, and the plugin logs `offlineMessage` once per distinct set. The CLI still writes config offline and says the server is skipped; Slack skips the sign-in.

## Purpose
Built-in MCP presets for Harness and Slack (docs/tasks/2026-10-05-mcp-presets): one command connects a session to them, read-only or ask-first by default, with credentials in the OS secret store, never in config or logs.

## Entry points
- `kete mcp add <name>` — upstream handler `cli/src/commands/handlers/mcp/add.ts:27-42` (marked) calls `KeteMcpPreset.route` (`cli/src/kete/mcp-preset.ts:90`) and, for a preset, `KeteMcpPreset.add` (`:111`) with `KeteMcpPresetIO.make` (`mcp-preset-io.ts:101`).
- `kete mcp presets` — `cli/src/kete/mcp-presets-command.ts` → `KeteMcpPreset.list` (`mcp-preset.ts:317`); spec `KeteCommands.mcpPresets` (`cli/src/kete/commands.ts:61`), flags `mcpPresetParams` (`:43`), spread into upstream's `mcp` spec (`cli/src/commands/commands.ts:229,232`), handler `cli/src/index.ts:56`.
- Runtime: `core/src/mcp/client.ts:200-210` (spawn-time secret release and cwd), `core/src/kete/offline.ts:94` (skip).

## Key files
| File | Role |
| --- | --- |
| `packages/schema/src/kete/mcp-presets.ts` | Catalogue, tool lists, `harness`/`slack` expansions (validated), `permissions`, `detect`, `offlineMessage`, `mergePermissions` |
| `packages/util/src/kete/mcp-secret.ts` | `entry`/`reference`/`parse`, `stores`, `fingerprint`, `encode`/`decode`, `save` (bound to a definition), `read`, `resolve` (binding checks) |
| `packages/util/src/kete/sync/integrations.ts` | `slackClientId(response)` — lenient reader of the sync response's `integrations` |
| `packages/core/src/kete/mcp-secrets.ts` | `resolve` (Effect wrapper with the real stores), `prepare` (environment + isolated cwd for secret-using servers) |
| `packages/cli/src/kete/mcp-preset.ts` | Flows over an injected `IO`: `route`, `add` (Harness/Slack), `edit` (JSONC write keeping comments), `list` |
| `packages/cli/src/kete/mcp-preset-io.ts` | Real IO: clack `password`, secret store, config/sync reads, sign-in (reload, OAuth connect, bounded poll) |

## Data flow
`kete mcp add harness` → flags validated → stored key reused, else hidden prompt (or `HARNESS_API_KEY` → `{env:}` without a TTY) → expansion → `KeteMcpSecret.save(key, fingerprint of the expansion's server)` → `edit` writes `mcp.servers.harness` (with the reference) and merged `permissions` → runtime loads config → on connect `KeteMcpSecrets.prepare` checks the binding, reads the store and puts the key only in the child's env, spawning it in `<data>/mcp-servers/harness`. `kete mcp add slack` → client ID → `edit` → (online) `client.location.reload` → `resolveIntegration` → `integration.oauth.connect` → print/open URL → poll status (10 min cap).

## Data and APIs used
- Upstream config: `mcp.servers` (`schema/src/mcp.ts` `LocalConfig`/`RemoteConfig`/`OAuthConfig`), top-level `permissions` (`schema/src/config.ts:55`).
- `kete.integrations.slack.clientId` (`schema/src/config/kete.ts:94`; protocol and client regenerated).
- Sync v1 `integrations` (optional, `Schema.Unknown`, `util/src/kete/sync/contract.ts:148`) — being added by kete-code-platform's Slack task.
- Local server API via `@opencode/client`: `location.reload`, `mcp.list`, `integration.get`, `integration.oauth.connect/status`.

## Rules that must not break
- Never write `@latest` or an unpinned Harness version.
- The Harness key never reaches config, stdout/stderr, logs or errors (`cli/test/kete/mcp-preset.test.ts` checks every output and file); errors name entries, never values.
- Write/execute tools stay `ask` even with `--write`; unknown preset tools fall under the catch-all `ask`.
- Preset flags on a non-preset `mcp add` are an error, never ignored (`route`).
- Only `mcp:` secret entries resolve, only to the server named after the entry, only when the definition's fingerprint matches the stored one; never to remote servers, args, URLs or headers.
- Errors about secrets name the server and entry, never the value.
- A user's stricter or narrower permission rule on a preset action survives `kete mcp add` re-runs.

## Testing
- `bun run test ./test/kete/mcp-presets.test.ts` in `packages/core` (AC1 expansion + schema + rule evaluation, merge keeping user rules, secret binding refusals, `prepare` cwd, AC4 offline).
- `bun test ./test/kete/mcp-preset.test.ts` in `packages/cli` (AC2, AC3, AC4, routing, listing, config-file client ID).
- `bun test ./test/kete/mcp-secret.test.ts` in `packages/util` (store/fallback, no secret in errors, sync `integrations`).

## Changes
- New preset: add it to `catalogue`, an expansion function with validation, tool lists and `detect`; a flow in `mcp-preset.ts` (`allowed` flags map); flags in `mcpPresetParams`; docs in `docs/integrations/`; tests in the three files above.
- docs/upstream-patches.md "MCP presets (feature/mcp-presets)" lists the four marked upstream files.

## Gotchas
- `KeteSecretStore`'s Keychain label reads "Kete Code account key" and its file fallback is named `account-key-mcp_<server>` — shared module wording, not a different secret.
- Slack's tool names come from its published list and may change; anything unlisted asks.
- Upstream's MCP OAuth listens on a random port unless `redirect_uri`/`callback_port` is set; the Slack preset pins `http://127.0.0.1:34561/callback` so the Slack app can list it.
- `{env:HARNESS_API_KEY}` (non-TTY path) is substituted at config load, in any config file (a project's too, into any field), so it is visible to the config API like any `{env:}` value; the stored-secret path is not.
- One fingerprint per entry: only the last-added `harness` definition gets the key; a hand edit (or a global/project merge that changes it) refuses the server until `kete mcp add harness` is re-run.
- `core/test/kete/job-fs-sites.test.ts` classifies `mcp-secrets.ts` as `data-dir` (it creates the isolated cwd).
