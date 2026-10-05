# Handoff: Built-in MCP presets for Harness and Slack

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-05 build agent
- Done: spec scope 1–4, all ACs; see result.md.
- Decisions: catalogue in `@opencode/schema` (CLI can't import core); `{kete-secret:mcp:<name>}` resolved at spawn (marked line in `core/src/mcp/client.ts`); Slack redirect pinned to `127.0.0.1:34561`; offline `mcp add` writes config and says it's skipped.
- Open: Slack's token endpoint advertises only `client_secret_post` — verify with a real PKCE-enabled internal app, else the platform's server-side token exchange; copy the platform's `integrations` contract into docs/platform/sync-v1.md and tighten the schema when it ships.
