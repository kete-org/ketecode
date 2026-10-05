# Spec: Built-in MCP presets for Harness and Slack

- Task: `docs/tasks/2026-10-05-mcp-presets` · Size: medium · Created: 2026-10-05
- Status: agreed (user pre-approved all recommendations, 2026-10-04)

## Goal
Let the agent read and act on Harness and Slack from a session with one command, safe by default:
read-only unless the user opts in, every write behind Kete's permission prompt, credentials never in
plain config or logs.

## Scope (modules: core MCP config, cli `mcp` command, config-kete)
1. **Preset catalogue** (Kete-owned, `core/src/kete/mcp-presets.ts`): named templates that expand to
   normal MCP server config entries (upstream's MCP config format, so nothing new at runtime).
   - **harness**: local stdio server `npx -y harness-mcp-v2@<pinned exact version>` (MIT, official,
     github.com/harness/mcp-server). Env: `HARNESS_API_KEY` from the OS secret store
     (Kete's secret-store module) or `{env:HARNESS_API_KEY}`; optional `HARNESS_BASE_URL`
     (self-managed Harness), `HARNESS_ORG`, `HARNESS_PROJECT`, `HARNESS_TOOLSETS`.
     **`HARNESS_READ_ONLY=true` by default**; `--write` opts in. Permission rules added with the
     preset: `harness_create`, `harness_update`, `harness_delete`, `harness_execute` → `ask`
     (even with `--write`); read tools `allow`.
   - **slack**: remote server `https://mcp.slack.com/mcp` with OAuth (upstream's remote-MCP OAuth),
     using a configurable Slack app client ID (`kete.integrations.slack.clientId`, or the Kete Slack
     app's ID once it exists — Slack only allows Marketplace or internal apps and a workspace admin
     must approve). Permission rules: sending, posting, reacting, creating channels/canvases,
     uploading → `ask`; search/read → `allow`.
2. **CLI:** `kete mcp add harness [--write] [--org X --project Y] [--base-url URL]` prompts for the
   API key (hidden input) and stores it in the OS secret store; `kete mcp add slack [--client-id ID]`
   then runs the OAuth sign-in. `kete mcp presets` lists presets. Works in VS Code/JetBrains through
   the same runtime.
3. **Offline mode:** presets that need the network are skipped with a clear message (they are
   remote or reach the internet).
4. **Docs:** `docs/integrations/harness.md` and `docs/integrations/slack.md` (create a Harness PAT
   with least privilege; Slack app requirements and admin approval), README links.

## Out of scope
- Harness pipeline step, triggers, Harness Code repos; Slack notifications/commands/approvals
  (platform) — separate tasks.

## Acceptance criteria
- [ ] AC1: Preset expansion produces valid MCP config (schema-validated) with the pinned Harness
  version, read-only default, and the permission rules above (unit tests).
- [ ] AC2: `kete mcp add harness` stores the key in the secret store (never in config or logs;
  config references it) and `--write` flips read-only off but keeps writes on `ask` (tests with a
  fake secret store).
- [ ] AC3: `kete mcp add slack` writes the remote entry with the client ID and starts OAuth; without
  a client ID it explains the Slack app requirement (tests).
- [ ] AC4: Offline mode skips both presets with the message (test).
- [ ] AC5: Docs; typecheck, tests, lint, `upstream:check`.

## Risks
- Supply chain: the Harness server runs via npx — pin an exact version and document upgrading it;
  never `@latest`.
- Slack: usable only after a Kete Slack app (internal or Marketplace) exists and an admin approves.
