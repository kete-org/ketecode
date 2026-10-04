# Plan: Job mode, part 1: a process seam and job-mode config and model requests

> **Large task, needs the user's approval before building.** It has upstream edits (2 files,
> listed at the end), a new image ↔ runtime contract (`KETE_JOB_MODE`,
> `KETE_JOB_MAX_OUTPUT_TOKENS`), and security changes (fail-closed process refusal, ignoring repo
> configuration, model-request enforcement). It changes no config schema and no server endpoint,
> so no protocol/client regeneration is needed. Decisions D1–D8 (at the end) need the user's answer
> first.

## Cards read
- docs/context/modules/unattended.md (verified-at d5cd08f36b, stale: no)
- docs/context/modules/audit-log.md (checked, stale: no; not changed by this plan)
- docs/context/modules/cli.md (verified-at d5cd08f36b, stale: no)
- docs/context/modules/permissions.md (verified-at d5cd08f36b, stale: no)
- docs/context/modules/runtime-registration.md (verified-at 715843563a, stale: no)
- docs/context/modules/sync.md (verified-at 715843563a, stale: no)
- docs/context/modules/gateway.md (verified-at bfd6c66, stale: no)
- docs/context/modules/config-kete.md (verified-at 715843563a, stale: no)
- docs/context/modules/brand-env.md (verified-at bfd6c66, stale: no)
- docs/context/modules/attribution-hosted.md (stale: no)
- docs/context/modules/server-sdk.md (verified-at d5cd08f36b, stale: no)
- docs/context/modules/kete-tools-ci.md: **stale**, but this plan doesn't rely on or change
  kete-tools. The AC1 check is a core Kete test, not an `upstream:check` step.
- No card covers the shell tool, PTY, git service, formatters, MCP stdio, the LayerNode
  replacement graph or the model request executor, so those were read in code. The gaps are logged
  in handoff.md.

## Design

### 1. The process seam: every spawn site, and how each is handled

**Finding:** upstream already sends almost every spawn through one Effect service,
`ChildProcessSpawner`. `CrossSpawnSpawner.node` (`packages/util/src/cross-spawn-spawner.ts:550`)
provides it, used directly, through `AppProcess` (`util/src/process.ts:268`, deps
`[CrossSpawnSpawner.node]`) or through `Environment.spawner` (`core/src/environment/environment.ts:40`).
Upstream already swaps it for a refusing stub in the workerd profile
(`server/src/workerd.ts:79`, `CrossSpawnSpawner.node.replace(EnvironmentUnavailable.layer)`). So
the seam is that service (upstream-first, CLAUDE.md §4 step 4: DI at an existing seam). Kete owns
the job-mode implementation, the tool-runner interface and the replacement list.

| # | Site | Starts | Path | Job-mode handling |
|---|---|---|---|---|
| 1 | `core/src/shell.ts:297` | shell tool commands | `Environment.spawner` | refused by the stub runner |
| 2 | `core/src/mcp/stdio.ts:80` | MCP stdio servers | `Environment.spawner` | never started: every MCP server disabled (plugin); also refused by the stub |
| 3 | `core/src/ripgrep.ts:120`, `core/src/ripgrep/binary.ts:41` | `rg` (grep/glob tools) | `Environment.spawner` / `ChildProcessSpawner` | refused by the stub |
| 4 | `core/src/environment/exec-defaults.ts:82` | `sh -c` file-op fallback | environment spawner | refused by the stub |
| 5 | `core/src/git.ts:317,445,633,729` | git (Git service: project, snapshot, vcs, worktree) | `AppProcess` | refused by the stub (git errors already degrade to "not a repo", `git.ts:722-724`) |
| 6 | `core/src/kete/git.ts:35` | git (KeteGit) | `AppProcess` | refused by the stub |
| 7 | `core/src/plugin/vcs/git.ts:172`, `plugin/vcs/hg.ts:157`, `core/src/project.ts:306` | git / hg | `AppProcess` | refused by the stub |
| 8 | `core/src/formatter.ts:67`, `core/src/formatter/builtins.ts:30` | formatters | `AppProcess` | never started: `Formatter.node` replaced with a disabled layer; also refused by the stub |
| 9 | `core/src/worktree.ts:247` | worktree `commands.start` script | `AppProcess` | refused by the stub |
| 10 | `core/src/integration.ts:625` | integration auth command | `AppProcess` | refused by the stub |
| 11 | `core/src/config/plugin/command.ts:226` | shell substitution in command templates | `AppProcess` | refused by the stub |
| 12 | `core/src/plugin/provider/azure.ts:38` | `az` CLI token | `AppProcess` | refused by the stub (and only the `kete` provider is usable, D4) |
| 13 | `core/src/workspace.ts:255-286` | remote workspace spawner | provider plugin connection | no workspace providers: disk plugins are off in job mode |
| 14 | `core/src/pty.ts:183-184` → `#pty` (`pty/pty.bun.ts:23`, `pty/pty.node.ts:13`) | interactive PTYs | **direct** (bun-pty/node-pty) | `Pty.node` replaced with a refusing layer (workerd precedent, `workerd.ts:127-139`) |
| 15 | `core/src/persistent-pty/daemon.ts:230` | `opencode-pty daemon` (spawns agent PTY shells) | **direct** `node:child_process` | `PersistentPty.node` replaced with a layer that fails every op with `PersistentPty.UnavailableError` |
| 16 | `util/src/kete/secret-store.ts:177` | OS keychain CLI | **direct** (Kete-owned) | `KeteJobMode.refuseSpawn("OS credential store")` before `spawn` |
| 17 | `cli/src/kete/job-git.ts:35` | `git worktree add` for `kete job run` | **direct** `execFile` (Kete-owned) | `KeteJobMode.refuseSpawn("git")` before `execFile`, so a job-mode `kete job run` stops with `refused` (D6) |
| 18 | `cli/src/services/standalone.ts:43` | the runtime's own `kete serve --stdio` | own `CrossSpawnSpawner` compile | **allowed** (self, fixed argv, not a tool; D5). The child inherits `OPENCODE_JOB_MODE` |
| 19 | `cli/src/commands/handlers/session/list.ts:68` | pager for `kete session list` | own `AppProcess` compile | client-only command, not run in a job (D7) |
| 20 | `cli/src/services/updater.ts:156` | self-update | `AppProcess` | dead in Kete: `UpdaterDisabled.layer` replaces it (`cli/src/index.ts:120`) |
| 21 | `util/src/cross-spawn-spawner.ts` (`launch` and `exec taskkill` at `:342`), `util/src/process.ts` | the spawner implementation | — | the implementation behind the seam |

Not present: **no LSP client exists in the v2 runtime** (only v1 config migration and TODOs at
`core/src/file-mutation.ts:131`, `core/src/tool/plugin/edit.ts:107`). The TUI package
(`packages/tui`, editor/clipboard helpers) is a client and is outside the runtime packages; a job
runs no TUI (D7).

**Kete pieces:**
- `packages/util/src/kete/tool-runner.ts` (`KeteToolRunner`):
  - `interface Interface { spawn(command: ChildProcess.Command): Effect<ChildProcessHandle, PlatformError, Scope> }`.
    This is the root-helper client's future contract. It takes the command as data (argv, cwd,
    env), the same value the spawner receives.
  - `unavailable: Interface`, the fail-closed stub. It fails with a `PlatformError` system error
    (`module: "KeteToolRunner"`, `method: "spawn"`, copying `core/src/environment/unavailable.ts`)
    with the message: "Job mode: tools run only through the job's tool runner, which this build
    doesn't have yet; refused to start `<basename of argv[0]>`." The message never includes
    arguments or env, which may hold secrets.
  - `layer(runner): Layer<ChildProcessSpawner>` = `Layer.succeed(ChildProcessSpawner, make(runner.spawn))`.
    Piped commands also reach `runner.spawn`, and the stub refuses them.
- `packages/util/src/kete/job-mode.ts` (`KeteJobMode`): `variable = "OPENCODE_JOB_MODE"`,
  `publicName = "KETE_JOB_MODE"`, `read(env = process.env): {kind:"off"}|{kind:"on"}|{kind:"invalid",value}`
  (`"1"` → on; unset or `""` → off; anything else → invalid, value truncated to 50 characters),
  `enabled(env)` (on **or invalid** → `true`: readers fail closed), `refuseSpawn(what, env)` (throws
  `SpawnRefusedError` with the same wording as the stub when enabled), and
  `maxOutputTokens(env)` (D4; `OPENCODE_JOB_MAX_OUTPUT_TOKENS`, a positive integer, else `undefined`).
- The job-mode replacement list (section 3) swaps `CrossSpawnSpawner.node` for
  `KeteToolRunner.layer(KeteToolRunner.unavailable)`, plus the Pty, PersistentPty and Formatter
  replacements.

**AC1 enforcement:** `packages/core/test/kete/job-spawn-sites.test.ts`. It is a static check that
runs in CI, since CI runs every `packages/*/test/kete`. It walks `packages/{core,server,cli,util}/src/**/*.ts`
(excluding `*.test.ts`) and matches spawn primitives: `node:child_process`/`"child_process"`,
`cross-spawn`, `Bun.spawn`, `spawnSync`, `execFile`, `execSync`, `bun-pty`, `node-pty`,
`ChildProcess.make(`, `.spawn(`/`spawner.spawn`, `ChildProcessSpawner` `make(`, `Bun.$`, and
`LayerNode.compile(` with `CrossSpawnSpawner`/`AppProcess` (a spawner compiled outside the server
graph). It compares the matching files with an explicit allowlist keyed by path. Each entry has a
category (`seam` | `replaced-node` | `kete-guard` | `self` | `client-only` | `implementation`) and
a one-line reason, as in the table above. Any matching file that isn't listed, or a listed file
that no longer matches, fails the test with "classify this spawn site (see
docs/jobs.md "Job mode")". A second test asserts that each `kete-guard` file calls
`KeteJobMode.refuseSpawn` before its spawn.

### 2. How job mode is marked (D2)
An **environment variable only**: `KETE_JOB_MODE=1`, set by the image entrypoint and bridged to
`OPENCODE_JOB_MODE` by the existing prefix bridge (`util/src/kete/env.ts`, no new code). Why:
- The decision has to hold in the **server** process, where tools run. `kete job run` is a client.
  A CLI option would reach only the client and would still have to become an env var for the
  standalone server child. An env var reaches both, and a future entrypoint-run `kete serve` on a
  unix socket too.
- It's explicit, never inferred, and an invalid value fails closed. The server refuses to start
  with `KETE_JOB_MODE must be "1" or unset`. Every other reader treats invalid as on.
- `kete job run` in job mode (Kete-owned `cli/src/kete/job-connection.ts`, pure): it refuses
  `--server` and the background service, because it can't verify that another process is in job
  mode, and it always starts a standalone server, which inherits the variable.

**Job mode implies unattended:** `core/src/kete/run-checks.ts` (Kete-owned, the per-step
chokepoint `session/runner/llm.ts:229`). When job mode is on and `KeteUnattendedPolicy.resolve`
returns `interactive`, it refuses the step with `StepFailedError({type:"unattended"})`, the text
built by `KeteUnattendedSchema` so that `classify` returns `"refused"`: "Job mode: every session
must be unattended (kete.unattended)". No step runs, so no tool or model request runs, in a
job-mode session that isn't unattended. `kete job run` already sets the metadata.

### 3. Job-mode configuration (D3): ignore, don't narrow
One Kete-owned function, `packages/server/src/kete/job-server.ts` `KeteJobServer.replacements(options, mode = KeteJobMode.read(process.env))`.
It returns `[]` when off, throws on invalid, and when on returns:

| Replacement | Effect |
|---|---|
| `Config.node.replace(Config.configured({ project: false, file: options.config?.file, content: options.config?.content }))` | no project walk (`core/src/config/discovery.ts:34-37`): the repo's `kete.json`/`kete.jsonc`, `.kete/` (config, agents, skills, commands, modes, plugin dirs, MCP), and the repo's `.claude/` and `.agents/` are **ignored**. The global config dir (the `kete` user's, `0700`) still loads. That is where `kete.runtime.type: "kete_cloud"` lives (§8 item 8). The entrypoint's `KETE_CONFIG`/`KETE_CONFIG_CONTENT` still load |
| `ConfigPluginSource.node.replace(ConfigPluginSource.empty)` | **no plugin code from disk at all**, global included; built-in (precompiled) plugins only (workerd precedent, `workerd.ts:85-87`) |
| `CrossSpawnSpawner.node.replace(KeteToolRunner.layer(KeteToolRunner.unavailable))` | section 1 |
| `Pty.node.replace(…)`, `PersistentPty.node.replace(…)`, `Formatter.node.replace(…)` | section 1 |
| `LayerNodePlatform.requestExecutor.replace(KeteJobRequest.layer(…))`, `LayerNodePlatform.webSocketConstructor.replace(…refusing…)` | section 4 |

Wired by **one upstream edit** in `packages/server/src/routes.ts` `build` (`:141-148`): append
`...KeteJobServer.replacements(options)` after `...overrides`, so job mode wins over every other
replacement and private instances inherit it (they read the same lazy list).

MCP, agents and plugins from other sources are handled by `core/src/kete/job-plugin.ts`
(`KeteJobPlugin.Plugin`, `id: "kete.job-mode"`). It's a no-op outside job mode. It's registered in
`plugin/internal.ts` `post` **immediately before** `KeteUnattended.Plugin`, which stays last, and
its id is added to `guarded`. In job mode:
- `ctx.mcp.transform`: sets `disabled: true` on **every** MCP server: global config, well-known and
  platform-synced, stdio and remote (D12). It's after `KeteAgentSync.Plugin`, so synced servers are
  covered.
- `ctx.model.transform`: removes every model whose provider isn't `KeteGateway.providerID` (D4).

Project instructions (`AGENTS.md`/`CLAUDE.md`) stay loaded: `InstructionDiscovery` still follows
`options.config.project` (`routes.ts:130`), which job mode doesn't change. That's D3b.

### 4. Job-mode model requests (D4)
**Where:** a Kete `RequestExecutor` (`@opencode/ai/route`) layer replacing
`LayerNodePlatform.requestExecutor` (`core/src/effect/app-node-platform.ts:7`). Every model HTTP
request goes through it: session steps, compaction, title, `Generate` (`core/src/generate.ts:63`,
which bypasses session hooks) and image clients. It can **fail with a typed error before any
bytes are sent**. The session `http.request` hook can't do that: session hooks can't fail
(`plugin/hooks.ts:23-30`, pitfalls.md).

`KeteJobRequest.layer(limits)` builds the real executor internally (deps `[httpClient]`). For each
`execute(request, middleware)`:
1. Non-`POST` requests pass through unchanged. They aren't model requests: media fetches go
   through the VM's proxy allowlist.
2. `family(url)` classifies the wire protocol by the gateway route path (`gateway.ts:97-128`), not
   by model name: `…/anthropic/v1/messages` → `anthropic-messages`; `…/openai/v1/responses` →
   `openai-responses`; `…/openai/v1/chat/completions` and `…/compat/{deepseek,openrouter}/v1/chat/completions`
   → `openai-chat` (with the openrouter extras); `…/gemini/v1beta/models/*:generateContent|:streamGenerateContent`
   → `gemini`. Anything else (a count-tokens endpoint, an unknown route) → **refused**, as in
   gateway rule 8.
3. It parses the JSON body. A body that isn't JSON, or a stream body, is refused.
4. It runs the family's `conform(body, limits)` (one Kete adapter file per family) →
   `{ok, body}` or `{refused, reason}`:

| Rule | anthropic-messages | openai-responses | openai-chat (+openrouter) | gemini |
|---|---|---|---|---|
| function tools only (rule 16) | each `tools[]` has no `type` or `type: "custom"`; `mcp_servers`, `container` present → refuse | every `tools[].type === "function"`; else refuse | every `tools[].type === "function"`; `web_search_options` → refuse; openrouter `plugins`, model id ending `:online` → refuse | every `tools[]` entry has only `functionDeclarations`; else refuse |
| one candidate | n/a | n/a | `n` > 1 → refuse | `generationConfig.candidateCount` > 1 → refuse |
| output-token limit (rule 8) | `max_tokens` = min(present, limit) or limit | `max_output_tokens` = min / limit | `max_completion_tokens` and `max_tokens` clamped; set `max_completion_tokens` if both are absent | `generationConfig.maxOutputTokens` = min / limit |
| Responses state | — | set `store: false`; `previous_response_id`, `background` (any value), `conversation` → refuse | — | `cachedContent` → refuse |
| inline content (rule 17), at every depth including tool results and system blocks | image/document `source.type` ∈ {`base64`,`text`}; `url`/`file` → refuse | `input_image.image_url` must be `data:`; `input_file.file_url` or any `file_id` → refuse | `image_url.url` must be `data:`; any `file_id` → refuse | `fileData` anywhere → refuse |

5. On refusal it fails with `AIError({ reason: InvalidRequestError({ message: "Job mode: <reason>; this request wasn't sent" }) })`
   (`ai/src/schema/errors.ts:29`). The inner executor, and so the network, is never called.
6. On success it calls the inner executor with the rewritten request, and composes the
   `middleware` so the **final** bytes (after any `http.request` hook) are checked again in the
   innermost handler. Defence in depth: in job mode the only hooks are internal plugins.

`limits.maxOutputTokens` comes from `KeteJobMode.maxOutputTokens()` (D4b). If it's missing or
invalid in job mode, every model request is refused locally with a message naming
`KETE_JOB_MAX_OUTPUT_TOKENS`.

WebSocket transport: the `kete` provider's models use HTTP (`transport` comes from
`provider.settings`, `model-resolver.ts:392`, and only the `openai` provider defaults to websocket,
`plugin/provider/openai.ts:260`). Only `kete` models survive in job mode, and job mode replaces the
WebSocket constructor with one that refuses, so no request bypasses the executor.

### 5. Registration off
`core/src/kete/sync/plugin.ts:359` (Kete-owned): register only when
`options.registration !== false && !KeteJobMode.enabled(environment)`, using the plugin's existing
`environment` override. In job mode it logs one info line: "runtime registration is off in job
mode". `runtime_type` resolution is unchanged (config, then env).

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/util/src/kete/job-mode.ts` | create | `KeteJobMode`: flag read, `enabled`, `refuseSpawn`, `maxOutputTokens` |
| `packages/util/src/kete/tool-runner.ts` | create | `KeteToolRunner`: interface, `unavailable` stub, spawner `layer` |
| `packages/util/src/kete/env.ts` | read | the bridge: confirm `KETE_JOB_MODE` → `OPENCODE_JOB_MODE` needs nothing new; `publicName` |
| `packages/util/src/kete/runtime-registration.ts` | read | `runtimeTypeVariable`/public-name pattern to copy for the new variables |
| `packages/util/src/cross-spawn-spawner.ts` | read | `node` (`:550`), the `ChildProcessSpawner` `make`/`makeHandle` imports |
| `packages/core/src/environment/unavailable.ts` | read | the refusing-spawner pattern and `systemError` shape to copy |
| `packages/util/src/kete/secret-store.ts` | change | `refuseSpawn` before `spawn` (`:177`) |
| `packages/cli/src/kete/job-git.ts` | change | `refuseSpawn` before `execFile` (`:35`); add an optional `env` to `RunOptions` for tests |
| `packages/cli/src/kete/job-connection.ts` | create | pure: job mode → refuse `--server`/the background service, force standalone |
| `packages/cli/src/kete/job.ts` | change | use `job-connection.ts`; map a refusal to a `refused` result (exit 2) |
| `packages/cli/src/kete/job-run.ts` | read | how a `git` failure/throw from `deps.git` becomes a result (must end as `refused`, not a crash) |
| `packages/cli/src/services/server-connection.ts` | read | `resolve` args (`server`, `standalone`) |
| `packages/cli/src/services/standalone.ts` | read | self-spawn: env inherited by the child (D5) |
| `packages/server/src/kete/job-server.ts` | create | `KeteJobServer.replacements`, refusing Pty/PersistentPty/WebSocket layers, disabled Formatter layer |
| `packages/server/src/routes.ts` | change (upstream, marked) | append `...KeteJobServer.replacements(options)` in `build` (`:141-148`) + import |
| `packages/server/src/workerd.ts` | read | replacement precedent (`:74-88`) and the refusing `ptyLayer` (`:127-139`) to copy |
| `packages/server/src/options.ts` | read | `ServerOptions.config` shape |
| `packages/core/src/pty.ts` | read | `Pty.Service` interface and `NotFoundError` for the refusing layer |
| `packages/core/src/persistent-pty/index.ts` | read | `Interface` (`:55-80`) and `UnavailableError` (`:48`) for the refusing layer |
| `packages/core/src/formatter.ts` | read | `Interface` (`State.Transformable<Editor>`, `file`) for the disabled layer |
| `packages/core/src/state.ts` | read | `State.create`, to build the disabled formatter's `transform` |
| `packages/core/src/config.ts` | read | `configured(options)` and `Options` (`:46-53`, `:367`) |
| `packages/core/src/config/plugin/source.ts` | read | `ConfigPluginSource.empty` (`:101`) |
| `packages/core/src/effect/app-node-platform.ts` | read | `requestExecutor`, `webSocketConstructor` nodes |
| `packages/core/src/effect/websocket-constructor.ts` | read | shape of the WebSocket constructor layer to refuse |
| `packages/ai/src/route/executor.ts`, `packages/ai/src/route/executor-service.ts` | read | `Interface.execute`, `HttpMiddleware`, `layer` (`:231-254`) |
| `packages/ai/src/schema/errors.ts` | read | `AIError`, `InvalidRequestError` fields (`:29-43`, `:158`) |
| `packages/core/src/kete/job-request.ts` | create | `KeteJobRequest`: `family(url)`, dispatch, `layer(limits)` |
| `packages/core/src/kete/job-request/anthropic-messages.ts`, `openai-responses.ts`, `openai-chat.ts`, `gemini.ts` | create | one `conform` per wire protocol (adapter-local rules, CLAUDE.md §3) |
| `packages/core/src/kete/gateway.ts` | read | `routes` (`:97-128`), `providerID` (`:37`) |
| `packages/core/src/kete/job-plugin.ts` | create | `KeteJobPlugin.Plugin`: MCP all disabled, non-`kete` models removed |
| `packages/core/src/plugin/internal.ts` | change (upstream, marked) | import and register `KeteJobPlugin.Plugin` before `KeteUnattended.Plugin` (`:316`); add its id to `guarded` (`:321-327`, inside the existing marked block) |
| `packages/plugin/src/effect/mcp.ts`, `packages/plugin/src/effect/model.ts` | read | `MCPEditor`/`ModelEditor` APIs |
| `packages/core/src/kete/run-checks.ts` | change | job mode + interactive family → refuse the step |
| `packages/core/src/kete/unattended-policy.ts` | read | `resolve` result shape |
| `packages/schema/src/kete/unattended.ts` | read | message builders and `classify`, so the job-mode refusal classifies as `refused` |
| `packages/core/src/kete/sync/plugin.ts` | change | registration off in job mode (`:359`) |
| `packages/core/test/kete/job-spawn-sites.test.ts` | create | AC1 static check |
| `packages/core/test/kete/job-request.test.ts` | create | AC5: pure `conform` per family, `family` classification, fix-vs-refuse |
| `packages/core/test/kete/job-request-service.test.ts` | create | AC5: bodies produced by the real protocol adapters (anthropic-messages, openai-responses, openai-chat, gemini) through `KeteJobRequest.layer` over a fake `HttpClient`: conforming bodies captured and checked; a URL image fails with `InvalidRequestError` and the fake client sees **zero** requests |
| `packages/ai/test/lib/http.ts`, `packages/ai/test/executor.test.ts` | read | fake HTTP client and executor test pattern |
| `packages/core/test/kete/job-plugin.test.ts` | create | AC3/AC4: MCP servers disabled, non-`kete` models removed; no-op when off |
| `packages/core/test/kete/unattended-service.test.ts` | change | AC3: job mode + no `kete.unattended` → step refused, classified `refused` |
| `packages/core/test/kete/policy-sync.test.ts` | change | AC6: job mode → zero registrations |
| `packages/server/test/kete/job-mode.test.ts` | create | AC3/AC4 end to end on an embedded server with `KeteJobServer.replacements(…, {kind:"on"})` passed as overrides |
| `packages/server/test/kete/job-run.test.ts`, `packages/server/test/session-instances.test.ts:33-180` | read | embedded server + `TestLLM` harness |
| `packages/util/test/kete/job-mode.test.ts`, `packages/util/test/kete/tool-runner.test.ts` | create | flag parsing; the stub refuses and a `touch <marker>` command creates nothing |
| `packages/cli/test/kete/job-connection.test.ts` | create | job mode refuses `--server`/the service and forces standalone; `JobGit.run` rejects in job mode |
| `docs/jobs.md` | change | new "Job mode" section: env contract, what's ignored or refused, the spawn-site table, consequences (D6) |
| `packages/core/src/kete/skill/kete.md` | change | one paragraph on job mode |
| `docs/upstream-patches.md` | change | new section "Job mode (feature/job-tool-isolation)": the 2 upstream edits and the sync checklist (re-run the spawn-site test; re-check `routes.ts` `build` order) |

## Steps
1. **util:** write `KeteJobMode` and `KeteToolRunner` with their tests (`job-mode.test.ts`,
   `tool-runner.test.ts`). The stub test spawns `touch <tmp>/marker` through
   `KeteToolRunner.layer(unavailable)` and asserts the failure message and that the marker doesn't
   exist.
2. **util/cli guards:** add `refuseSpawn` to `secret-store.ts` and `job-git.ts`. Add
   `job-connection.ts` and wire `job.ts`. A refusal ends as `refused` (exit 2) with the message, in
   text and `--json`. Tests in `cli/test/kete/job-connection.test.ts`.
3. **core, request enforcement:** write the four family files and `job-request.ts` (pure `conform`
   first, then `layer`). Tests `job-request.test.ts` and `job-request-service.test.ts`. The
   service test builds requests with the real `@opencode/ai` protocol routes, so the bodies are
   what the adapters really send.
4. **core, plugin:** write `job-plugin.ts`. Upstream edit to `plugin/internal.ts`: an import line
   with `// kete_change`, the registration line before `KeteUnattended.Plugin` with a
   `// kete_change:` comment ("before KeteUnattended.Plugin; job mode disables every MCP server
   and every non-kete model"), and the id inside the existing `guarded` marked block. Test
   `job-plugin.test.ts`.
5. **core, unattended and registration:** change `run-checks.ts` and `sync/plugin.ts`, and extend
   `unattended-service.test.ts` and `policy-sync.test.ts`.
6. **server:** write `kete/job-server.ts` (the replacement list, refusing Pty/PersistentPty/
   WebSocket layers, disabled Formatter). Upstream edit to `routes.ts`: an import line with
   `// kete_change`, and in `build` `...KeteJobServer.replacements(options), // kete_change: job
   mode wins over every replacement (docs/jobs.md "Job mode")`. Invalid `KETE_JOB_MODE` → `build`
   throws a clear error at server start.
7. **server e2e** `job-mode.test.ts`, using the embedded server with job mode passed explicitly
   (don't mutate `process.env`):
   - (a) a `TestLLM` shell tool call → the tool result carries the refusal and
     `<tmp>/shell-marker` doesn't exist;
   - (b) a stdio MCP server in `config.content` (`touch <tmp>/mcp-marker`) → status `disabled`,
     marker absent;
   - (c) a project containing `kete.json`, `.kete/kete.jsonc` (setting an MCP server and a
     `permission` rule), `.kete/agents/evil.md`, `.kete/plugins/p.ts` (which writes a marker when
     imported), `.claude/agents/x.md` and `.agents/…` → `config.entries()` has none of them, the
     agent list lacks `evil`/`x`, and the plugin marker is absent;
   - (d) creating a PTY → refused;
   - (e) formatter: editing a `.ts` file with a `prettier` config present starts nothing;
   - (f) the same project with job mode **off** loads them (a control, so the test proves the
     switch).
8. **AC1 test** `job-spawn-sites.test.ts`, with the allowlist from the table above.
9. **Docs:** `docs/jobs.md`, `kete.md`, `docs/upstream-patches.md`.
10. Run the checks below. Then `bun run --cwd packages/kete-tools upstream:check`.

## Verification
| Criterion | Command (narrowest first, inside the package) |
|---|---|
| AC1 | core: `bun run test ./test/kete/job-spawn-sites.test.ts` |
| AC2 | core: `bun run test ./test/shell.test.ts ./test/tool-shell.test.ts ./test/git.test.ts ./test/formatter.test.ts ./test/mcp.test.ts ./test/persistent-pty-daemon.test.ts ./test/pty` then `bun run test`. util: `bun test ./test/kete`. cli: `bun test ./test/kete`. server: `bun run test` (expect only the known machine-dependent failures, commands.md) |
| AC3 | util: `bun test ./test/kete/tool-runner.test.ts`. server: `bun run test ./test/kete/job-mode.test.ts`. core: `bun run test ./test/kete/job-plugin.test.ts ./test/kete/unattended-service.test.ts`. cli: `bun test ./test/kete/job-connection.test.ts` |
| AC4 | server: `bun run test ./test/kete/job-mode.test.ts`. core: `bun run test ./test/kete/job-plugin.test.ts` |
| AC5 | core: `bun run test ./test/kete/job-request.test.ts ./test/kete/job-request-service.test.ts` |
| AC6 | core: `bun run test ./test/kete/policy-sync.test.ts` |
| AC7 | `bun run typecheck` in util, core, server, cli; `bun run test ./test/kete` (core), `bun test ./test/kete` (util, cli), `bun run test ./test/kete` (server); root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main` |

## Upstream edits (2 files)
1. `packages/server/src/routes.ts`: import + one element in `build`'s replacement list.
   *Why no seam works:* `ServerProcess.start` and the CLI's `server-process.ts` take options, not
   replacements (server-sdk card). `routes.ts` `build` is where upstream composes runtime-profile
   replacements (the workerd precedent). Environment config (`KETE_CONFIG_PROJECT_DISABLE`) covers
   only project config, not spawner, PTY, formatter, plugin source or executor.
2. `packages/core/src/plugin/internal.ts`: import, one registration line and one `guarded` id
   (inside the existing marked block). *Why no seam works:* MCP and model transforms need a plugin
   ordered after `KeteAgentSync.Plugin` and before `KeteUnattended.Plugin`. Internal plugins are
   registered only in this list, and it's the only place `guarded` lives.

Everything else is under `kete/` paths (no markers). No config schema, protocol or generated file
changes.

## Risks
- **Fail-open if the entrypoint forgets the flag.** Job mode is opt-in by design (spec). The
  entrypoint (later task) must set it, and the image's smoke test should assert
  `kete job run` in the image refuses a shell tool call.
- **Replacement order:** job mode must stay the last replacements in `routes.ts` `build`. An
  upstream reorder would silently drop them. The server e2e (f) control and (a)–(e) catch that.
- **Degraded features under the stub:** grep/glob (ripgrep), git-backed project id, snapshots and
  VCS status fail or act as "not a repo". Job mode isn't usable end to end until the root-helper
  task (D6).
- The gateway's strict per-route schemas (ADR 0020 rule 18) may refuse shapes the runtime sends
  that the rules here don't cover (e.g. Responses `compaction_trigger`/`context_management`,
  Anthropic `cache_control`/`thinking`) (D8).
- A `kete_change` line in `internal.ts` next to `KeteUnattended.Plugin` must not move that plugin
  from last place (permissions card rule).

## Decisions for the user
- **D1 Seam:** use upstream's `ChildProcessSpawner` service as the seam (≈20 sites already
  funnel through it) and replace it only in job mode. Locally nothing Kete-owned sits in the path,
  so AC2 holds by construction. The alternative, an always-on Kete wrapper, needs edits to
  `cross-spawn-spawner.ts` and every local compile site. *Recommended: D1 as planned.*
- **D2 Marker:** `KETE_JOB_MODE=1` env var only (no CLI option). In job mode `kete job run` forces
  a standalone server and refuses `--server`/the background service. An invalid value makes the
  server refuse to start. *Recommended.*
- **D3 Config:** ignore, don't narrow, every repo config type (repo `kete.json(c)`, `.kete/`,
  `.claude/`, `.agents/`: config, agents, skills, commands, plugins, MCP). Load **no disk plugins**,
  global included. **Disable every MCP server** (global, synced, remote). Keep the global config dir
  and synced agents/skills. **D3b:** keep project instructions (`AGENTS.md`/`CLAUDE.md`) as model
  context (recommended; they're repository text like any file the agent reads), or also turn them
  off.
- **D4 Models:** job mode allows only the `kete` provider. Enforce in a Kete `RequestExecutor`
  (fixes `store:false` and the output-token clamp; refuses everything else listed). **D4b
  output-token limit source:** (a) `KETE_JOB_MAX_OUTPUT_TOKENS` set by the entrypoint, required,
  refuse all model requests without it (recommended; it adds a variable to the image contract);
  (b) a runtime constant equal to the platform default 32,000; (c) send no limit and let the
  gateway set it (conflicts with §8 item 7's "the runtime sends").
- **D5 Self-spawn:** `kete job run` may still start its own `kete serve` child in job mode (the
  runtime, not a tool; fixed argv). The persistent-PTY daemon is disabled. The later unix-socket
  task may replace this with an entrypoint-started server.
- **D6 Stub consequences:** with the stub, a job-mode `kete job run` stops at worktree creation
  (`git` refused, exit 2 `refused`), and grep/glob/git features fail. That's acceptable until the
  Go helper exists. The alternative is to let the entrypoint create the worktree, which changes
  `kete job run`'s contract.
- **D7 Out of the seam:** client-only CLI spawns (the `kete session list` pager, the disabled
  updater) and the TUI stay outside it, listed in the AC1 allowlist with reasons.
- **D8 Scope of request checks:** the runtime checks implement ADR 0020 rules 8, 16 and 17 as
  listed, not a full mirror of rule 18's strict schemas. Aligning the exact shapes needs a
  platform-side request (`docs/platform/requests/`) if the gateway refuses what the adapters send.

## Cards to update after the build
- New card **job-mode** (util `job-mode.ts`/`tool-runner.ts`, core `job-plugin.ts`/`job-request*`,
  server `kete/job-server.ts`, cli `job-connection.ts`): the spawn-site table, the replacement
  list and order, the request rules per family, tests.
- `unattended`: job mode implies unattended (`run-checks.ts`).
- `cli`: `kete job run` in job mode (standalone forced, `--server` refused, `job-git` refused).
- `runtime-registration` / `sync`: registration off in job mode.
- `gateway`: job-mode request enforcement per route family; only `kete` models in job mode.
- `config-kete`: job mode ignores project config and disk plugins.
- `brand-env`: `KETE_JOB_MODE`, `KETE_JOB_MAX_OUTPUT_TOKENS`.
- `permissions`: `KeteJobPlugin.Plugin` position in `post` (before `KeteUnattended.Plugin`) and in
  `guarded`.
- `server-sdk`: `routes.ts` `build` edit; the job-mode e2e harness.
- `docs/context/contracts.md`: the image ↔ runtime env contract. `pitfalls.md`: "session hooks
  can't fail, so enforce model-request rules at the `RequestExecutor`".
- `kete-tools-ci` is already stale (not caused by this task): the librarian refreshes it
  separately.
