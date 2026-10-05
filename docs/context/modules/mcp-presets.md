---
module: mcp-presets
paths: [packages/schema/src/kete/mcp-presets.ts, packages/util/src/kete/mcp-secret.ts, packages/util/src/kete/sync/integrations.ts, packages/core/src/kete/mcp-secrets.ts, packages/cli/src/kete/mcp-preset.ts, packages/cli/src/kete/mcp-preset-io.ts, packages/cli/src/kete/mcp-presets-command.ts]
verified-at: 4e26b57120
---
## Quick answers
- What is a preset? A named template that expands to an ordinary upstream `mcp.servers` entry plus top-level `permissions` rules (`schema/src/kete/mcp-presets.ts:147` `harness`, `:183` `slack`). `kete mcp add <preset>` writes both into the same file upstream's `kete mcp add` writes; nothing about a preset exists at runtime.
- Why is the catalogue in `@opencode/schema`, not core? The CLI doesn't depend on core, and both the CLI (writes the expansion) and core (offline skip) need it; schema also has the `Mcp.ServerConfig`/`Permission.Ruleset` schemas the expansion is validated with.
- Which Harness version runs? An exact pin, `harnessVersion` (`mcp-presets.ts:26`), as `npx -y harness-mcp-v2@<pin>`; never `@latest`. Upgrading = change the pin, run the tests, re-run `kete mcp add harness` (docs/integrations/harness.md).
- How are MCP tool permissions named? `<server>_<tool>` (`core/src/tool/mcp.ts:17`; `action` at `mcp-presets.ts:35` mirrors it). Harness tools already start with `harness_`, so rules read `harness_harness_create`. Rules: catch-all `<server>_*` ask, known reads allow, known writes ask (last match wins, `core/src/permission.ts:86`).
- How does config refer to a stored secret? `{kete-secret:mcp:<server>}` as a whole `environment` value (`util/src/kete/mcp-secret.ts:28`). `core/src/mcp/client.ts:207` (marked) resolves it at spawn via `core/src/kete/mcp-secrets.ts:17`; only `mcp:` entries resolve (`mcp-secret.ts:90`), so config can't name the account key. Not `ConfigVariable` (`{env:}`/`{file:}`), which substitutes into the config the config API returns.
- Where is the secret stored? `KeteSecretStore` (OS store, then `<data>/mcp-secrets/` file fallback), entry `mcp:<server>`, service `kete-code` (`mcp-secret.ts:48`).
- Where does `kete mcp add slack` get the client ID? `--client-id`, then `kete.integrations.slack.clientId` (project then global config files, `cli/src/kete/mcp-preset-io.ts:33`), then the sync cache's `integrations.slack.client_id` (`util/src/kete/sync/integrations.ts`), else it explains the Slack app requirement and exits 2.
- Does Slack sign-in need a client secret? Slack's metadata lists only `client_secret_post`; the preset writes `client_id` + a pinned `redirect_uri` and no secret (upstream's `oauth.ts` then uses PKCE with `token_endpoint_auth_method: "none"`). The platform's server-side token exchange is the planned fallback (docs/integrations/slack.md).
- What does offline mode do? `KeteOffline.skip` (`core/src/kete/offline.ts:94`) disables remote servers and any local server `KeteMcpPresets.detect` recognises, and the plugin logs `offlineMessage` once per distinct set. The CLI still writes config offline and says the server is skipped; Slack skips the sign-in.

## Purpose
Built-in MCP presets for Harness and Slack (docs/tasks/2026-10-05-mcp-presets): one command connects a session to them, read-only or ask-first by default, with credentials in the OS secret store, never in config or logs.

## Entry points
- `kete mcp add <name>` — upstream handler `cli/src/commands/handlers/mcp/add.ts:27-42` (marked) calls `KeteMcpPreset.route` (`cli/src/kete/mcp-preset.ts:72`) and, for a preset, `KeteMcpPreset.add` (`:93`) with `KeteMcpPresetIO.make` (`mcp-preset-io.ts:98`).
- `kete mcp presets` — `cli/src/kete/mcp-presets-command.ts` → `KeteMcpPreset.list` (`mcp-preset.ts:246`); spec `KeteCommands.mcpPresets` (`cli/src/kete/commands.ts:61`), flags `mcpPresetParams` (`:43`), spread into upstream's `mcp` spec (`cli/src/commands/commands.ts:229,232`), handler `cli/src/index.ts:56`.
- Runtime: `core/src/mcp/client.ts:207` (spawn-time secret resolution), `core/src/kete/offline.ts:94` (skip).

## Key files
| File | Role |
| --- | --- |
| `packages/schema/src/kete/mcp-presets.ts` | Catalogue, tool lists, `harness`/`slack` expansions (validated), `permissions`, `detect`, `offlineMessage`, `mergePermissions` |
| `packages/util/src/kete/mcp-secret.ts` | `entry`/`reference`/`parse`, `stores`, `save` (pre-checks `storable`), `read`, `resolve` |
| `packages/util/src/kete/sync/integrations.ts` | `slackClientId(response)` — lenient reader of the sync response's `integrations` |
| `packages/core/src/kete/mcp-secrets.ts` | Effect wrapper over `KeteMcpSecret.resolve` with the real stores |
| `packages/cli/src/kete/mcp-preset.ts` | Flows over an injected `IO`: `route`, `add` (Harness/Slack), `edit` (JSONC write keeping comments), `list` |
| `packages/cli/src/kete/mcp-preset-io.ts` | Real IO: clack `password`, secret store, config/sync reads, sign-in (reload, OAuth connect, bounded poll) |

## Data flow
`kete mcp add harness` → flags validated → hidden prompt (or `HARNESS_API_KEY` → `{env:}` without a TTY) → `KeteMcpSecret.save` → `edit` writes `mcp.servers.harness` (with the reference) and merged `permissions` → runtime loads config → on connect `KeteMcpSecrets.resolve` reads the store and puts the key only in the child's env. `kete mcp add slack` → client ID → `edit` → (online) `client.location.reload` → `resolveIntegration` → `integration.oauth.connect` → print/open URL → poll status (10 min cap).

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
- Only `mcp:` secret entries resolve.

## Testing
- `bun run test ./test/kete/mcp-presets.test.ts` in `packages/core` (AC1 expansion + schema + rule evaluation, spawn-time resolution, AC4 offline).
- `bun test ./test/kete/mcp-preset.test.ts` in `packages/cli` (AC2, AC3, AC4, routing, listing, config-file client ID).
- `bun test ./test/kete/mcp-secret.test.ts` in `packages/util` (store/fallback, no secret in errors, sync `integrations`).

## Changes
- New preset: add it to `catalogue`, an expansion function with validation, tool lists and `detect`; a flow in `mcp-preset.ts` (`allowed` flags map); flags in `mcpPresetParams`; docs in `docs/integrations/`; tests in the three files above.
- docs/upstream-patches.md "MCP presets (feature/mcp-presets)" lists the four marked upstream files.

## Gotchas
- `KeteSecretStore`'s Keychain label reads "Kete Code account key" and its file fallback is named `account-key-mcp_<server>` — shared module wording, not a different secret.
- Slack's tool names come from its published list and may change; anything unlisted asks.
- Upstream's MCP OAuth listens on a random port unless `redirect_uri`/`callback_port` is set; the Slack preset pins `http://127.0.0.1:34561/callback` so the Slack app can list it.
- `{env:HARNESS_API_KEY}` (non-TTY path) is substituted at config load, so it is visible to the config API like any `{env:}` value; the stored-secret path is not.
