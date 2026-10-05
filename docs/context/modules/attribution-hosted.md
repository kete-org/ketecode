---
module: attribution-hosted
paths: [packages/core/src/kete/attribution.ts, packages/core/src/kete/hosted.ts]
verified-at: 604889ab32
---
## Quick answers
- What does `attribution.ts` do? Rewrites the app-attribution headers upstream's provider plugins (OpenRouter, Vercel, Kilo, LLM Gateway, ZenMux, NVIDIA, Cerebras) set for OpenCode, replacing them with Kete Code's values, but only when the header still holds upstream's exact default — a user-configured value is left alone.
- What does `hosted.ts` do? Holds the single switch, `anonymousOpencodeZen = false`, that disables upstream's out-of-the-box anonymous access to OpenCode Zen (the `opencode` provider), per ADR 0003.
- Where's the seam into upstream? `packages/core/src/plugin/provider/opencode.ts:261-262` — the anonymous-enable branch is gated on `KeteHosted.anonymousOpencodeZen`.
- What network calls does Kete make by default, and what does offline mode turn off? See "Default outbound calls" under Data and APIs used; offline mode (`docs/local-models.md` "Offline mode", card `local-models`) removes all of them except local model servers (`packages/core/src/kete/offline.ts:66`).

## Purpose
Two small always-on policy switches that keep Kete Code from silently crediting or defaulting to OpenCode's own hosted identity/services: `attribution.ts` makes Kete Code identify itself (not OpenCode) to model providers that track the calling app, and `hosted.ts` ensures no code reaches a third-party hosted service (opencode.ai) without the user explicitly opting in (CLAUDE.md §9 Privacy).

## Entry points
- `packages/core/src/kete/attribution.ts:49` `Plugin` (`id: "kete.provider.attribution"`) — a `provider.transform` plugin, registered in `packages/core/src/plugin/internal.ts:272` ("after the provider plugins; replaces their OpenCode attribution headers with Kete Code's"), next to `KeteGateway.Plugin`.
- `packages/core/src/kete/hosted.ts:22` `anonymousOpencodeZen` — a plain exported `const`, not a plugin; consumed directly by the upstream seam below. No plugin registration of its own.
- Seam: `packages/core/src/plugin/provider/opencode.ts:17,261-262` (`// kete_change`) — `if (!hasKey && KeteHosted.anonymousOpencodeZen)` gates upstream's anonymous "public" key auto-enable of the `opencode` provider.

## Key files
- `attribution.ts:26-32` `replacements` — a table keyed by lower-cased header name, each entry `{upstream: <exact default string>, kete: <replacement or undefined>}`: `http-referer` → `Brand.urls.website` (removed while undefined), `x-title` → `"Kete Code"`, `x-source` → the website's host (removed while undefined), `x-billing-invoke-origin` → `Brand.attribution.nvidiaOrigin`, `x-cerebras-3rd-party-integration` → `Brand.attribution.cerebrasIntegration`.
- `attribution.ts:35-47` `rewrite(headers)` — pure function; only replaces a header whose *current value* exactly equals upstream's default, so a value the user set in provider config is never touched; returns the same object reference when nothing changes.
- `attribution.ts:52-60` the plugin body — iterates every provider's `headers`, calls `rewrite`, and only calls `providers.update` when it actually changed something.
- `hosted.ts:8-22` doc comment + the single switch; explicitly scoped as "defaults for OpenCode's hosted services that Kete Code inherits from upstream" and lists the three opt-in paths (`kete auth login`, env API key, `providers.opencode` config entry).

## Data flow
`attribution.ts`: provider plugins run first and set their upstream-default headers → `KeteAttribution.Plugin` runs after them in the `pre` list → for each provider with headers, `rewrite()` swaps any header still equal to upstream's default for Kete Code's value (or drops it if Kete Code has none, e.g. no website yet) → downstream model requests carry Kete Code's attribution instead of OpenCode's. `hosted.ts`: no runtime flow of its own — `packages/core/src/plugin/provider/opencode.ts` reads the constant directly at provider-list build time to decide whether to auto-enable the `opencode` provider for a keyless user.

## Data and APIs used
- `@opencode/util/kete/brand` (`Brand.urls.website`, `Brand.attribution.{title,nvidiaOrigin,cerebrasIntegration}`) — the only source of Kete Code's identity values; product identity must never be hardcoded (CLAUDE.md §5).
- Provider config: `providers.opencode.settings.apiKey` (or `OPENCODE_API_KEY` env, or a `sourceConnection`) — presence of any of these is `hasKey` in `opencode.ts:258`, independent of the `anonymousOpencodeZen` switch.

### Default outbound calls
Everything below happens without the user naming a host; anything not listed needs explicit configuration.
- The models.dev model catalog fetch (bundled snapshot is the fallback).
- The Kete gateway and platform, only when configured or signed in: `/api/v1/me`, `/models`, `/sync`, and runtime registration.
- Update checks (`kete upgrade` is disabled upstream-style; `cli/src/kete/updater.ts` checks).
- Remote (URL) MCP servers and their OAuth metadata, only for servers the user or policy configured.
- The `webfetch` and `websearch` tools, when the model calls them.
- The OpenCode Console config fetch, only when the `opencode` provider has a key (`core/src/plugin/provider/opencode.ts:147`).
- OTLP telemetry, only when configured.
- Local model servers (Ollama, LM Studio, vLLM), only on the configured or default loopback hosts (`core/src/kete/local-hosts.ts:66`).

**Offline mode** (`--offline`, `KETE_OFFLINE`, `kete.offline`) turns off the models.dev fetch, the gateway and platform (sync, registration, `kete login`), update checks, remote MCP servers, `webfetch`/`websearch`, the Console fetch and `kete models pull`; non-local models fail with a refusal. Cached organization policy is still loaded and enforced.

## Rules that must not break
- `attribution.ts` must never overwrite a header value that isn't exactly upstream's known default — that would clobber a user's own provider configuration (`attribution.ts:35-39,43`).
- OpenAI's `originator: "opencode"` header and the `x-opencode-*` session headers (`session/model-request.ts`) are *deliberately* left unmapped in `replacements` — changing `originator` affects ChatGPT backend model/context availability, and the `x-opencode-*` names are an upstream protocol detail the Kete gateway already strips before forwarding to a provider (docs/upstream-patches.md "Branding cleanup and provider attribution", "Deliberately unchanged, and why").
- `hosted.ts`'s default must stay `false` — Kete Code must never send code to opencode.ai without an explicit opt-in (ADR 0003, CLAUDE.md §9).
- Every upstream sync must be reviewed for *new* opencode.ai endpoints, telemetry, or providers enabled by default, adding a new switch to `hosted.ts` when found (ADR 0003 Consequences, upstream-patches sync note).

## Testing
- `bun run test ./test/kete/attribution.test.ts` inside `packages/core/`.
- `bun run test ./test/kete/hosted.test.ts` inside `packages/core/` (pins the default itself, per upstream-patches).
- Upstream-side regression coverage touched by the `hosted.ts` seam (review, don't own): `core/test/plugin/provider-opencode.test.ts`, `cli/test/auth.test.ts`, `tui/test/cli/cmd/tui/integration-options.test.ts`, `tui/test/feature-plugins/sidebar-footer.test.tsx` (docs/upstream-patches.md "Hosted defaults").

## Changes
- docs/adr/0003-hosted-services-opt-in.md — the opt-in decision and its consequences.
- docs/upstream-patches.md "Hosted defaults" (feature/disable-zen-default) — full upstream source-edit table (`cli/src/commands/handlers/auth/{login,shared}.ts`, `tui/src/component/dialog-integration.tsx`, `tui/src/feature-plugins/sidebar/footer.tsx`) beyond the `opencode.ts` seam this card documents.
- docs/upstream-patches.md "Branding cleanup" — the full provider-attribution table (every header, per provider, with upstream vs. Kete Code values and why each is or isn't changed) and the "Remaining OpenCode strings" audit table (MCP OAuth client identity, model catalog URL, etc., deliberately unchanged for protocol reasons).

## Gotchas
- `rewrite()` compares against upstream's *exact* default string per header — if an upstream sync changes one of those default values (e.g. a new OpenRouter default `X-Title`), `replacements[...].upstream` must be updated or the header silently stops being rewritten.
- `hosted.ts` currently has exactly one switch; it is not a general feature-flag file — new switches must each get their own doc comment explaining the upstream default they override, matching the existing style.
- The `opencode` provider can still be explicitly enabled by a user (via `kete auth login`, an env key, or a `providers.opencode` config entry) even with `anonymousOpencodeZen = false` — the switch only blocks the *anonymous* auto-enable path, not deliberate opt-in.
