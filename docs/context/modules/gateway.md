---
module: gateway
paths: [packages/core/src/kete/gateway.ts, packages/tui/src/kete/balance.tsx]
verified-at: 6d8972321a
---
## Quick answers
- What is pinned for a job key? The gateway requires `x-kete-agent-id` for job keys (ADR 0020 rule 9, else 403); the runtime sends it only for a synced managed agent (sync plugin, `sync` card), so job mode syncs first and requires `spec.agent` (`job-mode` card). Platform job keys are not built on the platform yet.
- Where is the job-mode URL rule? `KeteJobMode.endpoints` over `KeteHttpURL.normalize` in util (`job-mode.ts:97`, `http-url.ts`), used at `gateway.ts:453-455`; `urlVariable`/`platformVariable` (`:48-50`) are the util constants. It moved out of core because the CLI can't import core.
- What is the `kete` provider? A Kete-owned model-provider plugin (`gateway.ts:45` `providerID`) that offers only the models the Kete Model Gateway allows, each on the gateway's native per-provider route.
- Where does the key (and URL) come from in job mode? Since piece A1 (user decision D2): **only**
  the job's descriptor key — `kete job run` reads `KETE_JOB_GATEWAY_KEY_FD`, passes it to its
  `kete serve` child on fd 3, which stores it in `KeteJobSecrets.setGatewayKey` (in memory,
  write-once, `util/src/kete/job-secrets.ts:133-145`). `make` reads it via `options.jobKey ??
  KeteJobSecrets.gatewayKey` and checks `KeteJobMode.enabled(environment)` (`gateway.ts:153-154`);
  `load` then skips the account entirely (`:172-173`) and `configured(..., { key })` returns that
  key with URL/platform **only** from `OPENCODE_GATEWAY_URL`/`OPENCODE_PLATFORM_URL` (the
  entrypoint's `KETE_GATEWAY_URL`/`KETE_PLATFORM_URL`, `:447-455`). Ignored in job mode: account
  files, a `kete auth login` integration credential (`:225-226`), `providers.kete.settings.apiKey`
  and `baseURL`, `kete.platform.url`, and `KETE_GATEWAY_KEY` (also deleted from env by the CLI). So
  every model call is metered on the job's key. No key → no requests, no provider.
- What is the single key-resolution point, and what environment does it see? `configured`
  (`gateway.ts:434-467`); `make({ environment })` captures `process.env` (default) at plugin
  construction, and tests pass `environment`/`account`/`jobKey` instead (`:138-154`).
- Does job mode (`KETE_JOB_MODE`) change what this plugin publishes? Only the key/URL source (above);
  discovery and publishing are unchanged. Job mode's own plugin (`core/src/kete/job-plugin.ts`) removes every model
  whose provider isn't `providerID` (`gateway.ts:45`) from the already-published list, and a
  separate `RequestExecutor` replacement (`core/src/kete/job-request.ts`) checks/rewrites every
  outgoing request per `routes` (`gateway.ts:105-136`, matched by route **path**, not model name) —
  function tools only, one candidate, an output-token clamp from `KETE_JOB_MAX_OUTPUT_TOKENS`,
  `store: false` and no provider-side state for Responses, inline content only. Full contract: the
  `job-mode` card.
- Where does the `kete` provider's catalog data come from in a job? From the bundled models.dev snapshot: job mode disables the periodic models.dev fetch (`KETE_DISABLE_MODELS_FETCH=1`, `job-mode` card), so a gateway model newer than the shipped `kete`'s snapshot has no catalog entry there.
- Where do gateway model prices come from? The platform's `GET /api/v1/models`, only when a platform URL is configured (`gateway.ts:271-302`).
- Where does the TUI show account balance? `packages/tui/src/kete/balance.tsx`, reading the `kete` integration's metadata.

## Purpose
Discovers which models a configured Kete Model Gateway allows (one native route per source provider), publishes them as the `kete` provider with gateway-adjusted base URLs and platform pricing, and surfaces the account's credit balance in the TUI sidebar. Implements ADR 0004: no unified OpenAI-format gateway API exists, so each model reuses its source provider's catalog definition and SDK.

## Entry points
- `packages/core/src/kete/gateway.ts:138` `make(options)` — builds the plugin (`gateway.ts:427` exports the default instance as `Plugin`).
- Registered in `packages/core/src/plugin/internal.ts:270` (`KeteGateway.Plugin`, in `pre`, after the catalog and provider plugins — see Gotchas).
- `packages/tui/src/kete/balance.tsx:62` default-exports a TUI `Plugin.define` registered in `packages/tui/src/plugin/builtins.ts:7,21` (after `SidebarContext`).

- Which wire protocol does each gateway route speak (not previously mapped anywhere)? `routes`
  (`gateway.ts:105-136`) publishes one native per-provider route each, and the wire protocol is a
  property of the *route*, not something this file states directly: `/anthropic/v1` speaks Anthropic
  Messages; `/openai/v1` speaks OpenAI Responses (`…/responses`) or Chat Completions
  (`…/chat/completions`) depending on path; `/compat/{deepseek,openrouter}/v1` speak OpenAI Chat
  Completions (with openrouter's own extras); `/gemini/v1beta` speaks Gemini's `generateContent`/
  `streamGenerateContent`. Transport is a separate axis from protocol: it comes from
  `provider.settings.transport` (`core/src/model-resolver.ts:392`), and only the `openai` provider
  defaults to WebSocket (`core/src/plugin/provider/openai.ts:260`) — every `kete`-routed model uses
  HTTP. `core/src/kete/job-request.ts`'s `family(url)` is the first place this mapping is made
  explicit in code, for job mode's own request-conformance checks — see the `job-mode` card.

## Key files
- `gateway.ts:105-136` `routes` — the gateway's four route prefixes (`/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`, `/compat/{deepseek,openrouter}/v1`) mapped to catalog provider IDs, auth header shape, and response parser.
- `gateway.ts:232-269` `discover` — calls `GET <prefix>/models` per route (5s timeout, concurrency = route count); a route's failure keeps its last known models, only a total failure fails discovery.
- `gateway.ts:271-302` `pricing` — `GET <platform>/api/v1/models`, mapped by `route.prefix + model_id`.
- `gateway.ts:304-318` `me` — `GET <platform>/api/v1/me`, mapped to `{balance_micros, currency, organization}`.
- `gateway.ts:434-467` `configured` — resolves URL/key/platform: in job mode the descriptor key + env URLs only (`:447-455`); otherwise signed-in account (`KeteAccount`) wins over `providers.kete.settings.{baseURL,apiKey}` wins over `KETE_GATEWAY_URL`/`KETE_GATEWAY_KEY`/`KETE_PLATFORM_URL`.
- `balance.tsx:14-22` `account()` — parses integration metadata into a display shape; `balance.tsx:12` `lowBalanceMicros` (1,000,000, i.e. $1) is the low-balance warning threshold.

## Data flow
Plugin start → `load()` resolves gateway URL/key/platform (account > config > env; job mode: descriptor key + env URLs) → `refresh()` discovers models per route and (if platform configured) fetches prices → `ctx.provider.transform` publishes each discovered model under `providerID` with `baseURL` set to `${gatewayURL}${route.prefix}` and catalog fields copied from the source provider (`gateway.ts:204-218`) → separately, `balance()` polls `GET /api/v1/me` every `balanceInterval` (default 1 minute) and writes the result onto the `kete` integration's `metadata` via `ctx.integration.transform` (`gateway.ts:186-193`, `321-329`) → TUI's `KeteBalance` component reads that metadata off `context.data.location.integration.list(...)` per session and renders it in the sidebar (`balance.tsx:24-33`).

## Data and APIs used
- Gateway native routes: `GET <prefix>/models` per `routes` entry (`gateway.ts:105-136`).
- Platform API: `GET /api/v1/models` (pricing, micro-USD per million tokens) and `GET /api/v1/me` (balance/currency/organization) — kete-code-platform's versioned API, never the database (CLAUDE.md §3).
- Config: `providers.kete.settings.{baseURL,apiKey}`, `kete.platform.url`; env fallbacks `KETE_GATEWAY_URL`, `KETE_GATEWAY_KEY`, `KETE_PLATFORM_URL` (env bridge renames `KETE_*` to `OPENCODE_*` before plugins run — `gateway.ts:25,47-49`).
- Account store: `@opencode/util/kete/account` (`KeteAccount.read`/`.key`) for `kete login` credentials, which take precedence over hand configuration.

## Rules that must not break
- Without a gateway URL the plugin does nothing (`gateway.ts:195-197`) — the gateway must never become a hard dependency for local use (CLAUDE.md §3, ADR 0004).
- Outside job mode, a signed-in account's URL/key/platform always wins over hand configuration (`gateway.ts:226,440-446`).
- In job mode the descriptor key is the only key and the env vars the only URL source (D2, `gateway.ts:172-173,447-455`); never read an account, an integration credential or config there, and never put the key into `process.env`.
- Routing, fallback, budgets and policy stay in the gateway itself, not this client (ADR 0004 Decision, last bullet).
- One route's outage must not drop the others' models or discard last-known inventory (`gateway.ts:230-231,244-261`).
- Model availability must never depend on the platform being reachable; only pricing does (`gateway.ts:337-346`, ADR 0004).

## Testing
- `bun run test ./test/kete/gateway.test.ts` inside `packages/core/` (includes the job-mode cases:
  `configured` with `job` ignores config URLs/keys, the plugin uses only `jobKey` with an account and
  config key present, a config-only baseURL makes no requests) (isolates HOME/XDG — don't bypass with bare `bun test`, CLAUDE.md §8).
- `bun test ./test/kete/balance.test.tsx` inside `packages/tui/`.

## Changes
- `docs/tasks/2026-10-01-job-socket-server/` — job-mode key/URL sources (D2 and the review fix that
  restricted URLs to the entrypoint's env).
- docs/upstream-patches.md "Gateway client" — upstream edit: `core/src/plugin/internal.ts` registers `KeteGateway.Plugin` after the catalog (`ModelsDevPlugin`) and provider plugins; keep it there on reorder.
- docs/upstream-patches.md "Credit balance" — `packages/plugin/src/effect/integration.ts:8` adds `metadata?` to the plugin-facing `IntegrationRef` type (core already stored/published it); `packages/tui/src/plugin/builtins.ts` registers `KeteBalance` after `SidebarContext`.
- docs/adr/0004-gateway-client.md — full rationale for native per-route passthrough over a unified OpenAI-compatible route.

## Gotchas
- The platform names Gemini `"gemini"`; the catalog calls it `"google"` — `platformRoute` (`gateway.ts:88-89`) translates for pricing lookups only.
- `first` discovery is awaited at plugin start (bounded by the 5s per-route timeout), so an unreachable gateway can delay CLI/TUI startup by up to that timeout; later refreshes (`interval`, default 5 minutes) run in the background with a 2/4/8s retry backoff on initial failure (`gateway.ts:359-384`).
- `balance` reload only fires when the fetched value actually changed (`JSON.stringify` compare, `gateway.ts:326`), to avoid unnecessary `ctx.integration.reload()` churn.
- `me`/`pricing`/`discover` all silently keep last-known state on failure/timeout rather than surfacing an error to the user — intentional per ADR 0004, not a swallowed-error violation.
