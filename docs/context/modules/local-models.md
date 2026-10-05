---
module: local-models
paths: [packages/core/src/kete/local-hosts.ts, packages/core/src/kete/local-models.ts, packages/core/src/kete/offline.ts, packages/util/src/kete/offline.ts, packages/util/src/kete/local-picker.ts, packages/schema/src/kete/local-models.ts, packages/cli/src/kete/offline.ts, packages/cli/src/kete/offline-startup.ts, packages/cli/src/kete/models-pull.ts, packages/cli/src/kete/models-list.ts, packages/tui/src/kete/local-models.ts, packages/tui/src/kete/local-offer.tsx, packages/tui/src/kete/local-status.tsx, packages/app/src/kete/local-models.ts, packages/app/src/kete/local-ui.tsx]
verified-at: 8a2747cd4d
---
## Quick answers
- How does a remote Ollama/LM Studio/vLLM host get in? `KeteLocalHosts.origin(provider)` (`core/src/kete/local-hosts.ts:79`) is passed as the `origin` of the upstream plugins (`core/src/plugin/provider/{ollama.ts:219,lmstudio.ts:151,vllm.ts:137}`); a configured `providers.<id>.settings.baseURL` still wins because upstream's `configured()` checks config first. Variables and order: `local-hosts.ts:27`.
- How do clients read local server status? Plugin RPC `kete.local-models`, methods `status` and `rediscover` (`schema/src/kete/local-models.ts:58-72`), registered with `ctx.rpc.register` (`core/src/kete/local-models.ts:406`), served by the existing `POST /api/rpc/:rpcID/:method` (no new endpoint). The plugin event stream carries `rpc.*` events (`core/src/plugin/host.ts:256-264`).
- Why raw `client.rpc.call` plus a decode? The promise client's typed `client.rpc(Definition)` (`client/src/promise/rpc.ts`) only accepts Standard Schema definitions; ours uses Effect Schema, so CLI/TUI/web call `rpc.call` and decode against `KeteLocalModelsRpc.Status` (`tui/src/kete/local-models.ts:19`, `app/src/kete/local-models.ts:19`, `cli/src/kete/models-pull.ts`).
- How is a model without tools handled? The `session.context` hook can delete entries of `event.tools` and push `event.system` parts (`core/src/session/model-request.ts:206-231`; removed entries are dropped). `KeteLocalModels` removes all tools and adds `noToolsNotice` for a model whose final `capabilities.tools` is `false` (`core/src/kete/local-models.ts:425-442`); `compaction` and `generate` hooks only remove tools.
- How is a failed model lookup reported offline? `ModelUnavailableError` (`core/src/session/runner/model.ts:20-30`, hint at `:30`) fires first when `KeteOffline` removed the model from the catalog; the runner check (`core/src/kete/run-checks.ts:50`) covers models that got through.
- Why can't a client change `kete.offline` through the config API? The config PATCH endpoint only accepts `shell` (`schema/src/config.ts:114-116`); offline is set by flag, env or the config file.
- Is there an LSP download to turn off offline? No: LSP auto-download doesn't exist in v2 core.
- Where does the TUI hook in? Plugin slots and toast: `plugin/src/tui/context.ts:191-203,462-512`; the footer slot is `tui/src/kete/local-status.tsx:39-40`, registered in `tui/src/plugin/builtins.ts:23`; the model dialog is `tui/src/component/dialog-model.tsx:32`; first-run offer and notice are `useKeteLocalModels()` called at `tui/src/app.tsx:497`.
- Where does the web picker hook in? `app/src/providers/models/select-dialog.tsx:133,198,492` (badges, unreachable lines) and `provider-group.tsx:14` (`groupTitle`); web API client `app/src/runtime/server/api.ts`, `client.tsx`.
- How do plugins define a CLI RPC/handler map? Handler maps accept `{ $, sub }` for a command with subcommands (`cli/src/framework/runtime.ts:43-76`); global flags go in `runtime.ts:86`. See the `cli` card.
- Which tools do tests use for the status RPC in the TUI? The fixture answers it: `packages/tui/test/fixture/tui-client.ts:167` returns offline false and no providers.
- Does `kete models pull` work against a keyed Ollama? No: status never returns the API key, so no bearer token is sent (`cli/src/kete/models-pull.ts:145-206`); it fails with the HTTP error, exit 1.

## Purpose
Make local model servers first class without the gateway: remote hosts through env or config, a status every client can show, Ollama pulls, a no-tools safeguard, an Ollama context warning, and offline mode that limits Kete to local models and no other network calls. The user guide is `docs/local-models.md`.

## Entry points
- `packages/core/src/plugin/internal.ts:319-321` registers `KeteLocalModels.Plugin` (after `ConfigProviderPlugin`, so configured `capabilities.tools` is applied) and `KeteOffline.Plugin`; `:337` puts the offline plugin in `guarded`.
- `core/src/kete/local-models.ts:260` `Plugin` = `make()`; `core/src/kete/offline.ts:66` `Plugin`.
- `cli/src/index.ts:5` imports `./kete/offline-startup`; `index.ts:67` maps `models: { $, pull }`.
- `tui/src/app.tsx:497` `useKeteLocalModels()`; `tui/src/plugin/builtins.ts:23` footer plugin.
- `app/src/kete/panel.tsx:33,43` (`KeteOfflineIndicator`, `KeteLocalOffer`); `app/src/kete/composer-controls.tsx:51` (no-tools notice).

## Key files
| File | Role |
| --- | --- |
| `core/src/kete/local-hosts.ts` | `defaults` (`:20`), `variables` (`:27`), `parse` (`:34`), `resolve`/`origin` (`:66,79`), `rediscoverEvent` (`:84`), `insecure`/`display` (`:94,101`) |
| `core/src/kete/local-models.ts` | status probes (Ollama `/api/tags`+`/api/show`+`/api/ps`, LM Studio, vLLM), `contextWarning` (`:63`), `noToolsNotice` (`:43`), RPC registration, no-tools hooks |
| `core/src/kete/offline.ts` | `enabled` (`:39`), `active` (`:46`, config-aware, for loops), `blocks` (`:53`, offline and the URL isn't local), `blockedReason`/`blockedHint`, `isLocalModel`, `refusal`, plugin: model transform, remote MCP disable, web tool removal and `execute.before` refusal |
| `util/src/kete/offline.ts` | `OPENCODE_OFFLINE` flag `read`/`enabled` (`:27,36`), fail-closed parse, `refuse` (`:41`), `isLocalHost`/`isLocalURL` (`:114,130`) |
| `util/src/kete/local-picker.ts` | shared rules: `badges`, `unreachable`, `offer`, `pick`, `firstRunOffer` (`:169`), `noToolsTracker` (`:185`), `offlineFrom` (`:203`), `hasLocalModels` (`:210`) |
| `schema/src/kete/local-models.ts` | RPC `Definition` (`:62`), `Status`, `ProviderStatus`, states `reachable`/`unreachable`/`not_configured`/`blocked` (offline, non-local host) |
| `cli/src/kete/{offline,offline-startup}.ts` | pure rules vs side effect; see the `cli` card |
| `cli/src/kete/models-pull.ts`, `models-list.ts` | pull flow (`pull` at `:145`, exits `:28`), TTY details (`:19,26`) |
| `tui/src/kete/local-models.ts`, `local-offer.tsx`, `local-status.tsx` | status fetch (`:19`), dialog fields/unreachable options, first-run offer + notice, footer indicator |
| `app/src/kete/local-models.ts`, `local-ui.tsx` | status fetch, picker helpers, badges, indicator, offer card, no-tools notice hook (`:180`) |

## Data flow
Host: config `baseURL` > `KETE_*_HOST` (bridged to `OPENCODE_*_HOST`) > `OLLAMA_HOST` (unbridged) > default loopback port. The upstream plugin discovers models (30 s cadence); the Kete plugin only probes when `status` is called (2 s per request, providers concurrently) and never returns keys or URL credentials. `rediscover` emits `rpc.kete.local-models.rediscover`; the Ollama plugin re-reads `/api/tags` on it (`plugin/provider/ollama.ts:203-214`, marked edit). Pull: CLI asks status for Ollama's URL, strips `/v1`, streams `/api/pull`, then calls `rediscover`.
Offline: `cli/src/kete/offline-startup.ts` sets `OPENCODE_OFFLINE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE` from flag, env or global config. In the runtime, `KeteOffline.Plugin` re-reads project `kete.offline` per transform/hook, removes non-local models, disables remote MCP servers, drops web tools; gateway, sync and registration re-check `KeteOffline.active` on every tick; the upstream `ollama`/`lmstudio`/`vllm` plugins skip discovery via one marked `KeteOffline.blocks(config, baseURL)` line, and the status probe returns state `blocked` (no request, no key) for a non-local host; the runner check fails a non-local model with type `offline`; `opencode.ts:147` skips the Console fetch (`KeteOffline.active` via an optional Config lookup). CLI connection rule: private server only, `--server` refused.
Clients: pickers show a Local group with `no tools`/context badges and one line per unreachable configured server. First-run offer: persisted flag (TUI storage `kete-local-offer`, web `Persist.global("kete.local-offer")`), asks status only when the catalog has a local model and no model is configured, selects client-side with `pick`. Offline indicator: TUI reads env flag or config (no RPC); web uses status `offline` or config. No-tools notice: once per session via `noToolsTracker`.

## Data and APIs used
- RPC `kete.local-models` (`status`, `rediscover`, event `rediscover`) over `POST /api/rpc/kete.local-models/<method>`.
- Servers' own APIs: Ollama `/api/tags`, `/api/show`, `/api/ps`, `/api/pull`; LM Studio `/api/v1/models`; vLLM `/v1/models`, `/health`.
- Config `providers.<id>.settings.{baseURL,apiKey}`, `providers.<id>.models.<m>.capabilities`, `kete.offline`.
- Env `KETE_OFFLINE`, `KETE_OLLAMA_HOST`, `KETE_LMSTUDIO_HOST`, `KETE_VLLM_HOST`, `OLLAMA_HOST`.

## Rules that must not break
- Status never contains API keys, headers or URL credentials; error text is capped (`schema/src/kete/local-models.ts:26`).
- Offline fails closed: an invalid `KETE_OFFLINE` or non-boolean `kete.offline` counts as on (`util/src/kete/offline.ts:27`).
- Offline never widens a permission and never skips cached policy: the plugin adds no `evaluate` rules; policy sync loads its cache.
- "Local" provider = `ollama`/`lmstudio`/`vllm`, or a base URL host that is loopback or private-network by IP; LAN hostnames don't count (no DNS).
- Plain `http://` to a non-local host warns once; never disable TLS verification.
- No `num_ctx` is sent to Ollama (the OpenAI-compatible endpoint can't); Kete warns instead (`local-models.ts:63`, logged once per model).
- Kete never downloads weights itself; pulling is Ollama's job.
- Upstream edits (ollama/lmstudio/vllm/opencode plugins, `internal.ts`, runner `llm.ts`/`model.ts`) keep `kete_change` markers and are listed in `docs/upstream-patches.md` "Local models".

## Testing
- core: `bun run test ./test/kete/{local-hosts,local-models,offline,offline-discovery}.test.ts` (plus offline cases in `gateway.test.ts`, `policy-sync.test.ts`); `KeteLocalModels.make` has a `defaultOrigins` test option.
- util: `bun test ./test/kete/{offline,local-picker}.test.ts`; cli: `bun test ./test/kete/{offline-startup,models-pull}.test.ts`; tui: `bun test ./test/kete/local-models.test.tsx` (the fixture `test/fixture/tui-client.ts:167` answers the status RPC); app: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/local-models.test.ts`.

## Changes
- Task `docs/tasks/2026-10-04-local-models/` (passes A core/util/schema, B cli, C tui/web); user guide `docs/local-models.md`; upstream edits in `docs/upstream-patches.md` "Local models (feature/local-models)".

## Gotchas
- `kete.offline` in a project config does not turn off the models.dev fetch or update checks (decided at startup); everything else (model filter, MCP, web tools, gateway, sync, registration, discovery, status) follows it live, loops from their next tick.
- Status errors are fixed texts from the transport error code (`transportReason`, `core/src/kete/local-models.ts:173`), never the transport message, which quotes the URL with credentials and query; requests use the credential-free `base`/`root`.
- The status RPC `url` ends in `/v1`; pull strips it to get Ollama's origin (`models-pull.ts:77`).
- `not_configured` means no host was set and the default port refuses the connection; `unreachable` is an explicitly set host or a default port that answers badly.
- vLLM always reports `tools: false`; override with config `capabilities` (`input` and `output` are required alongside `tools`).
- `kete sync --status`/`--approve` still work offline; plain `sync`, `login`, `upgrade`, `models pull` exit 2.
