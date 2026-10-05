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
- `packages/kete-tools/src/lib.ts`: `docs/integrations/` counts as Kete-owned for `upstream:check` (+ test).
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
| `upstream:check` | PASS (after adding `docs/integrations/` to `isKeteOwned`) |
| kete-tools `bun run typecheck`, `bun run test` | PASS (59) |
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

## Security review fixes
Commit `8421b4e431` (`fix(mcp)`), after a security review BLOCKER: a project's `.kete/` config could exfiltrate the stored Harness key (any server could reference `{kete-secret:mcp:harness}`, or redefine `harness` with another command or `HARNESS_BASE_URL`).

- Binding: the secret store now holds `kete-mcp-v1:<sha256>:<secret>` for `mcp:<server>`; the fingerprint is SHA-256 over canonical JSON of name, `local`, command, cwd, every non-reference environment entry (keys and values) and the keys holding references (`util/src/kete/mcp-secret.ts` `fingerprint`, `encode`/`decode`, `save(…, definition)`). `kete mcp add harness` binds it to exactly the server entry it writes.
- Release: `resolve` gives the secret only to a local server whose name owns the entry (`mcp:<that server>`) and whose current definition has the stored fingerprint; a value without a fingerprint is never released. Otherwise the server is refused: the error names the server and entry, never the value, and says to re-run `kete mcp add <server>`. References still resolve only as whole `environment` values (never args, URLs or headers).
- Config source (item 3): the merged config reaching `McpClient.connect` carries no per-server file origin, so project-only servers can't be singled out at spawn; the fingerprint is the guarantee (documented in harness.md, the card and the module header).
- Beyond the brief: a server that gets a stored secret now spawns in `<data>/mcp-servers/<name>` instead of the project (`core/src/kete/mcp-secrets.ts` `prepare`; marked block in `core/src/mcp/client.ts`). With the project as cwd, the genuine pinned `npx -y harness-mcp-v2@3.2.32` reads the repo's `.npmrc` (registry) and `node_modules` (a planted package of that version), and a server loading `.env` could pick up `HARNESS_BASE_URL`, each sending the key elsewhere without touching config. The preset also always writes `HARNESS_BASE_URL` (default `https://app.harness.io`). `job-fs-sites.test.ts` classifies `mcp-secrets.ts` as `data-dir`.
- Re-binding (item 4): re-running `kete mcp add harness` reuses the stored key (no prompt) and re-stores it with the new fingerprint; `--new-key` (new flag) asks for a new one.
- Permissions: `mergePermissions` returns `{ rules, replaced }`; for preset actions, a user's stricter rule (`deny`, or `ask` where the preset allows) or narrower-resource rule is kept and moved after the preset's rules (last match wins); an equal `*` rule is deduplicated; a user's `allow` where the preset asks is replaced and the CLI warns. An invalid `permissions` entry is now refused instead of silently dropped.
- Slack: prints `Slack app client ID: <id> (<source>)` (flag / project config <file> / global config <file> / synced from your organization) before writing and signing in.
- Docs: harness.md (binding, isolated cwd, `--new-key`, no integrity hash on the pin, `{env:}` expanded in any config — prefer the stored key, user rules kept); slack.md (client ID shown with its source); upstream-patches.md entry updated.

| Check | Result |
|---|---|
| util `bun test ./test/kete` | PASS 267, 14 skip, 0 fail (`mcp-secret.test.ts` 9) |
| core `bun run test ./test/kete` | PASS 396, 11 skip, 0 fail (`mcp-presets.test.ts` 26) |
| core `bun run test ./test/mcp.test.ts ./test/mcp-import-boundary.test.ts` | PASS 75 |
| cli `bun test ./test/kete` | PASS 258, 1 skip, 0 fail (`mcp-preset.test.ts` 26) |
| typecheck util, schema, core, cli | PASS |
| protocol + client `check:generated` | PASS (no schema change) |
| root `bun run lint` | PASS (0 warnings, 0 errors) |
| `upstream:check` | PASS |
| `stale-cards.mjs` / `card-check.mjs` | all current / clean (`mcp-presets`, `cli`, `account-login` → `8421b4e431`) |

Tests added for the review: foreign-command project server with the reference, `harness` with a swapped command, genuine command with a changed `HARNESS_BASE_URL`, an added env var, a config `cwd`, `mcp:harness` referenced from server `x` (with and without harness's own definition), a remote server, the genuine definition resolving, `prepare`'s isolated cwd; every refusal asserts the secret isn't in the message. CLI: key bound to the written definition, reuse + re-bind on `--org` re-run, `--new-key`, user deny/narrower rules surviving a re-run with a warning for a replaced allow, invalid permissions entry refused, Slack client ID and source printed before the write.

Not run: the packages' full suites (`verify --base main`); a live Harness/Slack connection.

## Cards updated
New `mcp-presets` card + INDEX row; quick answers in `cli`, `config-kete`, `local-models`, `sync`, `server-sdk`, `account-login`; `subagents` and `workflows` re-verified (shared `schema/src/config/kete.ts`); contracts.md §2 pending `integrations` field. All bumped to `4e26b57120`; `kete-tools-ci` to the tooling commit.

## Metrics
- Agents used: one build agent
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~2 h
