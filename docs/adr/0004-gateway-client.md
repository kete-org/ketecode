# 0004. Gateway client uses the gateway's native routes

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The runtime needs a client for the Kete Model Gateway (`CLAUDE.md` §3: "gateway (Kete
Model Gateway, configured as an OpenAI-compatible provider)"). The gateway in
`kete-code-platform` was built differently: its ADR 0001 makes it a thin native
passthrough with no translation. Each provider keeps its own API under its own prefix
(`/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`, `/compat/{provider}/v1`), and
`GET <prefix>/models` returns the Kete allowlist for that provider. There is no
OpenAI-format unified API, so treating the gateway as one OpenAI-compatible provider
would only reach OpenAI-format routes.

Configuring the built-in `anthropic` and `openai` providers with the gateway's base URL
works, but lists every catalog model, most of which the gateway rejects, and needs one
override per provider.

## Decision

The runtime's gateway client is a Kete-owned provider plugin, `kete`
(`packages/core/src/kete/gateway.ts`):

- It discovers models from each route's `GET <prefix>/models` and offers only those.
- Each model reuses its source provider's catalog definition (package, limits,
  capabilities, canonical provider) and sets its base URL to the matching gateway route,
  so requests use that provider's native API and SDK.
- The gateway URL comes from `providers.kete.settings.baseURL` or `KETE_GATEWAY_URL`. The
  Kete API key comes from `kete auth login`, `providers.kete.settings.apiKey`, or
  `KETE_GATEWAY_KEY`. Without a URL the plugin does nothing, so the gateway is never a
  dependency for local use.
- With a platform URL (`kete.platform.url` or `KETE_PLATFORM_URL`), gateway models take
  their prices from the platform's `GET /api/v1/models` instead of the catalog, so session
  cost reflects what Kete charges. Without the platform, or while it's unreachable, models
  keep catalog (or last known) prices; availability never depends on the platform. The
  platform's `GET /api/v1/me` balance is published as the `kete` integration's metadata
  for clients to display (the TUI shows it in the session sidebar).
- Routing, fallback, budgets and policy stay in the gateway (`docs/architecture.md` §36).

This supersedes the "configured as an OpenAI-compatible provider" wording in `CLAUDE.md`
§3.

## Consequences

- Users pick gateway models as `kete/<model>` and see only models they can use.
- The client knows the gateway's route table (four prefixes, and the compat provider IDs
  `deepseek` and `openrouter`). A new gateway provider needs a matching entry in
  `routes`; if the gateway later publishes its route table, discover it instead.
- The first discovery is awaited when the gateway plugin starts (each route request times
  out after 5 seconds), so a command run right after the service starts can use gateway
  models. An unreachable gateway can delay startup by up to that timeout. Later
  refreshes run in the background.
- If the gateway ever adds a unified OpenAI-format API, revisit this ADR.
