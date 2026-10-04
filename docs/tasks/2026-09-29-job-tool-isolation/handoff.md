# Handoff: Job isolation: tools under a second user via a root helper (platform ADR 0019, jobs.md §8)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-29 coordinator

- spec.md approved by the user (2026-09-29). User decisions: start cloud-job runtime work with pieces 1 (process seam) and 5 (job-mode config and model requests); the root helper will be written in Go (later task). Source requirements: kete-code-platform docs/jobs.md §8 and ADRs 0018–0021 (merged in platform #40).

## 2026-09-29 planner

- Done: plan.md written (large task: 2 upstream edits, `server/src/routes.ts` and `core/src/plugin/internal.ts`; new image↔runtime env contract; security). Decisions D1–D8 need the user's answer before build.
- Stale cards: `kete-tools-ci` is stale (packages/kete-tools/src/lib.ts changed since 9967c9c3a2). This plan neither relies on it nor changes kete-tools (the AC1 check is a core Kete test), so it did not block planning. The librarian should refresh it separately.
- Spawn sites found: 21 rows in plan.md §1. About 17 go through upstream's `ChildProcessSpawner` service (`CrossSpawnSpawner.node`, directly, via `AppProcess` or via `Environment.spawner`). 4 spawn directly: `core/src/pty.ts`→`#pty`, `core/src/persistent-pty/daemon.ts`, `util/src/kete/secret-store.ts`, `cli/src/kete/job-git.ts`. There's also the CLI self-spawn (`standalone.ts`) and client-only spawns (`session/list.ts` pager, the disabled updater). No LSP client exists in the v2 runtime.
- Docs enough: no. Missing: no card covers process spawning (`ChildProcessSpawner`/`CrossSpawnSpawner.node`/`AppProcess`/`Environment.spawner`, and the workerd precedent `server/src/workerd.ts:79` of replacing it with a refusing stub).
- Docs enough: no. Missing: no card covers the LayerNode replacement graph (`server/src/routes.ts` `standard`/`build`, `core/src/instance.ts` vanilla replacements, how location nodes are replaced through `overrides`).
- Docs enough: no. Missing: PTY paths (`core/src/pty.ts` in-process vs `persistent-pty/daemon.ts` spawning `opencode-pty`) aren't in any card.
- Docs enough: no. Missing: config-kete doesn't say that `Config.configured({project:false})` / `KETE_CONFIG_PROJECT_DISABLE` turns off the whole project walk (repo `kete.json(c)`, `.kete/`, `.claude/`, `.agents/`), or that `ConfigPluginSource.empty` means precompiled plugins only.
- Docs enough: no. Missing: no card covers the model-request path. Session hooks (`model.request`, `http.request`) can't fail; `RequestExecutor` (`core/src/effect/app-node-platform.ts:7`) is the single failable chokepoint for every model HTTP request, including `Generate`, which bypasses session hooks.
- Docs enough: no. Missing: the gateway card doesn't map each gateway route to its wire protocol (anthropic-messages, openai-responses/chat, gemini, openai-chat compat) or say that transport comes from `provider.settings.transport` (openai defaults to websocket).
- Docs enough: no. Missing: the formatter service (`core/src/formatter.ts`, `State.Transformable`, with no plugin-context domain) and the MCP editor (`ctx.mcp.transform`) aren't in a card.
- Open for the implementer: build requests per protocol in tests from `packages/ai/test/lib/http.ts` and `executor.test.ts`. Confirm how an `AIError` `InvalidRequestError` surfaces on `session.execution.failed`. Confirm `Mcp.ServerConfig.disabled` exists on both local and remote configs.

## 2026-09-29 coordinator

- plan.md approved by the user (2026-09-29): D3b keep AGENTS.md/CLAUDE.md instructions; D4b required KETE_JOB_MAX_OUTPUT_TOKENS; D6 merge in parts (stub only, helper follows); D1, D2, D5, D7, D8 at the planner defaults.

## 2026-09-29 implementer

Built the plan (steps 1-10). All new files under `kete/` paths, no markers. 2 upstream edits as planned, both marked.

**Files created:**
- `packages/util/src/kete/job-mode.ts` — `KeteJobMode`: `read`/`enabled` (fail-closed on invalid), `refuseSpawn`, `maxOutputTokens`, shared refusal `message()`.
- `packages/util/src/kete/tool-runner.ts` — `KeteToolRunner`: `Interface`, `unavailable` fail-closed stub (refuses piped commands too, naming the first stage), `layer(runner)`.
- `packages/cli/src/kete/job-connection.ts` — pure `resolve(args, env)`: job mode refuses `--server`, forces `standalone: true` otherwise.
- `packages/core/src/kete/job-request.ts` + `job-request/{anthropic-messages,openai-responses,openai-chat,gemini}.ts` — `family(url)` classification, per-protocol pure `conform`, `layer(limits)` wrapping the real `RequestExecutor.layer` (built via `Layer.build` + `Context.get`, not a raw-layer replacement — see decision below).
- `packages/core/src/kete/job-plugin.ts` — `KeteJobPlugin.Plugin` (`kete.job-mode`): disables every MCP server, removes every non-`kete` model; no-op off.
- `packages/server/src/kete/job-server.ts` — `KeteJobServer.replacements(options, mode)`: `[]` off, throws on invalid, else the 8-item replacement list (Config, ConfigPluginSource, CrossSpawnSpawner→KeteToolRunner, Pty, PersistentPty, Formatter, RequestExecutor, WebSocketConstructor).
- Tests: `util/test/kete/{job-mode,tool-runner}.test.ts`, `cli/test/kete/job-connection.test.ts`, `core/test/kete/{job-request,job-request-service,job-plugin,job-spawn-sites}.test.ts`, `server/test/kete/job-mode.test.ts`.

**Files changed:**
- `packages/util/src/kete/secret-store.ts`, `packages/cli/src/kete/job-git.ts` — `KeteJobMode.refuseSpawn` before the direct spawn (`RunOptions.env` added to job-git.ts for tests).
- `packages/cli/src/kete/job.ts` — wired `JobConnection.resolve`; a refusal ends as `refused` (exit 2), text and `--json`.
- `packages/core/src/kete/run-checks.ts` — job mode + interactive → `StepFailedError({type:"unattended", message: KeteUnattendedSchema.jobMode()})`.
- `packages/core/src/kete/sync/plugin.ts` — registration skipped + one info line when `KeteJobMode.enabled(runtimeEnvironment)`.
- `packages/schema/src/kete/unattended.ts` — added `jobMode()` (see deviation below).
- `packages/core/test/kete/{unattended-service,policy-sync}.test.ts` — extended for AC3/AC6.
- `packages/server/package.json` — added `@opencode/ai` as a direct dependency (was transitive via core); `bun install` run, `bun.lock` updated. JSON, no marker possible — recorded in `docs/upstream-patches.md`.
- `docs/jobs.md`, `packages/core/src/kete/skill/kete.md`, `docs/upstream-patches.md` — docs.

**Upstream edits (2, both marked):**
- `packages/server/src/routes.ts`: import + `...KeteJobServer.replacements(options)` appended last in `build`'s replacement list.
- `packages/core/src/plugin/internal.ts`: import + `KeteJobPlugin.Plugin` registered in `post` immediately before `KeteUnattended.Plugin` (last) + its id added to the existing marked `guarded` block.

**Deviations from the plan's letter (design intent unchanged, flagging for review):**
1. `packages/schema/src/kete/unattended.ts` is marked "read" in plan.md's Files table but I added one function, `jobMode()`, returning `"Unattended run refused: job mode requires every session to be unattended (kete.unattended)."` — classify()'s existing prefix match ("Unattended run refused:") already makes this classify as `"refused"` without touching `classify` itself. The plan's own text said the job-mode-implies-unattended message must be "built by `KeteUnattendedSchema` so that `classify` returns `refused`", which isn't achievable by reusing the existing `refused(missing)` builder (wrong semantics — it's about missing budget/timeout, not "not unattended at all") without either a new schema function or reusing existing wording verbatim. I judged adding the minimal new function was truer to the plan's stated *behavior* than leaving `classify` unsatisfied. This is a Kete-owned file (`kete/` path, no upstream marker), low risk.
2. `job-request.ts`'s `RequestExecutor` replacement in `job-server.ts` is wired as a `makeGlobalNode({service: RequestExecutor.Service, layer: KeteJobRequest.layer(limits), deps: [httpClient]})` **node** replacement, not a raw closed `Layer` — `LayerNode`'s type system requires a raw-layer `.replace()` target to have `R = never` (a closed layer), and `KeteJobRequest.layer(limits)` still needs `HttpClient.HttpClient`. This needed `@opencode/ai`'s `RequestExecutor.Service` tag directly in `packages/server`, hence the new dependency (deviation 3 below). Plan's Files table for `job-server.ts` didn't foresee this; it's a mechanical consequence of the type system, not a design change.
3. `packages/server/package.json` gained `@opencode/ai` as a direct dependency (JSON, no marker; precedent already exists in `docs/upstream-patches.md` for this file). Needed for `RequestExecutor.Service` per (2).
4. Server e2e test (`server/test/kete/job-mode.test.ts`) drops the plan's (e) formatter-no-op sub-case and the `.kete/plugins/p.ts` marker sub-case of (c), and uses `client.config.get()` (not `agent.list()`/`mcp.list()`'s location-form endpoints) for (b)/(c)/(f). Investigated: `agent.list({location})`/`mcp.list({location})` returned **empty regardless of job mode** in the embedded-routes harness (no seeded `ModelsDev` catalog — `ModelsDev.configured({fetch:false})`), even for a control case with real repo agents on disk, confirmed by manual instrumentation. `config.get()` is not model-catalog-dependent and reliably showed the repo's `kete.json` document and `.kete/` directory entry appear only when job mode is off — a strong, correct proxy for D3 ("ignore, don't narrow"). The (a) shell-refusal and (d) PTY-refusal checks work exactly as planned (session+prompt via `TestLLM`, matching `job-run.test.ts`'s proven pattern). Gap: the formatter no-op and the plugin-marker case are not separately e2e-tested; both are covered indirectly (formatter: `Formatter.node`'s replacement layer is unit-testable and the AC1 static test classifies `formatter.ts`/`formatter/builtins.ts`; plugins: `ConfigPluginSource.node.replace(ConfigPluginSource.empty)` is the same mechanism the workerd profile already uses, unmodified).

**AC1 static test note:** the allowlist ended up larger than the plan's 21-row table (43 raw regex matches → 40 real files after excluding 3 pure false positives: `packages/cli/src/node/target.ts` — a `@lydell/node-pty-${platform}` *string*, not an import, so the node-pty pattern in the test requires `from "..."` syntax; nothing else needed narrowing). New rows beyond the plan's table, all category `implementation` (graph-wiring infra, not spawn call sites): `core/src/effect/app-node-builder.ts`, `core/src/instance.ts`, `util/src/npm.ts`, `cli/src/commands/handlers/default.ts` (generic `LayerNode.compile(...)` calls with no `CrossSpawnSpawner`/`AppProcess`), `core/src/environment/{driver,environment,local,unavailable,memory}.ts` (the `Environment.spawner` abstraction's own definition and upstream's own always-refusing fakes), `cli/src/index.ts` and `cli/src/server-process.ts` (the CLI's and `kete serve`'s own top-level graphs, which compile the real un-replaced `AppProcess.node`/`CrossSpawnSpawner.node` — reasoned, not proven by a test, that this is safe because (a) the CLI's own `AppProcess` consumers are the pager and the disabled updater, both separately classified `client-only`/`replaced-node`, and (b) `server-process.ts`'s outer graph is shadowed by `routes.ts`'s own inner `AppNodeBuilder.build` graph for the actual request-serving path, per ordinary Effect Layer nesting semantics (innermost `Effect.provide` wins) — **this reasoning is not independently verified against the real `kete serve` binary** (only against `createEmbeddedRoutes`, which never goes through `server-process.ts`); worth a reviewer's or a later task's attention if the image's own smoke test (docs/jobs.md's "Risks") doesn't already cover it), `server/src/workerd.ts` and `server/src/kete/job-server.ts` (the two `CrossSpawnSpawner.node` replacement sites themselves, not calls).

**Checks (all PASS unless noted):**
- AC1: core `job-spawn-sites.test.ts` — 4 pass.
- AC2: util `bun test ./test/kete` (87 pass), cli `bun test ./test/kete` (118 pass), server `bun run test` (76 pass, includes AC3/AC4 e2e). core targeted (`shell/tool-shell/git/formatter/mcp/persistent-pty-daemon/pty`): 210 pass, **7 pre-existing failures** (ShellTool process-substitution/compound-syntax timing, one MCP reconnect test) — confirmed via `git stash`/re-run against the unmodified tree: identical 7 failures, unrelated to this work. core full `bun run test`: 5696 pass, 30 fail — the same 7 plus ~23 `ripgrep` tests that need a network download (`GET https://github.com/.../ripgrep-*.tar.gz`) the sandbox blocks; not caused by this change (ripgrep.ts untouched).
- AC3/AC4: util `tool-runner.test.ts`, server `job-mode.test.ts`, core `job-plugin.test.ts`/`unattended-service.test.ts`, cli `job-connection.test.ts` — all pass (counted above).
- AC5: core `job-request.test.ts` (21 pass) + `job-request-service.test.ts` (8 pass, real `@opencode/ai` protocol wiring over a fake `HttpClient`).
- AC6: core `policy-sync.test.ts` (10 pass).
- AC7: `bun turbo typecheck` PASS; root `bun run lint` PASS; `upstream:check` PASS; `bun run --cwd packages/kete-tools verify --base main` PASS (772.7s) — confirms the pre-existing core failures (ShellTool timing, 1 MCP reconnect, ~23 ripgrep-network tests) are already on `main` and this change introduces no new failures.

**Open questions for review:**
- The `cli/index.ts`/`server-process.ts` `AppProcess.node` classification (deviation/note above) — confirm the Layer-shadowing reasoning, or add an explicit e2e check against the real `kete serve` binary (not `createEmbeddedRoutes`) in a later task.
- The server e2e test's simplifications (deviation 4) — acceptable, or worth a follow-up task to wire `agent.list`/`mcp.list` properly (would need a seeded `ModelsDev` catalog in the embedded-routes harness) and add the formatter/plugin-marker sub-cases.
- `schema/kete/unattended.ts`'s new `jobMode()` function (deviation 1) — confirm the wording, or supply the plan's originally-intended exact text if different from what I inferred.

## 2026-09-29 coordinator — real-binary smoke test

- Built the CLI binary from this branch (`bun run build --single --skip-install --skip-web-ui`) and ran `kete serve` with isolated HOME/XDG. Control (job mode off): `POST /api/shell` spawned `touch` and the marker file appeared. Job mode (`KETE_JOB_MODE=1`, `KETE_JOB_MAX_OUTPUT_TOKENS=4096`): authenticated `GET /api/shell` 200; `POST /api/shell` and `POST /api/pty` spawned nothing (no marker); the log shows `KeteToolRunner.spawn: Job mode: tools run only through the job's tool runner, which this build doesn't have yet` and `runtime registration is off in job mode`. The shell refusal reaches the HTTP client as a bare 500 with an empty body — follow-up: a typed error.
