# Plan: Local models: remote Ollama, setup and picker, offline mode, capabilities

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Approved (user pre-approved all recommendations, 2026-10-04).** Built in three passes: A = steps 1–10, B = 11–12, C = 13–16. The README section goes in `.github/README.md` (the root README is upstream's). Original note: It edits upstream files
> (list under "Upstream edits"), changes the config schema (`kete.offline`, so protocol + client
> regeneration), adds public contracts (`--offline`, `KETE_OFFLINE`, `KETE_OLLAMA_HOST`,
> `KETE_LMSTUDIO_HOST`, `KETE_VLLM_HOST`, `kete models pull`, the `kete.local-models` plugin RPC) and
> is security-relevant (offline mode must fail closed and never widen policy). Spec status: approved.

## Cards read
- docs/context/modules/config-kete.md (verified-at 715843563a, stale: no)
- docs/context/modules/attribution-hosted.md (verified-at bfd6c66, stale: no)
- docs/context/modules/gateway.md (verified-at 6d8972321a, stale: no)
- docs/context/modules/cli.md (verified-at f91a61f0e8, stale: no)
- docs/context/modules/sync.md, runtime-registration.md (stale: no; read via the sync plugin's header)
- docs/context/modules/brand-env.md (verified-at fb75b7596c, stale: no)
- docs/context/modules/server-sdk.md (verified-at e8079c109b, stale: no)
- docs/context/modules/job-mode.md (verified-at 34a10660f8, stale: no). Its MCP/model-filter plugin is the pattern offline mode copies.
- docs/context/modules/web-app.md (verified-at 6c3649e3a6, stale: no)
- docs/context/modules/ui-branding.md, vscode-extension.md, permissions.md (stale: no)
- docs/context/{commands,pitfalls,decisions}.md

No card covers the upstream local provider plugins, plugin RPC, the `session.context` hook, the
TUI plugin slot API or the model pickers. Those gaps are logged in handoff.md and listed in "Cards
to update".

## Design summary (smallest design that meets the spec)

1. **Hosts (AC1).** New `KeteLocalHosts` (`core/src/kete/local-hosts.ts`) turns env vars into
   each upstream plugin's existing `origin` parameter. The three upstream `export const XPlugin = make()`
   lines become `make(KeteLocalHosts.origin("<id>"))`. Upstream `configured()` already prefers
   `providers.<id>.settings.baseURL` over `origin`, so **config beats env with no further code**.
   Precedence: Ollama uses `OPENCODE_OLLAMA_HOST` (the bridged `KETE_OLLAMA_HOST`), then
   `OLLAMA_HOST`, then the default; LM Studio and vLLM use their `KETE_*` variable or the default.
   Forms accepted: `host`, `host:port`, `[v6]:port`, `scheme://host[:port][/path]`. The default
   scheme is `http` and the default port is the provider's own. Invalid values are logged as a
   warning and the default is used. The spec says "fold into settings"; using `origin` is the same
   seam with fewer lines.
2. **Status, rediscovery, warnings (AC1, AC2, AC7).** New internal plugin `KeteLocalModels`
   (`core/src/kete/local-models.ts`, id `kete.local-models`) registers a **plugin RPC**
   (`ctx.rpc.register`, served by the existing `POST /api/rpc/:rpcID/:method`, so **no new HTTP
   endpoint and no protocol change for status**):
   - `status` → `{ offline, providers: [{ id, state: "reachable"|"unreachable"|"not_configured", url, source: "config"|"env"|"default", models?, error?, insecure, hint, contextWarnings? }] }`
   - `rediscover` → emits the RPC event `rediscover` (`rpc.kete.local-models.rediscover`). The Ollama
     plugin already subscribes to `ctx.event` (`plugin/host.ts:256-264` passes `rpc.*` events
     through), so a small marked edit in `ollama.ts` clears its discovery cache entry and refreshes.
   - The probe runs only when `status` is called (no background work). It uses the same base URL
     resolution as upstream: config `baseURL`, then the env origin, then the default. It sends the
     configured `apiKey` as a bearer token and never returns it. Timeout 2 s per call, providers
     probed concurrently. Ollama: `/api/tags`, `/api/show` per model (concurrency 4), `/api/ps`.
     LM Studio: `/api/v1/models`. vLLM: `/v1/models`.
   - `not_configured` means no config or env host is set **and** the default port refuses the
     connection. `unreachable` means a host was set explicitly, or the default port answers with an
     error or times out. This keeps users without local servers free of noise (see Risks R1).
   - Warns once per plugin activation per URL (`Effect.logWarning`) for a plain-`http` host that
     isn't loopback (D2), and sets `insecure: true`. HTTPS is verified as normal. There is no TLS
     option of any kind.
   - Ollama context (D4): `contextWarning({ discovered, numCtx, loaded })` is a pure function. The
     served window is `num_ctx` from `/api/show` `parameters`, or the `/api/ps` `context_length`
     for loaded models. If neither is known and `discovered > 8192`, the warning says "may serve
     only Ollama's default window". The message names `OLLAMA_CONTEXT_LENGTH` and Modelfile
     `num_ctx`. It is logged once per model and returned in `contextWarnings`.
3. **No-tools models (AC6).** `KeteLocalModels` also: (a) in `ctx.model.transform`, registered in
   `post` **after `ConfigProviderPlugin`** so config `capabilities.tools` overrides are already
   applied, records a `providerID/modelID → tools` map (observe only); (b) hooks
   `session.context`: when the request's model has `tools === false`, it deletes every entry of
   `event.tools` and appends a `SystemPart` telling the agent it has no tools. Upstream
   `model-request.ts:224-231` drops entries the hook removed, so nothing else changes. An unknown
   model keeps upstream behaviour. The user notice is client-side: TUI and web show it once per
   session (step 13, step 16).
4. **Offline (AC5).** Process-wide switch: `--offline`, `KETE_OFFLINE=1`, or `kete.offline: true`
   in the **global** config. `cli/src/kete/offline-startup.ts` runs right after the env bridge and
   sets `OPENCODE_OFFLINE=1` plus the existing switches `OPENCODE_DISABLE_MODELS_FETCH=1` and
   `OPENCODE_DISABLE_AUTOUPDATE=1`, so models.dev and update checks need **no new code**. Child
   `kete serve` processes inherit these. Location-scoped parts read
   `KeteOffline.enabled(env) || Config.latest(entries,"kete")?.offline === true`, so a project
   `kete.offline` also applies there.
   - `KeteOffline` plugin (`core/src/kete/offline.ts`, id `kete.offline`, `post` after
     `KeteAgentSync` and `ConfigProviderPlugin`, before `KeteJobPlugin`, **guarded**):
     `model.transform` removes every model whose provider isn't local. Local means `ollama`,
     `lmstudio`, `vllm`, or a provider whose `settings.baseURL` host is loopback or private per
     `KeteOffline.isLocalHost`. `mcp.transform` disables `type: "remote"` servers, including synced
     ones, and leaves stdio servers alone. `session.context` removes `webfetch`/`websearch`.
     `tool.execute.before` refuses them with "Offline mode: web access is off" in case of renames
     or other callers.
   - The runner check (`KeteRunChecks`, already called before every step) gets the resolved model
     and fails a non-local model with a clear `StepFailedError`. `ModelUnavailableError.message`
     (upstream, marked) adds an offline hint when process-wide offline is on, because a removed
     model fails at resolution before the runner check.
   - Gateway (`gateway.ts`), platform sync and runtime registration (`sync/plugin.ts`), and the
     OpenCode console config fetch (`opencode.ts`, upstream, marked) do nothing while offline. The
     sync plugin still **loads the cached sync** at startup, so cached org policy and its
     fail-closed guard work exactly as online.
   - CLI: offline forces a private server (`--standalone` semantics), because the background
     service may be online. `--server` together with offline is refused because the client can't
     verify the remote server's mode. `kete login`, `kete sync`, `kete upgrade` and
     `kete models pull` refuse with an "offline mode" message (pull would make Ollama download
     from the internet).
   - Offline is never a reason to skip a permission or policy check. Nothing here loosens rules;
     the plugin only removes models, servers and tools.
5. **`kete models pull` (AC4).** A CLI subcommand of the upstream `models` command. It resolves
   the server as `kete models` does, calls RPC `status` to get Ollama's resolved URL (so config and
   env are honoured, and the CLI never imports core), streams `POST <origin>/api/pull`
   `{model, stream:true}` as NDJSON through the existing `cli/src/kete/progress.ts`, then calls RPC
   `rediscover`. Ctrl-C → `AbortController` → "Pull cancelled" and exit 130. 10 s timeout for the
   first response, 60 s idle timeout between lines. Ollama `{error}` lines, non-2xx responses and an
   unreachable server each exit 1 with the URL and the reason.
6. **Pickers, first run, indicators (AC2, AC3).** Pure helpers in Kete files (`tui/src/kete/local-models.ts`,
   `app/src/kete/local-models.ts`) plus small marked edits to the TUI model dialog and the web
   provider group. First run: when no model is configured (no config `model`, no client
   recent/favourite) and RPC `status` shows a reachable server with ≥1 model, offer once (persisted
   flag). Accepting **selects the model the same way the picker does**, using the client's own
   persisted selection; no config write (Risks R3). "Offline" indicator: TUI plugin slot
   `home.footer.status` / `prompt.footer.status`; web: Kete panel header.

## Files

The implementer reads ONLY these. "U" marks upstream files (every edit `kete_change`-marked,
recorded in `docs/upstream-patches.md`).

| File | Read / change | Why |
|---|---|---|
| packages/core/src/plugin/provider/ollama.ts (U) | change | `:206` export uses `KeteLocalHosts.origin("ollama")`; in the `ctx.event` stream (`:197-201`) also accept `rpc.kete.local-models.rediscover` (data `{provider:"ollama"}`) → `discovery.delete(source.current.tagsEndpoint)` then `refresh()` (marked block) |
| packages/core/src/plugin/provider/lmstudio.ts (U) | change | export line uses `KeteLocalHosts.origin("lmstudio")`; read `configured()` (`:120-166`) for the probe URL |
| packages/core/src/plugin/provider/vllm.ts (U) | change | `:136` export uses `KeteLocalHosts.origin("vllm")`; read `configured()` for the probe URL |
| packages/core/src/plugin/provider/configured.ts | read | `foldSettings` reused by the status probe (no edit) |
| packages/core/src/config/plugin/provider.ts | read | `:97-126` config `capabilities` overrides (why the observer runs after `ConfigProviderPlugin`) |
| packages/core/src/plugin/internal.ts (U) | change | import and register `KeteLocalModels.Plugin` and `KeteOffline.Plugin` in `post` after `ConfigPolicyPlugin`, before `KeteJobPlugin`; add `KeteOffline.Plugin.id` to the marked `guarded` set |
| packages/core/src/plugin/host.ts | read | `:256-264` plugin event stream includes `rpc.*` events; `ctx.rpc` shape (`:119`) |
| packages/plugin/src/effect/rpc.ts, packages/plugin/src/effect/session.ts, packages/plugin/src/effect/tool.ts, packages/plugin/src/effect/model.ts, packages/plugin/src/effect/mcp.ts | read | RPC registration, `session.context` event (`tools`, `system`), `tool.execute.before`, `ModelEditor` (`list`, `provider.list`), MCP editor |
| packages/plugin-browser/src/rpc.ts | read | pattern for an `Rpc.define` definition with Effect Schema |
| packages/schema/src/rpc.ts | read | `Rpc.define`, portable method rules |
| packages/core/test/plugin-failure.test.ts | read | pattern for calling a plugin RPC in a test (`Rpc.Service.call`) |
| packages/core/src/session/model-request.ts | read | `:206-231` how hook-removed tools are dropped |
| packages/core/src/session/runner/llm.ts (U) | change | the existing marked `checks({...})` line (`:229`) also passes `model: loaded.model` (same line, marker kept) |
| packages/core/src/session/runner/model.ts (U) | change | `ModelUnavailableError.message` (`:23-30`): append `KeteOffline.unavailableHint()` (marked one line) |
| packages/core/src/kete/run-checks.ts | change | input gains `model: SessionRunnerModel.Resolved`; first check: offline and non-local model → `StepFailedError` (new `SessionError` type `"offline"` or reuse an existing type; see step 9) |
| packages/core/src/kete/job-plugin.ts | read | pattern for `mcp.transform`/`model.transform` |
| packages/core/src/kete/gateway.ts | change | `make`: no-op when offline (env or config); balance polling off too |
| packages/core/src/kete/sync/plugin.ts | change | offline: skip the `sync` fork (`:403`) and the `register` fork (`:429`); keep `KeteSync.load` (`:194`) so the cache and policy guard stay |
| packages/core/src/plugin/provider/opencode.ts (U) | change | skip the console config fetch/re-fetch (`fetchConfig` call sites around `:146` and `:354`) when `KeteOffline.enabled()` (marked) |
| packages/core/src/kete/local-hosts.ts | **new** | `origin(provider, env)`, `parse(value, defaultPort)`, `insecure(url)` |
| packages/core/src/kete/local-models.ts | **new** | plugin `kete.local-models`: RPC `status`/`rediscover`, insecure warning, capability map + `session.context` no-tools hook, `contextWarning` |
| packages/core/src/kete/offline.ts | **new** | plugin `kete.offline`: `enabled(env, kete)`, `isLocalModel`, model/MCP/tool filters, `unavailableHint` |
| packages/util/src/kete/offline.ts | **new** | `enabled(env)` (`OPENCODE_OFFLINE` ∈ `1`/`true`; any other non-empty value = invalid → treated as **on**, as in job mode), `isLocalHost(host)`, `isLocalURL(url)`, `refuse(command)` message |
| packages/util/src/kete/job-mode.ts | read | fail-closed flag parsing pattern |
| packages/schema/src/kete/local-models.ts | **new** | `KeteLocalModelsRpc.Definition` (id `kete.local-models`; methods `status`, `rediscover`; event `rediscover`), shared by core, tui, app, cli |
| packages/schema/src/config/kete.ts | change | `offline: Schema.Boolean.pipe(optional)` on `Info`, with description |
| packages/cli/src/kete/env-bridge.ts | read | runs first; offline startup must run after it |
| packages/cli/src/kete/offline-startup.ts | **new** | side-effect module: argv `--offline` (before `--`), `OPENCODE_OFFLINE`, global config `kete.offline` (jsonc, `OPENCODE_CONFIG_DIR ?? Global.Path.config`, files as in `updater.ts` `readPolicy`) → sets `OPENCODE_OFFLINE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`; exports pure `apply(env, argv, readConfig)` and `connection(args, env)` |
| packages/cli/src/index.ts (U) | change | `import "./kete/offline-startup"` right after the env-bridge import; `Handlers.models` becomes `{ $: …models, pull: () => import("./kete/models-pull") }` (marked block) |
| packages/cli/src/framework/runtime.ts (U) | change | `Command.withGlobalFlags([PrintLogs, KeteOfflineFlag])` (`:85`, marked) so every command accepts `--offline` |
| packages/cli/src/commands/commands.ts (U) | change | `models` spec (`:285-288`) gains `commands: [KeteCommands.modelsPull]` (marked); read `PrintLogs` GlobalFlag pattern (`:8-14`) |
| packages/cli/src/kete/commands.ts | change | export `modelsPull` spec (argument `name`, `ServerParams`) and the `offline` GlobalFlag definition |
| packages/cli/src/framework/spec.ts | read | confirm a spec can have both params and `commands` (`$` handler supported in `runtime.ts:43-75`) |
| packages/cli/src/services/server-connection.ts (U) | change | `resolve` (`:22-45`): offline with `--server` → error; offline → `Standalone.start()` (marked lines via `KeteOfflineStartup.connection`) |
| packages/cli/src/commands/handlers/models.ts (U) | change | when stdout is a TTY, append `tools:yes/no vision:yes/no ctx:<n>` for local-provider models (marked); piped output unchanged |
| packages/cli/src/kete/models-pull.ts | **new** | handler + pure `pull(deps)`: status RPC → stream `/api/pull` → progress → rediscover RPC; SIGINT abort; timeouts |
| packages/cli/src/kete/progress.ts | read | existing TTY-aware progress output (reuse, no new spinner) |
| packages/cli/src/kete/updater.ts | change | `isDisabled` (`:314`) also true when offline (belt and braces with the env switch) |
| packages/cli/src/kete/upgrade.ts, packages/cli/src/kete/login.ts, packages/cli/src/kete/sync.ts | change | refuse in offline mode with `KeteOffline.refuse(...)`, exit 2 |
| packages/tui/src/component/dialog-model.tsx (U) | change | options: local models get category `"Local"` and footer `KeteLocalPicker.footer(model)` ("no tools", "32k ctx"); append non-selectable unreachable lines from status; toast once per session on selecting a no-tools model (marked lines) |
| packages/tui/src/ui/dialog-select.tsx | read | whether options support a disabled/info row (if not, `onSelect` of the info row shows the hint toast and keeps the dialog open) |
| packages/tui/src/context/local.tsx | read | `:150-200` how the current/configured model and recents are resolved (first-run condition) |
| packages/tui/src/context/client.tsx, packages/plugin/src/tui/context.ts | read | how TUI code gets the client for `client.rpc(Definition)`; slot/toast API (`:191-203`, `:462-512`) |
| packages/tui/src/kete/local-models.ts | **new** | pure helpers: `isLocal`, `footer`, `unreachableLines(status)`, `offerFor(status, hasModel, offered)`, `noToolsNotice(model, seen)` |
| packages/tui/src/kete/local-models.tsx | **new** | TUI plugin: "Offline" in `home.footer.status` and `prompt.footer.status`; Ollama context warning toast once per model |
| packages/tui/src/kete/local-offer.tsx | **new** | `useKeteLocalOffer()` hook: first-run dialog, accept → `local.model.set(...)`, persisted "offered" flag (TUI storage) |
| packages/tui/src/plugin/builtins.ts (U) | change | register the TUI plugin (marked, after `KeteBalance`) |
| packages/tui/src/app.tsx (U) | change | call `useKeteLocalOffer()` once (import plus one line, marked) |
| packages/tui/src/kete/balance.tsx, packages/tui/test/kete/balance.test.tsx | read | TUI plugin and frame-test pattern |
| packages/app/src/providers/models/provider-group.tsx (U) | change | a "Local" section for local providers, "no tools" badge, context size, unreachable line (marked) |
| packages/app/src/providers/models/select-dialog.tsx (U) | read; change only if the section list is built here | where sections/badges are composed |
| packages/app/src/providers/models/tooltip.tsx, selection.tsx | read | capability display; how a selection is set (first-run accept) |
| packages/app/src/runtime/server/client.tsx, packages/app/src/runtime/server/global-sync/utils.ts | read | client for `rpc(...)`; `toolcall` mapping (`:82`) |
| packages/app/src/kete/local-models.ts | **new** | pure helpers mirroring the TUI ones + `fetchStatus(client, location)` |
| packages/app/src/kete/panel.tsx, panel-state.ts, composer-controls.tsx | change | Offline indicator in the panel header; first-run offer in the empty state; once-per-session no-tools notice by the composer controls (Kete-owned, no markers) |
| packages/protocol/openapi.json, packages/client/src/*/generated/ | regenerate | `kete.offline` changes the config schema (never hand-edit) |
| docs/local-models.md | **new** | guide: hosts, env vars, status, pull, offline (what's off, what still works, policy), no-tools and context window |
| README.md | change | short "Local models" section linking the guide |
| docs/upstream-patches.md | change | new section "Local models (feature/local-models)", one row per upstream edit and why no seam works |
| docs/context/modules/attribution-hosted.md | change | add the outbound-call list and what offline turns off (spec item 5) |
| packages/core/test/plugin/provider-ollama.test.ts | read | fake-server pattern (`make(origin, interval)`, `eventually`) |
| packages/core/test/kete/gateway.test.ts, agent-sync.test.ts, policy-sync.test.ts, sync-fixture.ts, job-plugin.test.ts | read; change gateway/policy-sync | offline cases (no requests; cached policy enforced) |
| packages/core/test/kete/local-hosts.test.ts, local-models.test.ts, offline.test.ts | **new** | AC1, AC2, AC6, AC7, AC5 |
| packages/util/test/kete/offline.test.ts | **new** | flag parsing; RFC 1918, ULA, loopback, IPv4-mapped v6, `169.254.*` and hostnames not local |
| packages/cli/test/kete/models-pull.test.ts, offline-startup.test.ts | **new**; updater.test.ts change | AC4; offline env and connection rules; updater makes no request offline |
| packages/tui/test/kete/local-models.test.tsx | **new** | helpers and a frame test of the plugin and dialog lines |
| packages/app/src/kete/local-models.test.ts | **new** | helpers, offer, notice |

## Upstream edits (why no seam works)

| File | Edit | Why not config, a plugin or a Kete module |
|---|---|---|
| core/src/plugin/provider/{ollama,lmstudio,vllm}.ts | export line passes the env origin (1 line each) | `origin` is the plugins' only host input apart from config; the instances are built at module load |
| core/src/plugin/provider/ollama.ts | about 5 lines: rediscover on the RPC event | the discovery cache and `refresh` are closure-private; no hook triggers them |
| core/src/plugin/internal.ts | register 2 plugins and guard 1 (already a marked list) | internal plugins can only be registered here |
| core/src/session/runner/llm.ts | add `model` to the existing marked `checks` call | the runner check needs the resolved model; no hook can fail a step (pitfalls) |
| core/src/session/runner/model.ts | offline hint in one error message | a filtered model fails here before any Kete code runs |
| core/src/plugin/provider/opencode.ts | skip console fetches offline | upstream plugin's own network call; no switch exists |
| cli/src/index.ts, framework/runtime.ts, commands/commands.ts | handler map, global flag, `models pull` spec | the CLI command tree has no extension point except these marked lists |
| cli/src/services/server-connection.ts | offline → private server; refuse `--server` | connection choice is made only here |
| cli/src/commands/handlers/models.ts | TTY-only detail columns | spec requires `kete models` to show capabilities |
| tui/src/component/dialog-model.tsx, tui/src/app.tsx, tui/src/plugin/builtins.ts | picker group/footers/lines; offer hook; plugin registration | the dialog's options and app commands have no slot |
| app/src/providers/models/provider-group.tsx (and select-dialog.tsx if sections live there) | Local section and badges | the picker has no extension point |

## Steps
1. **util** `packages/util/src/kete/offline.ts` + test: `enabled`, `isLocalHost` (loopback
   127/8 and ::1, `localhost` and `*.localhost`, 10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10,
   IPv4-mapped v6; **not** 169.254/16, not other hostnames), `isLocalURL`, `refuse(command)`
   message wording "Offline mode is on (--offline, KETE_OFFLINE or kete.offline): `<command>` needs
   the network.".
2. **schema**: `offline` in `ConfigKete.Info`; `packages/schema/src/kete/local-models.ts` RPC
   definition (Effect Schema; status output as in the design summary; `url` without credentials or
   query; `error` a short message capped at 300 chars, never containing headers or keys).
3. **core hosts**: `local-hosts.ts` (+ test). Edit the three export lines (marked).
4. **core local-models plugin**: status probe, insecure warning, capability map, `session.context`
   no-tools hook (system text: "This model can't call tools in Kete Code: you can't read or edit
   files or run commands. Answer from the conversation, and tell the user to switch to a model with
   tool support for changes."), `contextWarning`, RPC `rediscover` emits the event. Edit
   `ollama.ts` for rediscovery (marked).
5. **core offline plugin** `offline.ts`: filters above; `enabled(env, kete)`; `isLocalModel(model, providerSettings)`.
6. Register both plugins in `internal.ts` `post` after `ConfigPolicyPlugin`, before `KeteJobPlugin`;
   add `KeteOffline.Plugin.id` to `guarded` (marked, inside the existing block).
7. `gateway.ts` and `sync/plugin.ts` offline no-ops (sync: load the cache, skip sync and
   registration, log once at info level "offline: platform sync paused, using the cached copy").
8. `opencode.ts` console fetch guard (marked).
9. `run-checks.ts`: add `model` input; offline + non-local → `StepFailedError` with message
   "Offline mode: <provider>/<model> isn't a local model. Pick an Ollama, LM Studio or vLLM model,
   or a provider on this machine or a private network." Use an existing `SessionError` type if
   one fits (`unattended` doesn't); otherwise add `"offline"` in
   `packages/schema/src/session-error.ts` (read it first; if it isn't Kete-owned, mark the edit and
   add it to the upstream table). Edit the `llm.ts` call line. Edit the `model.ts` hint (marked).
10. Regenerate: `bun run generate` in `packages/protocol`, then in `packages/client`.
11. **cli**: `offline-startup.ts` (+ test) and its import in `index.ts`; GlobalFlag in
    `kete/commands.ts` and `runtime.ts`; `server-connection.ts` rule; refusals in
    `upgrade.ts`/`login.ts`/`sync.ts`; `updater.ts` `isDisabled`.
12. **cli pull**: `models-pull.ts` (+ test against a `Bun.serve` fake `/api/pull` and a fake RPC
    client); `commands.ts` spec and `index.ts` handler map; `models.ts` TTY details.
13. **tui**: helpers, plugin, offer hook; `dialog-model.tsx`, `builtins.ts`, `app.tsx` edits; test.
14. **app**: helpers + test; `provider-group.tsx` (and `select-dialog.tsx` if needed) edits; panel
    offer, Offline indicator, no-tools notice.
15. Docs: `docs/local-models.md`, README section, `docs/upstream-patches.md` section, the
    `attribution-hosted` card's outbound-call list.
16. Run every verification command below; then `git grep -n kete_change -- packages` and compare
    it with the upstream table.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/core`: `bun run test ./test/kete/local-hosts.test.ts` (parsing; `KETE_OLLAMA_HOST` > `OLLAMA_HOST`; `OLLAMA_HOST=192.168.1.20:11434` → `http://192.168.1.20:11434`; the plugin built with the env origin discovers from fake server A; config `baseURL` → fake server B wins; insecure warning logged once, none for https or loopback) |
| AC2 | in `packages/core`: `bun run test ./test/kete/local-models.test.ts -t status`; in `packages/tui`: `bun test ./test/kete/local-models.test.tsx`; in `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/local-models.test.ts` |
| AC3 | in `packages/tui`: `bun test ./test/kete/local-models.test.tsx -t offer`; in `packages/app`: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/local-models.test.ts -t offer` |
| AC4 | in `packages/cli`: `bun test ./test/kete/models-pull.test.ts` (progress lines, honours the URL from status, `{error}` line and HTTP 500 → exit 1, abort → exit 130 and no rediscover, success → rediscover called, offline → refused); in `packages/core`: `bun run test ./test/kete/local-models.test.ts -t rediscover` (event → the Ollama plugin re-fetches `/api/tags` before its interval) |
| AC5 | in `packages/util`: `bun test ./test/kete/offline.test.ts`; in `packages/core`: `bun run test ./test/kete/offline.test.ts` (only local models listed, remote MCP disabled and stdio kept, webfetch/websearch removed and refused, runner check error); `bun run test ./test/kete/gateway.test.ts -t offline` (zero requests); `bun run test ./test/kete/policy-sync.test.ts -t offline` (no sync or registration request; the cached deny policy still applies); in `packages/cli`: `bun test ./test/kete/offline-startup.test.ts` (sets `OPENCODE_DISABLE_MODELS_FETCH`/`OPENCODE_DISABLE_AUTOUPDATE`; forces standalone; refuses `--server`), `bun test ./test/kete/updater.test.ts -t offline` |
| AC6 | in `packages/core`: `bun run test ./test/kete/local-models.test.ts -t tools` (tools removed and system notice added for `tools:false`; config `providers.vllm.models.<id>.capabilities.tools: true` keeps them); TUI/app notice: the AC2 tui/app commands with `-t notice` |
| AC7 | in `packages/core`: `bun run test ./test/kete/local-models.test.ts -t context` (pure function cases; warning logged once and returned in status) |
| AC8 | `test -f docs/local-models.md && grep -q "Local models" README.md`; `node scripts/agent/card-check.mjs` (after the librarian adds `local-models.md`); `bun run --cwd packages/kete-tools upstream:check`; `bun run check:generated` in `packages/protocol` and `packages/client`; `bun run typecheck` in util, schema, core, cli, tui, app; `bun run test ./test/kete` in core, `bun test ./test/kete` in util/cli/tui, `bun run test:unit` in app; `bun run test ./test/plugin/provider-ollama.test.ts ./test/plugin/provider-lmstudio.test.ts ./test/plugin/provider-vllm.test.ts` in core (upstream tests still pass); `bun run lint` (root); before the PR `bun run --cwd packages/kete-tools verify --base main` |

## Risks and recommended adjustments (pre-approved by the user)
- **R1 Status semantics.** If `unreachable` were shown for the default ports of all three
  providers, every user without local servers would see three warnings. Adjustment:
  `not_configured` = no host set and the default port refuses the connection; only explicitly set
  hosts, or a default port that answers badly, are `unreachable`. The picker shows the line only
  for `unreachable`.
- **R2 `num_ctx` (D4).** Kete talks to Ollama through its OpenAI-compatible `/v1` endpoint, which
  ignores `options.num_ctx`. No API on this path accepts it. Adjustment: don't send `num_ctx`
  (sending it would be a fake fix); warn only, as D4 already says. Possible follow-up: clamp
  `limit.context` to a known served window so compaction triggers before Ollama truncates silently.
- **R3 First-run "sets the default model".** `PATCH /api/experimental/config` only accepts `shell`.
  Adjustment: accepting selects the model through each client's own persisted selection (TUI
  `local.model.set`, web selection). No config write and no new server endpoint.
- **R4 Offline scope.** models.dev and update checks are process-wide and decided at start from
  flag, env or **global** config. A `kete.offline` set only in project config applies to
  everything location-scoped (models, MCP, web tools, gateway, sync, runner check) but not to the
  models.dev fetch. The docs will say so. There is no request-executor guard (job mode's
  chokepoint), because the server can't know per-location which hosts are "local". Fail-closed
  rests on the model list (the only source requests resolve from) plus the runner check. A
  follow-up can add an executor guard for process-wide offline.
- **R5 "Local" for Ollama/LM Studio/vLLM by provider ID** (spec D5): a public-IP Ollama host is
  still allowed offline. Other providers count as local only when the base URL host is an IP
  literal in a private or loopback range, or `localhost`. LAN hostnames such as `gpu.lan` are
  not, because classifying them would need DNS. The docs say to use the IP.
- **R6 LSP auto-download doesn't exist in this v2 runtime** (no LSP module in `core/src`; no
  `OPENCODE_DISABLE_LSP_DOWNLOAD` reader). Nothing to turn off; the docs list it as not applicable.
- **R7 The no-tools user notice is client-side** (TUI toast on selection / once per session; web
  composer line once per session). A server-to-user notice channel doesn't exist; the agent gets
  the server-side system notice.
- **R8 Size.** About 60 files across 7 packages. If verification fails twice, split the build:
  (A) util/schema/core/cli, (B) tui/app, (C) docs.
- **Security.** Offline only removes models, servers and tools; it never touches permission rules.
  The plugin is guarded so repository config can't remove it. The insecure-host path never
  disables TLS checks. Pull downloads only through the user's own Ollama and is refused offline.
  RPC status never returns API keys. Error text is capped and contains no request headers.

## Cards to update after the build
- **new** `docs/context/modules/local-models.md`: hosts, the status RPC, rediscovery, no-tools
  hook, context warning, offline plugin, pull command, pickers (Quick answers from handoff gaps)
- `config-kete.md`: `kete.offline` field
- `gateway.md`, `sync.md`, `runtime-registration.md`: offline no-op behaviour
- `attribution-hosted.md`: outbound-call list and offline (spec item 5; done in step 15)
- `cli.md`: `--offline`, `kete models pull`, offline refusals, the server-connection rule
- `brand-env.md`: `KETE_OFFLINE`, `KETE_OLLAMA_HOST`, `KETE_LMSTUDIO_HOST`, `KETE_VLLM_HOST` (bridged; `OLLAMA_HOST` read unbridged)
- `permissions.md`: `post` order now includes `kete.local-models` and `kete.offline` (no `evaluate` hooks)
- `web-app.md`, `ui-branding.md`: panel offer, Offline indicator, picker Local group
- `docs/context/commands.md`: new test files
