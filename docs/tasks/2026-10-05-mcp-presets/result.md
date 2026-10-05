# Result: Built-in MCP presets for Harness and Slack

## What changed
- `packages/schema/src/kete/mcp-presets.ts` (new): catalogue, Harness/Slack expansions validated against `Mcp.ServerConfig`/`Permission.Ruleset`, tool lists and rules, `detect`, `offlineMessage`, `mergePermissions`. Harness pinned to `harness-mcp-v2@3.2.32`.
- `packages/util/src/kete/mcp-secret.ts` (new): `{kete-secret:mcp:<name>}` references, save/read through `KeteSecretStore` (OS store, then `<data>/mcp-secrets/` file), `resolve` (only `mcp:` entries).
- `packages/util/src/kete/sync/contract.ts` + `sync/integrations.ts` (new): optional `integrations` field kept through decoding; `slackClientId` reads `integrations.slack.client_id` leniently.
- `packages/schema/src/config/kete.ts`: `kete.integrations.slack.clientId`; `protocol/openapi.json` and `client/src/promise/generated/types.ts` regenerated.
- `packages/core/src/kete/mcp-secrets.ts` (new) and `core/src/mcp/client.ts` (marked): stored secrets resolved into a local server's environment at spawn.
- `packages/core/src/kete/offline.ts`: `skip` disables the network-bound presets too and logs the message once per distinct set.
- `packages/cli/src/kete/mcp-preset.ts`, `mcp-preset-io.ts`, `mcp-presets-command.ts` (new); `cli/src/kete/commands.ts` (flags + `presets` spec).
- Upstream (marked, recorded in docs/upstream-patches.md "MCP presets"): `cli/src/commands/commands.ts`, `cli/src/commands/handlers/mcp/add.ts`, `cli/src/index.ts`, `core/src/mcp/client.ts`.
- Docs: `docs/integrations/harness.md`, `docs/integrations/slack.md`, `.github/README.md` "Integrations".
- Tests: `core/test/kete/mcp-presets.test.ts` (17), `cli/test/kete/mcp-preset.test.ts` (20), `util/test/kete/mcp-secret.test.ts` (7).

## Checks
| Check | Result |
|---|---|
| core `bun run test ./test/kete/mcp-presets.test.ts` | PASS 17/17 |
| cli `bun test ./test/kete/mcp-preset.test.ts` | PASS 20/20 |
| util `bun test ./test/kete/mcp-secret.test.ts` | PASS 7/7 |
| core `bun run test ./test/kete` | PASS 387, 11 skip, 0 fail |
| cli `bun test ./test/kete` | PASS 252, 1 skip, 0 fail |
| util `bun test ./test/kete` | PASS 265, 14 skip, 0 fail |
| typecheck util, schema, core, cli | PASS |
| protocol + client `bun run generate`; `check:generated` (both) | PASS |
| root `bun run lint` | PASS (0 warnings, 0 errors) |
| `upstream:check` | PASS |
| `stale-cards.mjs` / `card-check.mjs` | all current / clean |
| Manual (source CLI, throwaway HOME): `mcp presets`, `mcp add slack` without ID, `mcp add docs --write --url …` (refused), `mcp add harness` non-TTY with `HARNESS_API_KEY` | as expected |

Not run: the packages' full suites (`verify --base main`) and a live Harness/Slack connection (no account or approved Slack app here).

## Acceptance criteria
- [x] AC1 — `mcp-presets.test.ts` "Harness preset"/"Slack preset": expansion decodes with the config `Info` schema, exact pin, `HARNESS_READ_ONLY=true`, rules evaluated with `Permission.evaluate` over a `*: allow` base.
- [x] AC2 — `mcp-preset.test.ts` "kete mcp add harness": fake secret store holds the key; config has `{kete-secret:mcp:harness}`; the key appears in no file or output (also on store failure); `--write` → `HARNESS_READ_ONLY=false`, write tools still `ask`. Spawn-time resolution in `mcp-presets.test.ts` "KeteMcpSecrets.resolve".
- [x] AC3 — "kete mcp add slack": remote entry with `oauth.client_id` (+ pinned `redirect_uri`), sign-in started; client-ID precedence flag → config → sync; no ID → Slack app explanation, exit 2, nothing written.
- [x] AC4 — `mcp-presets.test.ts` "offline mode (AC4)": both presets disabled, other stdio left alone, message checked; CLI offline paths write config, print the skip note, Slack skips the sign-in; `kete mcp presets` marks them skipped.
- [x] AC5 — docs and checks above.

## Deviations and known limits
- Catalogue lives in `packages/schema/src/kete/mcp-presets.ts`, not `core/src/kete/`: the CLI can't depend on core, and schema has the config schemas for validation.
- Secret reference is a new Kete mechanism (`{kete-secret:mcp:…}`) resolved at spawn with one marked upstream line, rather than `ConfigVariable` substitution (which would expose the value through the config API).
- Without a TTY, `kete mcp add harness` uses `{env:HARNESS_API_KEY}` when that variable is set (the spec's alternative), else refuses.
- Offline: `kete mcp add` still writes config (no network needed) and says the server is skipped; the runtime skips it.
- Slack: its authorization server advertises only `client_secret_post`. The preset writes the client ID and no secret (PKCE public client); if Slack rejects the exchange the app needs PKCE enabled, else the platform's planned server-side token exchange. Documented in docs/integrations/slack.md.
- Slack tool names come from Slack's published list (`slack_send_message`, `slack_search_public`, …); names for reactions, channel creation and lists aren't published, so they fall under the catch-all `ask`.
- The redirect is pinned to `http://127.0.0.1:34561/callback` so the Slack app can list it (upstream's default port is random).
- `kete.integrations.slack.clientId` is camelCase as specified (other `kete` keys use snake_case).
- Sync `integrations` is `Schema.Unknown` until the platform's contract ships; recorded in contracts.md §2.

## Cards updated
New `mcp-presets` card + INDEX row; quick answers in `cli`, `config-kete`, `local-models`, `sync`, `server-sdk`, `account-login`; `subagents` and `workflows` re-verified (shared `schema/src/config/kete.ts`); contracts.md §2 pending `integrations` field. All bumped to `4e26b57120`.

## Metrics
- Agents used: one build agent
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~2 h
