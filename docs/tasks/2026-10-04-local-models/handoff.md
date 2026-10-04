# Handoff: Local models: remote Ollama, setup and picker, offline mode, capabilities

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-04 planner
- Done: plan.md written (Large: upstream edits, config schema `kete.offline` + regen, new public contracts, offline security). All cards read were current (`stale-cards.mjs`: all current).
- Decisions: status and rediscovery go through a plugin RPC (`kete.local-models`, existing `POST /api/rpc/:rpcID/:method`), so there is no new HTTP endpoint; env hosts go in through the upstream plugins' `origin` parameter (config still wins via upstream `configured()`); offline is process-wide from flag, env or global config through the existing `OPENCODE_DISABLE_MODELS_FETCH`/`OPENCODE_DISABLE_AUTOUPDATE` switches, plus location-scoped plugin filters and the runner check; no-tools models go through the `session.context` hook. Risks R1–R8 hold the pre-approved adjustments (status semantics, no `num_ctx`, client-side default model, offline scope, LAN hostnames, no LSP download in v2, client-side notice, build split).
- Docs enough: no — missing: no card covers the upstream local provider plugins (`core/src/plugin/provider/{ollama,lmstudio,vllm}.ts`: `make(origin)`, `configured()` endpoints, discovery cache and silent failure); opened the code.
- Docs enough: no — missing: plugin RPC (`ctx.rpc.register` in `plugin/src/effect/rpc.ts`, client `client.rpc(Definition)` in `client/src/promise/rpc.ts`, plugin event stream includes `rpc.*` events, `core/src/plugin/host.ts:256-264`).
- Docs enough: no — missing: the `session.context` hook can remove tools and add system parts; removed entries are dropped (`core/src/session/model-request.ts:206-231`).
- Docs enough: no — missing: CLI handler map supports `{ $, sub }` for a command with subcommands (`cli/src/framework/runtime.ts:43-75`), and global flags are registered in `runtime.ts:85`.
- Docs enough: no — missing: TUI plugin slots and toast (`plugin/src/tui/context.ts:191-203,462-512`), TUI model dialog (`tui/src/component/dialog-model.tsx`), web picker files (`app/src/providers/models/*`), web API client (`app/src/runtime/server/api.ts`, `client.tsx`).
- Docs enough: no — missing: `ModelUnavailableError` (`core/src/session/runner/model.ts:20-30`) is where a filtered-out model fails, before the runner check.
- Docs enough: no — missing: the config PATCH endpoint accepts only `shell` (`schema/src/config.ts:114-116`); LSP auto-download doesn't exist in v2 core.
- Open questions: none blocking. Executor-level offline guard deferred (R4).
