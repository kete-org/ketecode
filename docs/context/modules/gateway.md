---
module: gateway
paths: [packages/core/src/kete/gateway.ts, packages/tui/src/kete/balance.tsx]
verified-at: 0ee47ec668
---
## Quick answers
- Which compat routes exist? `/compat/{deepseek,openrouter,nvidia,byteplus}/v1` (`gateway.ts:135-142`, one mapped entry per id, `Bearer` auth, OpenAI-style `GET /models` list), after `/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`. NVIDIA was added in #57, BytePlus with the platform-sync BytePlus task. Adding a compat provider = adding its id to that array; if models.dev has no such provider, also set the optional `Route.package` (`:60`, as `:141` does for byteplus).
- How does a discovered model get its SDK package? From the catalog, never from the gateway: in `ctx.provider.transform` (`gateway.ts:212-229`) the model is cloned from the source provider's catalog model (`route.catalog`, same model id) when one exists, and `model.package = base?.package ?? origin?.provider.package ?? item.route.package` (`:223`): the catalog model's package, else the catalog provider's, else the route's own fallback (set only for byteplus). A model whose provider is missing from the loaded catalog and whose route has no `package` (e.g. newer than the bundled models.dev snapshot in a job) gets no `package`.
- Which `package` string should a compat provider that is not in the models.dev catalog use, and where is the `Route` type? `@ai-sdk/openai-compatible` (as byteplus does, `gateway.ts:141`); `aisdk-native.ts:67` maps it natively and the model service rewrites it to `@opencode/ai/providers/openai-compatible`. `Route` is the type at `gateway.ts:55-62` (`package?` at `:60-61`).
- What happens to a gateway model with no package? It is still published, but `ModelResolver.resolve` skips it when choosing a default: with no requested model it uses `models.default()` only if `hasPackage` (`core/src/model-resolver.ts:348`), else the first available model with a package (`:402-407`). Requested explicitly, it fails with `UnsupportedPackageError` (package "unknown", `model-resolver.ts:219-220,316-321`).
- What does the gateway do offline? `core/src/kete/gateway.ts:167` `offline()` = `KeteOffline.active(config, environment)` (env flag or `kete.offline` as loaded now), checked at the start of every `balance` (`:330`) and `refresh` (`:341`) tick: no models, balance or price requests while on, resumed on the next tick when off. Models already loaded are removed by `KeteOffline`'s model filter.
- What is pinned for a job key? The gateway requires `x-kete-agent-id` for job keys (ADR 0020 rule 9, else 403); the runtime sends it only for a synced managed agent (sync plugin, `sync` card), so job mode syncs first and requires `spec.agent` (`job-mode` card). Platform job keys are not built on the platform yet.
- Where is the job-mode URL rule? `KeteJobMode.endpoints` over `KeteHttpURL.normalize` in util (`job-mode.ts:97`, `http-url.ts`), used at `gateway.ts:461-463`; `urlVariable`/`platformVariable` (`:49-51`) are the util constants. It moved out of core because the CLI can't import core.
- What is the `kete` provider? A Kete-owned model-provider plugin (`gateway.ts:47` `providerID`) that offers only the models the Kete Model Gateway allows, each on the gateway's native per-provider route.
- Where does the key (and URL) come from in job mode? Since piece A1 (user decision D2): **only**
  the job's descriptor key — `kete job run` reads `KETE_JOB_GATEWAY_KEY_FD`, passes it to its
  `kete serve` child on fd 3, which stores it in `KeteJobSecrets.setGatewayKey` (in memory,
  write-once, `util/src/kete/job-secrets.ts:133-145`). `make` reads it via `options.jobKey ??
  KeteJobSecrets.gatewayKey` and checks `KeteJobMode.enabled(environment)` (`gateway.ts:156-157`);
  `load` then skips the account entirely (`:181`) and `configured(..., { key })` returns that
  key with URL/platform **only** from `OPENCODE_GATEWAY_URL`/`OPENCODE_PLATFORM_URL` (the
  entrypoint's `KETE_GATEWAY_URL`/`KETE_PLATFORM_URL`, `:457-465`). Ignored in job mode: account
  files, a `kete auth login` integration credential (`:231-234`), `providers.kete.settings.apiKey`
  and `baseURL`, `kete.platform.url`, and `KETE_GATEWAY_KEY` (also deleted from env by the CLI). So
  every model call is metered on the job's key. No key → no requests, no provider.
- What is the single key-resolution point, and what environment does it see? `configured`
  (`gateway.ts:444-477`); `make({ environment })` captures `process.env` (default) at plugin
  construction, and tests pass `environment`/`account`/`jobKey` instead (`:141-157`).
- Does job mode (`KETE_JOB_MODE`) change what this plugin publishes? Only the key/URL source (above);
  discovery and publishing are unchanged. Job mode's own plugin (`core/src/kete/job-plugin.ts`) removes every model
  whose provider isn't `providerID` (`gateway.ts:47`) from the already-published list, and a
  separate `RequestExecutor` replacement (`core/src/kete/job-request.ts`) checks/rewrites every
  outgoing request per `routes` (`gateway.ts:110-143`, matched by route **path**, not model name) —
  function tools only, one candidate, an output-token clamp from `KETE_JOB_MAX_OUTPUT_TOKENS`,
  `store: false` and no provider-side state for Responses, inline content only. Full contract: the
  `job-mode` card.
- Where does the `kete` provider's catalog data come from in a job? From the bundled models.dev snapshot: job mode disables the periodic models.dev fetch (`KETE_DISABLE_MODELS_FETCH=1`, `job-mode` card), so a gateway model newer than the shipped `kete`'s snapshot has no catalog entry there.
- Where do gateway model prices come from? The platform's `GET /api/v1/models`, only when a platform URL is configured (`gateway.ts:279-310`).
- Where does the TUI show account balance? `packages/tui/src/kete/balance.tsx`, reading the `kete` integration's metadata.

## Purpose
Discovers which models a configured Kete Model Gateway allows (one native route per source provider), publishes them as the `kete` provider with gateway-adjusted base URLs and platform pricing, and surfaces the account's credit balance in the TUI sidebar. Implements ADR 0004: no unified OpenAI-format gateway API exists, so each model reuses its source provider's catalog definition and SDK.

## Entry points
- `packages/core/src/kete/gateway.ts:141` `make(options)` — builds the plugin (`gateway.ts:437` exports the default instance as `Plugin`).
- Registered in `packages/core/src/plugin/internal.ts:270` (`KeteGateway.Plugin`, in `pre`, after the catalog and provider plugins — see Gotchas).
- `packages/tui/src/kete/balance.tsx:68` default-exports a TUI `Plugin.define` registered in `packages/tui/src/plugin/builtins.ts:7,25` (after `SidebarContext`).

- Which wire protocol does each gateway route speak (not previously mapped anywhere)? `routes`
  (`gateway.ts:110-143`) publishes one native per-provider route each, and the wire protocol is a
  property of the *route*, not something this file states directly: `/anthropic/v1` speaks Anthropic
  Messages; `/openai/v1` speaks OpenAI Responses (`…/responses`) or Chat Completions
  (`…/chat/completions`) depending on path; `/compat/{deepseek,openrouter,nvidia,byteplus}/v1` speak OpenAI Chat
  Completions (with openrouter's own extras); `/gemini/v1beta` speaks Gemini's `generateContent`/
  `streamGenerateContent`. Transport is a separate axis from protocol: it comes from
  `provider.settings.transport` (`core/src/model-resolver.ts:392`), and only the `openai` provider
  defaults to WebSocket (`core/src/plugin/provider/openai.ts:260`) — every `kete`-routed model uses
  HTTP. `core/src/kete/job-request.ts`'s `family(url)` is the first place this mapping is made
  explicit in code, for job mode's own request-conformance checks — see the `job-mode` card.

## Key files
- `gateway.ts:110-143` `routes` — the gateway's route prefixes (`/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`, `/compat/{deepseek,openrouter,nvidia,byteplus}/v1`) mapped to catalog provider IDs, auth header shape, and response parser.
- `gateway.ts:240-277` `discover` — calls `GET <prefix>/models` per route (5s timeout, concurrency = route count); a route's failure keeps its last known models, only a total failure fails discovery.
- `gateway.ts:279-310` `pricing` — `GET <platform>/api/v1/models`, mapped by `route.prefix + model_id`.
- `gateway.ts:312-326` `me` — `GET <platform>/api/v1/me`, mapped to `{balance_micros, currency, organization}`.
- `gateway.ts:444-477` `configured` — resolves URL/key/platform: in job mode the descriptor key + env URLs only (`:457-465`); otherwise signed-in account (`KeteAccount`) wins over `providers.kete.settings.{baseURL,apiKey}` wins over `KETE_GATEWAY_URL`/`KETE_GATEWAY_KEY`/`KETE_PLATFORM_URL`.
- `balance.tsx:14-22` `account()` (and `balanceText` `:25`, shared by the sidebar and the status line's opt-in `balance` item, `statusline.tsx:279`) — parses integration metadata into a display shape; `balance.tsx:12` `lowBalanceMicros` (1,000,000, i.e. $1) is the low-balance warning threshold.

## Data flow
Plugin start → `load()` resolves gateway URL/key/platform (account > config > env; job mode: descriptor key + env URLs) → `refresh()` discovers models per route and (if platform configured) fetches prices → `ctx.provider.transform` publishes each discovered model under `providerID` with `baseURL` set to `${gatewayURL}${route.prefix}` and catalog fields copied from the source provider (`gateway.ts:203-225`) → separately, `balance()` polls `GET /api/v1/me` every `balanceInterval` (default 1 minute) and writes the result onto the `kete` integration's `metadata` via `ctx.integration.transform` (`gateway.ts:194-201`, `329-337`) → TUI's `KeteBalance` component reads that metadata off `context.data.location.integration.list(...)` per session and renders it in the sidebar (`balance.tsx:24-33`).

## Data and APIs used
- Gateway native routes: `GET <prefix>/models` per `routes` entry (`gateway.ts:110-143`).
- Platform API: `GET /api/v1/models` (pricing, micro-USD per million tokens) and `GET /api/v1/me` (balance/currency/organization) — kete-code-platform's versioned API, never the database (CLAUDE.md §3).
- Config: `providers.kete.settings.{baseURL,apiKey}`, `kete.platform.url`; env fallbacks `KETE_GATEWAY_URL`, `KETE_GATEWAY_KEY`, `KETE_PLATFORM_URL` (env bridge renames `KETE_*` to `OPENCODE_*` before plugins run — `gateway.ts:25,49-51`).
- Account store: `@opencode/util/kete/account` (`KeteAccount.read`/`.key`) for `kete login` credentials, which take precedence over hand configuration.

## Rules that must not break
- Without a gateway URL the plugin does nothing (`gateway.ts:195,205`) — the gateway must never become a hard dependency for local use (CLAUDE.md §3, ADR 0004).
- Outside job mode, a signed-in account's URL/key/platform always wins over hand configuration (`gateway.ts:234,450-456`).
- In job mode the descriptor key is the only key and the env vars the only URL source (D2, `gateway.ts:181,457-465`); never read an account, an integration credential or config there, and never put the key into `process.env`.
- Routing, fallback, budgets and policy stay in the gateway itself, not this client (ADR 0004 Decision, last bullet).
- One route's outage must not drop the others' models or discard last-known inventory (`gateway.ts:238-239,252-276`).
- Model availability must never depend on the platform being reachable; only pricing does (`gateway.ts:345-356`, ADR 0004).

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
- The platform names Gemini `"gemini"`; the catalog calls it `"google"` — `platformRoute` (`gateway.ts:91-92`) translates for pricing lookups only.
- `first` discovery is awaited at plugin start (bounded by the 5s per-route timeout), so an unreachable gateway can delay CLI/TUI startup by up to that timeout; later refreshes (`interval`, default 5 minutes) run in the background with a 2/4/8s retry backoff on initial failure (`gateway.ts:372-397`).
- `balance` reload only fires when the fetched value actually changed (`JSON.stringify` compare, `gateway.ts:335`), to avoid unnecessary `ctx.integration.reload()` churn.
- `me`/`pricing`/`discover` all silently keep last-known state on failure/timeout rather than surfacing an error to the user — intentional per ADR 0004, not a swallowed-error violation.
