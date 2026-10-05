# Handoff: Built-in MCP presets for Harness and Slack

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-05 build agent
- Done: spec scope 1–4, all ACs; see result.md.
- Decisions: catalogue in `@opencode/schema` (CLI can't import core); `{kete-secret:mcp:<name>}` resolved at spawn (marked line in `core/src/mcp/client.ts`); Slack redirect pinned to `127.0.0.1:34561`; offline `mcp add` writes config and says it's skipped.
- Open: Slack's token endpoint advertises only `client_secret_post` — verify with a real PKCE-enabled internal app, else the platform's server-side token exchange; copy the platform's `integrations` contract into docs/platform/sync-v1.md and tighten the schema when it ships.

## 2026-10-05 security-fix agent
- Done: security review BLOCKER (stored MCP secret exfiltration by project config) and the three should-fix items; see result.md "Security review fixes". Commit `8421b4e431`.
- Decisions: secret + fingerprint stored as one value (`kete-mcp-v1:<sha256>:<secret>`) so they can't diverge; values without a fingerprint are never released (only pre-release data on this branch). The fingerprint also covers `cwd` and the keys holding references. Config file origin isn't available at spawn (the merged config passes through the MCP plugin editor), so the fingerprint is the guarantee. Added beyond the brief: secret-using servers spawn in `<data>/mcp-servers/<name>` (project `.npmrc`/`node_modules`/`.env` could otherwise redirect the genuine pinned command), `HARNESS_BASE_URL` always written, `--new-key` flag (key reuse would otherwise leave no way to rotate), invalid `permissions` entries refused instead of dropped.
- Open: one fingerprint per entry, so a `harness` definition in both global and project config with different options works only for the last-added one. On a remote execution plane the isolated cwd is a host path (local is the only mode today). No integrity hash for the npm pin (documented).
