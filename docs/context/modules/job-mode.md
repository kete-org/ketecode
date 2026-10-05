---
module: job-mode
paths: [packages/util/src/kete/job-mode.ts, packages/util/src/kete/tool-runner.ts, packages/util/src/kete/tool-helper.ts, packages/core/src/kete/job-plugin.ts, packages/core/src/kete/job-request.ts, packages/core/src/kete/job-request/*, packages/server/src/kete/job-server.ts, packages/cli/src/kete/job-connection.ts, packages/util/src/kete/job-secrets.ts, packages/cli/src/kete/job-preflight.ts, packages/cli/src/kete/job-serve.ts, packages/cli/src/kete/job-standalone.ts, packages/cli/src/kete/dumpable.ts, packages/util/src/kete/linux-ffi.ts, packages/util/src/kete/confined-fs.ts, packages/util/src/kete/job-fs-util.ts, packages/util/src/kete/job-audit-sink.ts, packages/core/src/kete/job-files.ts]
verified-at: 34a10660f8
---

## Quick answers
- Does job mode strip credentials from tool commands too? Yes, on top of the tool runner's own allowlist: `KeteToolEnv.forSession` (`core/src/kete/tool-env.ts:123`) treats `KeteJobMode.enabled()` as unattended, so the shell tool's commands lose credential-looking variables even without session metadata (the `unattended` card). `kete job run`'s project-config check (B1) is skipped in job mode — its server never loads project config (`Config.configured({project: false})`).
- What is `spec.agent` in job mode? A synced agent's slug, required (refused, exit 2, if absent or not among the org's synced agents). The gateway pins `x-kete-agent-id` for a job key (ADR 0020 rule 9: otherwise 403), and the sync plugin adds that header only for a synced managed agent, so without the first sync every model call would fail.
- How does job mode sync (piece A2)? `kete job run` calls `KeteJobSync.first` (`cli/src/kete/job-sync.ts`, `job.ts:125-140`) after the connection resolves and before the server starts: job key as Bearer to `KETE_PLATFORM_URL/api/v1/sync` (required; unset = `error`), 120 s deadline, failed sync/skill download = `error` (1), missing/unknown agent = `refused` (2). The org id goes to the `kete serve` child in the fd-3 secrets message (`organization`, `job-standalone.ts:108-109`, validated `job-serve.ts:103`, stored write-once by `KeteJobSecrets.setOrganization`, `job-secrets.ts:155`); the plugin loads that cache (see `sync` card). Contract: contracts.md §6d.
- Does a job fetch models.dev? No, and it can't pick a newer model. `kete serve` normally refreshes the models.dev catalog periodically (`core/src/models-dev.ts:329-434`, gated at `cli/src/server-process.ts:120`), but port A never allows that host and the entrypoint sets `KETE_DISABLE_MODELS_FETCH=1` (N1, `kete-job-entrypoint/internal/entry/entry_linux.go:198-225`). A job's catalog is the bundled snapshot of the shipped `kete`, so an agent pinned to a newer model fails the job; the platform must be told per release (`job-image` card).
- Is job mode tested with the real `kete`? Yes since PR 2: `packages/kete-job-image/scripts/e2e.sh` runs the real binary in the image (scenarios `no-agent`, `lifecycle`, `ac5`; `job-image` card).
- Are platform job keys and job-scoped sync built on the platform? No: NOT built yet in kete-code-platform; the runtime assumes the platform scopes `/api/v1/sync` by key kind (no extra header). Tests use TS fakes (`util/test/kete/sync.test.ts`, `core/test/kete/agent-sync.test.ts`, `cli/test/kete/job-sync.test.ts`).
- Where do `httpURL` and the job-mode URL rule live? In util: `KeteHttpURL.normalize` (`util/src/kete/http-url.ts`) and `KeteJobMode.endpoints` (`job-mode.ts:97`), because the CLI has no `@opencode/core` dependency (`packages/cli/package.json`); `gateway.ts:453-455` uses them.
- When do internal plugins activate? Lazily per location in a forked fiber (`core/src/plugin/supervisor.ts:225-236`); `agent.list`/`agent.get`/`session.create` don't await `Plugin.awaitActivation`, only prompt/LLM/shell/command do (`session/prompt.ts:38`, `session/runner/llm.ts:68`), so a managed agent can be missing right after startup.
- What turns job mode on? `KETE_JOB_MODE=1` only (env var, bridged to `OPENCODE_JOB_MODE` by the
  existing prefix bridge, no new bridge code) — `KeteJobMode.read`/`enabled`
  (`packages/util/src/kete/job-mode.ts:34-45`). Unset/empty is off; `"1"` is on; anything else is
  `invalid`, and `enabled()` treats **on and invalid alike** (fail closed on a typo).
- What does an invalid value do? `KeteJobServer.replacements` throws
  `"KETE_JOB_MODE must be \"1\" or unset (got \"<value>\")"` at server start
  (`packages/server/src/kete/job-server.ts:84`) — the server refuses to boot rather than run with an
  unrecognized flag.
- Is there a real tool runner yet? Yes, as of `feature/job-root-helper`: `KeteToolHelper.runner`
  (`packages/util/src/kete/tool-helper.ts:669`) is the real client for the Go root helper
  (`packages/kete-root-helper/`, see the `root-helper` card) — used when
  `KETE_JOB_TOOL_SOCKET`/`OPENCODE_JOB_TOOL_SOCKET` (a path) is set. `KeteToolRunner.unavailable`
  (`packages/util/src/kete/tool-runner.ts:33-43`) is still the fail-closed stub used when it's
  unset; it refuses every spawn, piped commands included, with a message naming only the basename of
  `argv[0]` (never arguments or env, which may hold secrets). An invalid (non-absolute)
  `KETE_JOB_TOOL_SOCKET` value throws at server boot, same as an invalid `KETE_JOB_MODE`
  (`job-server.ts:90-91`). `KeteJobMode.message()` wording (D9 of the root-helper plan): "Job mode:
  tools run only through the job's tool runner; refused to start `<command>`." — dropped the earlier
  "which this build doesn't have yet", now untrue.
  Also checked manually on 2026-09-29 against a real `kete serve` binary built from this branch: in job mode `POST /api/shell` and `POST /api/pty` spawned nothing, registration was off; with job mode off the same shell call spawned (docs/tasks/2026-09-29-job-tool-isolation/handoff.md). No automated real-binary test exists yet — see Gotchas.
- What does the tool runner client do with a tool call's env, and what happens to processes it
  starts? The client keeps only env names the helper's `HELLO` reply allowlists, dropping the rest
  (D6 — the shell tool passes all of `process.env`; the helper still refuses any stray name as
  defence in depth); background processes never outlive the tool call that started them (D4) — on
  handle release, or once the leader exits and both output pipes reach EOF, the helper kills the
  spawn's whole cgroup leaf. This differs from local (non-job) mode, where `nohup cmd &` survives.
  Full protocol and lifetime rules: the `root-helper` card and its module README.
- What goes through the stub vs. gets its own guard? Almost everything spawns through upstream's
  `ChildProcessSpawner` service, which job mode replaces wholesale
  (`CrossSpawnSpawner.node.replace(KeteToolRunner.layer(KeteToolRunner.unavailable))`,
  `job-server.ts:92`) — shell tool, MCP stdio, ripgrep, git (`core/src/git.ts`, `core/src/kete/git.ts`),
  formatters, worktree hooks, the Azure CLI token helper. Two sites are **outside** that service and
  carry their own `KeteJobMode.refuseSpawn` call before spawning:
  `packages/util/src/kete/secret-store.ts:178` (OS keychain CLI) and
  `packages/cli/src/kete/job-git.ts:36` (`kete job run`'s own `git worktree add`, via
  `execFile` — no shell). Both raise the identical wording, `KeteJobMode.message(what)`
  (`job-mode.ts:56`).
- What is `packages/core/test/kete/job-spawn-sites.test.ts` (AC1)? A static allowlist test that
  walks `packages/{core,server,cli,util}/src/**/*.ts` for spawn primitives (`node:child_process`,
  `cross-spawn`, `Bun.spawn`, `execFile`/`execSync`, `bun-pty`/`node-pty`, `ChildProcess.make(`,
  `.spawn(`, `Bun.$`, and `LayerNode.compile(` with `CrossSpawnSpawner`/`AppProcess`) and requires
  every match to be classified (`seam`|`replaced-node`|`kete-guard`|`self`|`client-only`|
  `implementation`) in an explicit table keyed by path; a new unclassified match fails with
  "classify this spawn site." Full 21-row spawn-site table and file-by-file reasoning:
  `docs/tasks/2026-09-29-job-tool-isolation/plan.md` §1 and `docs/jobs.md` "Job mode". A second
  check asserts each `kete-guard` file calls `KeteJobMode.refuseSpawn` before its spawn.
- Is the CLI's/`kete serve`'s own top-level `AppProcess.node`/`CrossSpawnSpawner.node` graph
  (`cli/src/index.ts`, `cli/src/server-process.ts`) actually replaced in job mode? **Not verified
  against the real binary** — reasoned only: `server-process.ts`'s outer graph should be shadowed by
  `routes.ts`'s own inner `AppNodeBuilder.build` graph for the request-serving path (ordinary Effect
  Layer nesting, innermost `Effect.provide` wins), and the CLI's own `AppProcess` consumers are the
  `session list` pager and the updater (both `client-only`/`replaced-node` in the AC1
  allowlist) — but this is only tested against `createEmbeddedRoutes`, never against `kete serve` as
  a real subprocess by the automated tests; a manual real-binary check confirmed it (see Gotchas).
  The image's own smoke test (docs/jobs.md "Risks") should make it automated.
- What does job mode disable in configuration (D3)? **Ignores, doesn't narrow**:
  `Config.node.replace(Config.configured({project: false, ...}))` drops the whole project config
  walk (repo `kete.json(c)`, `.kete/`, `.claude/`, `.agents/` — every sub-kind: config, agents,
  skills, commands, modes, plugin dirs, MCP) while the global config dir still loads (that's where
  `kete.runtime.type` lives); `ConfigPluginSource.node.replace(ConfigPluginSource.empty)` means
  **no plugin code from disk at all**, global included — only precompiled (built-in) plugins run
  (`job-server.ts:88-91`, workerd precedent `server/src/workerd.ts:85-87`). Project instructions
  (`AGENTS.md`/`CLAUDE.md`) are **not** turned off (D3b) — `InstructionDiscovery` still follows
  `options.config.project`, unaffected by this replacement; they're treated as ordinary repository
  text the agent reads, not configuration.
- Who disables MCP servers and non-`kete` models? `KeteJobPlugin.Plugin`
  (`packages/core/src/kete/job-plugin.ts`, id `"kete.job-mode"`), a no-op outside job mode.
  `ctx.mcp.transform` sets `disabled: true` on **every** server (global, well-known, platform-synced,
  stdio and remote) — registered in `plugin/internal.ts`'s `post` list **after** `KeteAgentSync.Plugin`
  so synced servers are covered. `ctx.model.transform` removes every model whose provider isn't
  `KeteGateway.providerID` (`gateway.ts:37`).
- Where in plugin registration order does `KeteJobPlugin.Plugin` sit, and why does it matter?
  `plugin/internal.ts`'s `post` list, **immediately before `KeteUnattended.Plugin`**, which must stay
  last (`internal.ts:316`, `// kete_change: before KeteUnattended.Plugin; job mode disables every
  MCP server and every non-kete model`); its id is added to the existing marked `guarded` block
  (`internal.ts:330`) so repository config can never remove it — see the `permissions` card for the
  full `evaluate`-hook order this doesn't disturb (job mode's own plugin doesn't hook `evaluate` at
  all, only `mcp.transform`/`model.transform`).
- Which model requests are checked, and where? Every one — `LayerNodePlatform.requestExecutor` is
  replaced (`job-server.ts:96-98`) with `KeteJobRequest.layer(limits)`
  (`packages/core/src/kete/job-request.ts:170`), which builds the real `@opencode/ai`
  `RequestExecutor.layer` internally and wraps it. This is the only chokepoint that covers session
  steps, compaction, title generation **and** `core/src/generate.ts`'s `Generate`, which bypasses
  session hooks entirely — the session `http.request`/`model.request` hooks can't fail
  (`plugin/hooks.ts:23-30`, `pitfalls.md` "Permissions and sessions"), so they can't enforce this.
- How is a request's wire protocol identified? `KeteJobRequest.family(url)`
  (`job-request.ts:34`) matches the gateway route **path**, not the model name, and knows only the
  six routes a job key may use (the gateway's `JOB_ROUTES`): `…/anthropic/v1/messages` →
  `anthropic-messages`; `…/openai/v1/responses` → `openai-responses`; `…/openai/v1/chat/completions`
  → `openai-chat`; `…/compat/openrouter/v1/chat/completions` → `openrouter-chat` (same conformer,
  OpenRouter schema); `…/gemini/v1beta/models/*:generateContent|:streamGenerateContent` → `gemini`.
  Anything else — token counting, **the deepseek compat route** (the gateway refuses every
  deepseek route for job keys; a job pinned to a `kete/deepseek-*` model fails on its first
  request), an unrecognized route — is refused ("this route isn't one a job may use").
- Which headers and query parameters may a job request carry? `transportReason`
  (`job-request.ts:78`, the gateway's `checkTransport`): `anthropic-beta` only with entries from
  `ANTHROPIC_BETAS` (`:56`: `interleaved-thinking-2025-05-14`,
  `mid-conversation-output-config-2026-07-01`, `thinking-binding-controls-2026-08-01`; so
  `compact-2026-01-12`, `context-1m-*` or a beta from provider `headers` settings is refused);
  `openai-beta` never; query only per `QUERY_ALLOWLISTS` (`:68`): Gemini `alt=sse`, and the
  Anthropic route's `beta=true` — the `kete` provider's Anthropic models have canonical provider
  `anthropic` (`model-resolver.ts:236`), so `anthropic-messages.ts:1661` adds it; the gateway
  doesn't forward it. Query comes from both `request.url` and `request.urlParams` (Effect keeps a
  string URL's query in the string, `setUrlParam` in `urlParams`), `job-request.ts:135`. Refused,
  never stripped.
- What does a family's `conform` actually check? One adapter file per protocol under
  `packages/core/src/kete/job-request/` (`anthropic-messages.ts`, `openai-responses.ts`,
  `openai-chat.ts`, `gemini.ts`), each pure (no network, no Effect), in the gateway's order
  (`request-shape.ts` `checkJobRequest`): `background`; provider tools and the fields enabling them
  (rule 16), incl. **replayed provider-tool history** (Anthropic `server_tool_use`/`mcp_*`/
  `*_tool_result` but `tool_result`; Responses hosted items like `web_search_call`) and a hosted
  Responses `tool_choice`; one candidate; inline content (rule 17, depth-first `walk()`); the
  output clamp (rule 8); the **thinking budget** — an Anthropic `thinking.budget_tokens` (type
  `enabled`) or OpenRouter `reasoning.max_tokens` at or over the clamped output is **lowered** to
  one below it (`shared.ts:61` `fitBudget`; refused only if that leaves Anthropic under 1,024),
  because the gateway refuses `budget >= limit` and `output <= budget` and the "max" variant sets
  budget = model output limit − 1 (`variant.ts:44`); Gemini `null` part fields omitted
  (`gemini.ts:47`, next answer); last, the **gateway's strict zod schema** for the route
  (`shared.ts:42` `schemaReason`), whose message names the JSON path and never a value. A `conform`
  failure never reaches the network — `check()` fails with `AIError`/`InvalidRequestError` before
  the inner executor is called (`job-request.ts:125-155`); the final bytes (after any
  `http.request` hook) are re-checked in the innermost handler too (`guardMiddleware`, `:165`).
- Where do the strict schemas come from? `packages/core/src/kete/job-request/schemas/*.ts` are
  copies of kete-code-platform `apps/gateway/src/jobs/schemas/*.ts`, unchanged but for `.js`
  imports, a provenance header and prettier — zod (a declared core dependency), not Effect Schema,
  so the two stay diffable. They refuse e.g. `service_tier`/`inference_geo`/`serviceTier`, cost
  tiers, `context_management` and compaction blocks/items, OpenRouter `models`/`provider`, Gemini
  `labels`, Chat `store` other than false, and OpenAI Chat `reasoning_content` (so replayed
  reasoning on a native OpenAI **Chat** model fails locally; native OpenAI Chat streams none, so a
  job's own history has none). Change rule: contracts.md §6e.
- Why would a replayed Gemini body hold `null`, and what happens? The protocol's part schemas are
  shared with response decoding (`optionalNull`, `ai/src/protocols/gemini.ts:62-97`), so the request
  type admits `null` for `thought`, `thoughtSignature` and `functionCall.id`, while the gateway's
  schema allows them only absent or typed. Today's lowering doesn't produce `null`
  (`thoughtSignature()` returns a string or `undefined`, `:294-299`), but the conformer drops any
  `null` in those fields and `functionResponse.id` (`gemini.ts:47`) rather than send it — no upstream
  edit. `job-request-wire.test.ts` asserts the real Gemini wire body has no `null`.
- How is drift between the runtime and the gateway caught? `packages/core/test/kete/job-request-wire.test.ts`
  builds tool-loop requests with replayed history through the real provider packages
  (`@opencode/ai/providers/{anthropic,openai,google,openrouter}`) pointed at gateway routes and sends
  them through `KeteJobRequest.layer` over a fake client; a request that reaches the fake passed every
  local check.
- Where does the output-token limit come from? `KETE_JOB_MAX_OUTPUT_TOKENS`
  (`KeteJobMode.maxOutputTokens()`, `job-mode.ts:68-74`; internal name
  `OPENCODE_JOB_MAX_OUTPUT_TOKENS`) — required in job mode; missing or non-positive-integer refuses
  **every** model request locally, naming the variable (`job-request.ts:131-132`), before any
  family-specific check runs.
- What are the two PTY paths job mode refuses, and how do they differ (not documented elsewhere)?
  `core/src/pty.ts:183-184` spawns a PTY **in-process** via `#pty` (`pty/pty.bun.ts:23` or
  `pty/pty.node.ts:13`, bun-pty/node-pty bindings — no `ChildProcessSpawner` involved, so it needs
  its own replacement, `Pty.node.replace(ptyLayer)`, `job-server.ts:28-39`: `list`/`get`/etc. return
  empty/`NotFoundError`, `create` dies with the refusal message). `core/src/persistent-pty/daemon.ts:230`
  is a **separate `opencode-pty daemon` child process** (direct `node:child_process`, also outside
  the spawner service) that hosts agent PTY shells surviving a session reconnect; job mode replaces
  `PersistentPty.node` with a layer that fails every operation with `PersistentPty.UnavailableError`
  (`job-server.ts:41-59`) rather than trying to prevent the daemon from spawning.
- Does job mode disable WebSocket transport? Yes — `LayerNodePlatform.webSocketConstructor` is
  replaced with a constructor that throws (`job-server.ts:73-75`). Only the `openai` provider
  defaults to WebSocket transport (`plugin/provider/openai.ts:260`) and only `kete` models survive
  job mode (`KeteJobPlugin.Plugin`), so nothing should reach it — this closes the path outright
  rather than relying on that alone.
- How does `kete job run` behave in job mode? `JobConnection.resolve`
  (`packages/cli/src/kete/job-connection.ts`, pure) refuses `--server` outright (can't verify another
  process is running with the flag set) and forces `standalone: true` otherwise; the standalone
  child inherits the bridged `OPENCODE_JOB_MODE` (`services/standalone.ts`, `extendEnv: true`). A
  refusal — from `JobConnection`, `KeteJobMode.refuseSpawn` inside `JobGit.run`, or an ordinary spec
  error — ends the same way: `{outcome: "refused", exit_code: 2}`, printed as text or `--json`
  (`packages/cli/src/kete/job.ts:51-63`). Since piece A1 the child is `KeteJobStandalone`'s socket
  server, not `services/standalone.ts` (next answer); a start failure is `error` (1),
  `job.ts:120-131`. **Since `feature/job-entrypoint` (F1), cwd is the
  prepared worktree:** the entrypoint clones and checks out `spec.branch` (ADR 0019 rule 5), and
  `job.ts:123` passes `jobMode: KeteJobMode.enabled(process.env)`, so `JobRun.run` skips every git
  call (`repoRoot`, `headSha`, `worktreeAdd`, cleanup), requires `spec.branch` and `<cwd>/.git`
  (else `refused`, 2, before any session), and reports `isolated: true`, `worktree` = `directory`
  = cwd (`packages/cli/src/kete/job-run.ts:426-434,455-458,484`). Before F1, `repoRoot` ran first
  and hit `job-git.ts:36`'s refusal, so a job-mode run failed immediately; the guard in
  `job-git.ts` stays. Contract: `contracts.md` §6d, `docs/jobs.md` "Job mode".
- How does `kete job run` reach its own server, and does that work inside the job firewall? Since
  piece A1 (`docs/tasks/2026-10-01-job-socket-server/`): over a **unix socket**, never TCP, so the
  egress firewall (which lets the `kete` uid reach only port A) needs no exception.
  `KeteJobStandalone.start` (`packages/cli/src/kete/job-standalone.ts:155-218`) makes a fresh 0700
  dir `kete-XXXXXX` under `XDG_RUNTIME_DIR` (absolute) else `TMPDIR` (`:43-84`; the base must not be
  group/world-writable unless sticky; socket path ≤ 103 bytes), spawns `kete serve --stdio --socket
  <dir>/s` with a random 32-byte password and the gateway key as one JSON message on the child's
  fd 3 (`KETE_JOB_SECRETS_FD=3`, `:104-132`), requires the ready line `{"url":"unix://<that
  path>"}` (`:135-140`), forwards the child's stderr and appends its last line (≤ 300 chars) to a
  start failure, and removes the dir when the scope closes. The client uses base URL
  `http://localhost` and Bun `fetch` with `unix:` (`job.ts:67-74`). Job mode never falls back to
  `ServerConnection.resolve` or TCP (`job.ts:129-131`). Outside job mode TUI/`--standalone`/ACP
  keep upstream's TCP `services/standalone.ts`. The image e2e with the real `kete` is `packages/kete-job-image` (`job-image` card).
- What does `kete serve` do in job mode, and who else would be refused? `KeteJobServe.prepare`
  (`packages/cli/src/kete/job-serve.ts:64-99`), called at the top of `ServerProcess`'s
  `processEffect` (`cli/src/server-process.ts:49-56`, before the service incumbent check) for every
  caller: only `--stdio --socket <path>` is accepted, `--port`/`--hostname` refused, so the
  background service, a TUI's standalone child and ACP refuse instead of opening TCP; then
  non-dumpable, then (A3) the confinable probe, then the secrets message read from `KETE_JOB_SECRETS_FD` (16 KiB cap, 10 s), secret
  env vars deleted, the key put in the write-once overlay `KeteJobSecrets.setGatewayKey`
  (`util/src/kete/job-secrets.ts:133-145`), then the audit fd (see below). Outside job mode it only refuses `--socket`.
- Which processes talk to `kete`'s server in a job (runtime self-connections)? Only `kete job run`'s
  own client. PTY (in-process and the persistent-PTY daemon) and WebSocket are replaced/refused, so
  nothing else connects; the PTY-ticket auth bypass (`server/src/middleware/authorization.ts:53-56`)
  is unreachable with PTY off.
- What auth does the job's server enforce? Basic `opencode:<password>`, compared in constant time
  (`server/src/auth.ts:30-36` → `server/src/kete/constant-time.ts:13-19`, everywhere, not only in
  job mode). In job mode a `?auth_token=` query credential yields an empty credential, i.e. 401 even
  with a valid header (`authorization.ts:33-34`); outside job mode it still wins over the header.
- How are the job processes made non-dumpable, and what does that change? `KeteDumpable.disable`
  (`packages/cli/src/kete/dumpable.ts:50-62`): `prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi` libc
  (musl if present, else glibc; lazy `require` so the Node build bundles), then read back with
  `PR_GET_DUMPABLE`; called by both `kete job run` (preflight) and its `kete serve` child before any
  secret is read; failure on Linux refuses, non-Linux is `unsupported` (no-op). `exec` resets the
  flag, which is why each process does it itself. Effect: `/proc/<pid>/{environ,fd,mem}` become
  root-owned, and even root needs `CAP_SYS_PTRACE` to read them. `/proc/<pid>/status` has **no**
  `Dumpable:` field — tests check ownership/EACCES or `PR_GET_DUMPABLE`.
- How is the container-image work split? User decision (2026-09-30,
  `docs/tasks/2026-09-30-job-image/handoff.md`): **A** runtime gaps in TypeScript (kete's server on
  a unix socket with a per-run secret, the gateway key by descriptor, `openat2` confinement for
  kete's own file tools, `PR_SET_DUMPABLE`, the entrypoint-owned audit/result sink); **B** egress
  proxy + nftables (`packages/kete-egress/`, done — `egress` card); **C** the entrypoint (claim,
  clones, users/cgroups, kete launch, heartbeats, kill sequence, bundle, uploads, finish); **D** the
  image, publishing (GHCR by digest) and a fake platform for its smoke test. Order: B, then C+D,
  with A alongside; the proxy and entrypoint are Go next to the root helper. `docs/tasks/2026-09-30-job-image/`
  keeps the shared scout notes (Q1-Q6); each piece has its own task folder. **Status:** B merged
  (#60); C is `packages/kete-job-entrypoint/` (PR 1 of `docs/tasks/2026-09-30-job-entrypoint/`, the
  `job-entrypoint` card). Piece A is split (user, 2026-10-01): **A1** socket server + secrets by
  descriptor + non-dumpable + auth hardening (done, `docs/tasks/2026-10-01-job-socket-server/`) →
  **A2** sync from the gateway key (next; jobs use the default agent until then) → image PR 2 (D) →
  **A3** `openat2` confinement for kete's own file tools + the entrypoint-owned audit sink (done,
  `docs/tasks/2026-10-01-job-file-confinement/`; result stays on kete's stdout).
- How does `kete` get the gateway key in a job today? **By descriptor** (piece A1): the entrypoint
  writes it to a pipe that is `kete job run`'s fd 3 and sets `KETE_JOB_GATEWAY_KEY_FD=3`
  (`packages/kete-job-entrypoint/internal/entry/entry_linux.go:219,281-310`); `KeteJobPreflight.run`
  (`packages/cli/src/kete/job-preflight.ts:39-61`) reads it once (≤ 4096 printable ASCII, 10 s) and
  closes it, deletes `KETE_GATEWAY_KEY`/`KETE_PASSWORD`/`KETE_SERVER_PASSWORD` from `process.env`
  (`job-secrets.ts:37`), and refuses (2) without a valid fd. The serve child gets it on its own fd 3
  and keeps it in memory (`KeteJobSecrets.gatewayKey`), never `process.env`. **D2: it is the only
  gateway key in job mode** — accounts, `kete auth login`, `apiKey` and `KETE_GATEWAY_KEY` are
  ignored, and the gateway/platform URLs come only from `KETE_GATEWAY_URL`/`KETE_PLATFORM_URL`
  (`core/src/kete/gateway.ts:172-173,447-455`; `gateway` card). Note `/proc/<pid>/environ` is the
  exec-time env: a `KETE_GATEWAY_KEY` a caller passed stays visible there for `kete job run`
  (root-only, non-dumpable) but is ignored and not forwarded.
- Does runtime registration run in job mode? No — `core/src/kete/sync/plugin.ts:360-362` skips it
  and logs one info line ("runtime registration is off in job mode") when
  `options.registration !== false && KeteJobMode.enabled(runtimeEnvironment)`; `registration: false`
  (tests) still logs nothing, matching its prior no-registration behavior. `runtime_type` resolution
  itself is unchanged.
- How are the worktree's files confined in a job (piece A3)? `KeteJobServer.replacements` opens the
  root once (`confine(process.cwd())`, `job-server.ts:121`; `confineReal` = `KeteConfinedFs.open` over
  `KeteLinuxFfi.linux()`, `:97`) and adds three replacements (the list is now **11**,
  `job-server.ts:138-140`): `Environment.node` → `KeteJobFiles.node(root)`
  (`core/src/kete/job-files.ts`: all seven `Environment.files` methods through `KeteConfinedFs.ops`,
  never `node:fs`), `FSUtil.node` → `KeteJobFsUtil.layer(root)` (`util/src/kete/job-fs-util.ts`) and
  `FileSystemSearch.node` → `FileSystemSearch.configured({ fff: false })`. Every open is
  `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)` beneath the cwd
  (`util/src/kete/{linux-ffi,confined-fs}.ts`): a symlink anywhere, `..`, an absolute path outside
  the tree and a magic link are refused ("Job mode: refused to follow a symbolic link or leave the
  working tree", no absolute path in it). Root = cwd = the entrypoint's worktree; a workspace-placed
  location is a defect (`job-files.ts`, `layer`). Contract: contracts.md §6d.
- Which paths read the worktree in-process (the map that drove A3)? read/write/edit/patch and the
  read tool's directory listing → `Environment.files` (upstream: `makeLocalDriver`, node:fs, follows
  symlinks; seam `core/src/environment/environment.ts:24-33`; **there is no "list" tool in v2**, a
  directory read is `Environment.files.list`). `FSUtil` (AGENTS.md discovery,
  `config/plugin/instruction.ts`, `session/instructions.ts`, `project.ts:258`, `vcs.ts:146`,
  `snapshot.ts:94`). `FileSystemSearch`'s native `fff` indexer. glob/grep reach the tree through a
  **ripgrep subprocess** (so only a type check goes through `Environment.files`). In a job `fff` is
  off, so search is ripgrep through the root helper (the tool user's own access, not kete's).
  `core/test/kete/job-fs-sites.test.ts` walks `core/src` and `util/src` for these sites and fails on
  an unclassified one (categories include `wrapped` and `confinement`).
- How is an upstream node replaced for this (location vs global)? `Environment.node` is a
  *location* node (`makeLocationNode`, deps `CrossSpawnSpawner.node`, `Location.node`);
  `FSUtil.node`/`FileSystemSearch.node` are *global* (`makeGlobalNode`, FSUtil with
  `deps: [filesystem]`, `FSUtil.layer` is exported for wrapping, `job-server.ts:139`). **FSUtil's
  derived helpers call the inner FileSystem, so a wrapper must override them itself** (they bypass
  an override of the primitives; `pitfalls.md`).
- What does the FSUtil wrapper do per method? `job-fs-util.ts` has three lists: `routed` (content,
  listings, `realPath`, and `scan`/`globUp`/`glob`), `refused` (mutations: `copyFile`, `chown`,
  `makeTemp*` inside the tree, `stream`/`sink`), `delegated` (metadata; these still follow links).
  `realPath` returns `<root.real>/<rel>`. A `scan` rooted in the tree is an in-tree walk over the
  confined listing (never enters or reports a symlink; fails past `MAX_WALK_ENTRIES` 200,000 or
  depth `MAX_WALK_DEPTH` 64 rather than truncating, `:93-94`). A walk rooted elsewhere (or an
  absolute pattern) forces `symlink: false` and drops results in the tree reachable only through a
  link (`:200-206`); `glob` is filtered the same way; `globUp` swallows walk errors like upstream.
  Residual limits: `docs/jobs.md`.
- Can a job-mode `kete serve` start on macOS (or an old kernel)? No: `openat2` is required, so
  `KeteConfinedFs.open` throws on non-Linux, kernel < 5.6 or seccomp-blocked `openat2`, and
  `replacements` propagates it (fail closed, no fallback to `node:fs`). `kete job run` reports
  `error` (1) with the child's reason. Tests that build a job-mode server pass a fake `Confine`
  (`server/test/kete/fake-confine.ts`); `job-socket.subprocess.test.ts` branches by platform.
- What is `KeteJobServe.prepare`'s order now? dumpable → **confinable** (the root can be opened with
  `openat2`; added so a boot failure gives a readable reason, `job-serve.ts:111-112`) → secrets
  message read → **audit fd** (variable parsed, must differ from the secrets fd, a pipe or socket,
  close-on-exec, `setAuditSink`; `:136-145`). `KeteJobPreflight.run` (parent) validates its own
  audit fd as a FIFO and marks it close-on-exec.
- Where does the job's audit log go (piece A3)? Not to a file. `kete job run` gets the entrypoint's
  pipe as `KETE_JOB_AUDIT_FD` (fd 4); `KeteJobStandalone.start` gives the serve child its own fd 4
  (a socket/pipe to the parent, `job-standalone.ts` `auditFd`) and relays its bytes unchanged
  (`KeteJobAuditSink.relay`, `util/src/kete/job-audit-sink.ts:183`) into the entrypoint's pipe,
  keeping the `run` lines and ≤ 10,000 `model`/`permission` lines for `kete job run`'s result.
  Caps and the writer: `audit-log` card. Entrypoint side: `job-entrypoint` card.
- Why can't the relay close the child's fd 4 on failure (known limitation)? The effect
  `ChildProcessHandle` and upstream `util/src/cross-spawn-spawner.ts` expose only a PassThrough
  stream (`getOutputFd`), not the socket, so destroying it leaves the child's end open. On relay
  failure the parent stops reading and interrupts the run at once (`audit_failed`); the child's
  writes then block and its writer gives up after `WRITE_TIMEOUT_MS` (10 s) and interrupts the run
  itself. Closing the fd would need a marked upstream edit to the spawner (not made; the
  coordinator's call). Draining to nowhere was rejected.
- Why does a start failure show the real reason? `job-standalone.ts` keeps the child's last stderr
  line but skips stack-frame lines (`at …`).

## Purpose
Prepares the runtime for cloud jobs (kete-code-platform ADRs 0018–0021, `docs/jobs.md` §8): job
mode is a fail-closed build flag for the (not-yet-built) cloud-job runtime image, where tools must
run only through a second-user root helper. "Part 1" of job mode (this card, feature/job-tool-isolation)
built the process seam and the config/model-request restrictions, refusing every spawn since no
real tool runner existed yet. "Part 2" (feature/job-root-helper, see the `root-helper` card) built
that root helper (Go, `packages/kete-root-helper/`) and its TypeScript client
(`tool-helper.ts`), so a job can now run the shell tool, git and the other spawner-seam processes
end to end as the tool user, inside its own cgroup — once `KETE_JOB_TOOL_SOCKET` points at a
running helper. The egress proxy is piece B (`egress` card), the entrypoint piece C
(`job-entrypoint` card). Piece A1 put `kete`'s own server on a unix socket with secrets by
descriptor. A2 (sync from the gateway key), the container image (D) and A3 (`openat2` confinement of `kete`'s
own file tools, the entrypoint-owned audit sink) are done; see their Quick answers.

## Entry points
- `packages/util/src/kete/job-mode.ts` — the flag reader (`read`/`enabled`), the shared refusal
  `message()`/`refuseSpawn`, and `maxOutputTokens()`. No dependencies beyond `env.ts`'s bridge
  helpers, so both `util`, `core`, `server` and `cli` can import it without a cycle.
- `packages/util/src/kete/tool-runner.ts` — `KeteToolRunner.Interface`/`unavailable`/`layer` — the
  `ChildProcessSpawner` replacement.
- `packages/util/src/kete/tool-helper.ts` `KeteToolHelper.runner(options)` — the real `Interface`
  implementation, speaking the root helper's socket protocol; see the `root-helper` card.
- `packages/core/src/kete/job-plugin.ts` `Plugin` (id `"kete.job-mode"`) — registered in
  `packages/core/src/plugin/internal.ts`'s `post` list, immediately before `KeteUnattended.Plugin`
  (`internal.ts:316`); its id is in `guarded` (`internal.ts:330`).
- `packages/core/src/kete/job-request.ts` `KeteJobRequest.layer(limits)` — the `RequestExecutor`
  replacement, wired from `job-server.ts`.
- `packages/server/src/kete/job-server.ts` `KeteJobServer.replacements(options, mode)` — the single
  function building the 11-item replacement list, called from the one upstream edit,
  `packages/server/src/routes.ts`'s `build` (`routes.ts:141-148`, `...KeteJobServer.replacements(options)`
  appended **last**, after `...overrides`, so job mode always wins).
- `packages/cli/src/kete/job-connection.ts` `JobConnection.resolve(args, env)` — pure; consumed by
  `packages/cli/src/kete/job.ts` before `ServerConnection.resolve` (see the `cli` card).
- `packages/cli/src/kete/job-preflight.ts` `KeteJobPreflight.run` (first step of `kete job run` in
  job mode), `job-standalone.ts` `KeteJobStandalone.start` (socket server child),
  `job-serve.ts` `KeteJobServe.prepare` (the child's side, from `server-process.ts`),
  `dumpable.ts` `KeteDumpable.disable`; `packages/util/src/kete/job-secrets.ts` (descriptor reader,
  key validation, write-once overlay). See the `cli` and `server-sdk` cards.
- `packages/core/src/kete/run-checks.ts` — job mode + an interactive session family (no
  `kete.unattended`) refuses the step; see the `unattended` card.
- `packages/core/src/kete/sync/plugin.ts:360-362` — registration skipped in job mode; see the
  `runtime-registration`/`sync` cards.

## Key files
| File | Role |
| --- | --- |
| `util/src/kete/job-mode.ts` | `variable`/`publicName` (`OPENCODE_JOB_MODE`/`KETE_JOB_MODE`), `read`/`enabled`/`refuseSpawn`, `maxOutputTokensVariable`/`maxOutputTokens` |
| `util/src/kete/tool-runner.ts` | `Interface`, `unavailable` (fail-closed stub), `layer(runner)` |
| `util/src/kete/tool-helper.ts` | `KeteToolHelper.runner(options)` — the real root-helper client (`root-helper` card) |
| `core/src/kete/job-plugin.ts` | `Plugin` — MCP-disable + model-filter transforms |
| `core/src/kete/job-request.ts` | `family(url)`, `transportReason` (header/query allowlists), `check()`, `layer(limits)` — the `RequestExecutor` wrapper |
| `core/src/kete/job-request/shared.ts` | `Conform`, `schemaReason` (strict-schema refusal naming the path), `fitBudget` (thinking budget below the clamped output) |
| `core/src/kete/job-request/schemas/*.ts` | copies of the gateway's strict job-key schemas (zod), contracts.md §6e |
| `core/src/kete/job-request/anthropic-messages.ts` | `conform` — rules 8/16/17 for the Messages API |
| `core/src/kete/job-request/openai-responses.ts` | `conform` — adds Responses state-field refusals (`previous_response_id`/`background`/`conversation`), forces `store: false` |
| `core/src/kete/job-request/openai-chat.ts` | `conform` — chat-completions shape, including openrouter `plugins`/`:online` model-id refusal |
| `core/src/kete/job-request/gemini.ts` | `conform` — `generationConfig.candidateCount`/`maxOutputTokens`, `cachedContent` refusal, `functionDeclarations`-only tools |
| `server/src/kete/job-server.ts` | `replacements(options, mode, env, confine)` — the 11-item list (8 + the three A3 file replacements); also defines the refusing Pty/PersistentPty/WebSocket layers and the no-op Formatter layer inline |
| `cli/src/kete/job-connection.ts` | `resolve(args, env)` — `--server` refusal, forced standalone |
| `util/src/kete/job-secrets.ts` | `readDescriptor` (Bun stream, timeout, cap, always closes), `validGatewayKey`, `setGatewayKey`/`gatewayKey` overlay, fd variable names |
| `cli/src/kete/job-preflight.ts` | `run` — non-dumpable, key from `KETE_JOB_GATEWAY_KEY_FD`, env secrets dropped |
| `cli/src/kete/job-standalone.ts` | `start` — 0700 socket dir, `kete serve --stdio --socket`, secrets on fd 3, ready-line check |
| `cli/src/kete/job-serve.ts` | `prepare` — job-mode shape check, non-dumpable, secrets message, overlay |
| `cli/src/kete/dumpable.ts` | `disable` — `prctl(PR_SET_DUMPABLE, 0)` via `bun:ffi` |
| `util/src/kete/linux-ffi.ts` | `bun:ffi` syscalls (`openat2`, `getdents64`, `setCloexec`), per-arch `O_DIRECTORY`/`O_NOFOLLOW` and syscall numbers (x64/arm64), `linux()` → `unsupported` off Linux |
| `util/src/kete/confined-fs.ts` | `open(root, sys)` → `Root`; `ops(root)` read/write/stat/list/remove/move/mkdir, all beneath the root; `Refused` |
| `util/src/kete/job-fs-util.ts` | FSUtil wrapper: routed / refused / delegated lists, confined scan/glob walks |
| `util/src/kete/job-audit-sink.ts` | fd parse/validate, bounded `writer` (10 s timeout), `relay`, caps (19 MB detail / 20 MB total) |
| `core/src/kete/job-files.ts` | `Environment` driver over `KeteConfinedFs.ops` (`node(root)`) |

## Data flow
1. **Boot:** `routes.ts` `build` calls `KeteJobServer.replacements(options)` (default
   `mode = KeteJobMode.read(process.env)`) last in its replacement list. Off → `[]`, unchanged
   behavior. Invalid → throws, server refuses to start. On → the 11 replacements apply: `Config`
   (no project walk), `ConfigPluginSource` (no disk plugins), `CrossSpawnSpawner` (the tool-runner
   stub), `Pty`/`PersistentPty` (refusing), `Formatter` (no-op), `RequestExecutor` (checked/rewritten),
   `WebSocketConstructor` (refusing), then `Environment`/`FSUtil`/`FileSystemSearch` (confined, A3; boot throws if openat2 is unavailable).
2. **Plugin registration:** `KeteJobPlugin.Plugin` runs after `KeteAgentSync.Plugin`, before
   `KeteUnattended.Plugin` — disables every MCP server and filters the model list to `kete`-only, a
   no-op when job mode is off.
3. **A tool call** (e.g. shell): reaches `ChildProcessSpawner` → `KETE_JOB_TOOL_SOCKET` set: the
   root-helper client (`KeteToolHelper.runner`) opens one connection per spawned process to the
   helper, which starts it as the fixed tool user in its own cgroup leaf (`root-helper` card);
   unset: the stub's `spawn` fails with a `PlatformError` naming the refused command's basename
   before anything starts.
4. **A model request:** built by the session runner as normal → `RequestExecutor.execute` (job
   mode's wrapped version) → non-POST passes through; a POST is classified by `family(url)`, parsed
   as JSON, and run through that family's pure `conform` → success rewrites the body (clamped
   output-token limit, `store: false` for Responses, etc.) and calls the real inner executor;
   failure raises `AIError`/`InvalidRequestError` and the network is never touched.
5. **A step in an interactive (non-unattended) session family, job mode on:**
   `run-checks.ts` refuses with `StepFailedError({type: "unattended", message:
   KeteUnattendedSchema.jobMode()})` before `KeteBudget` would otherwise run — no tool or model
   request executes.
6. **`kete job run`:** `job.ts` calls `JobConnection.resolve` before `ServerConnection.resolve`;
   a `--server` value in job mode ends the run as `refused` (exit 2) without touching the network.
   In job mode the order is: preflight (non-dumpable, key from fd) → spec → `JobConnection` →
   `KeteJobStandalone.start` (socket child, which inherits `OPENCODE_JOB_MODE` and runs
   `KeteJobServe.prepare`) → client over `fetch({unix})`.

## Data and APIs used
- Env: `KETE_JOB_MODE`/`OPENCODE_JOB_MODE`, `KETE_JOB_MAX_OUTPUT_TOKENS`/
  `OPENCODE_JOB_MAX_OUTPUT_TOKENS`, `KETE_JOB_TOOL_SOCKET`/`OPENCODE_JOB_TOOL_SOCKET`,
  `KETE_JOB_GATEWAY_KEY_FD`/`OPENCODE_JOB_GATEWAY_KEY_FD`, `KETE_JOB_AUDIT_FD`/`OPENCODE_JOB_AUDIT_FD` (A3, a pipe) — the image ↔ runtime contract
  (`KETE_JOB_SECRETS_FD` is internal, parent → serve child); see `docs/context/contracts.md` and `docs/jobs.md` "Job mode".
- The root helper's socket protocol v1 (`packages/kete-root-helper/README.md` "Protocol v1") — the
  wire contract `tool-helper.ts` speaks; see the `root-helper` card.
- `@opencode/ai`'s `RequestExecutor.Service`/`.layer`, `AIError`/`InvalidRequestError` — `job-server.ts`
  needed `@opencode/ai` as a **direct** `packages/server` dependency (was transitive via `core`) to
  build the `LayerNodePlatform.requestExecutor` replacement as a `makeGlobalNode` service/layer pair,
  since `RequestExecutor.Service`'s deps (`HttpClient.HttpClient`) mean it can't be a raw closed
  `Layer` on a `LayerNode.replace()` target. Recorded in `docs/upstream-patches.md` "Job mode, part 1"
  (JSON, no marker possible).
- `Config.configured`, `ConfigPluginSource.empty` — reused upstream primitives (the workerd profile's
  own precedent, `server/src/workerd.ts:74-88`), not new Kete config machinery.

## Rules that must not break
- Fail closed on every axis: an invalid `KETE_JOB_MODE` refuses server start, not "off";
  `KeteJobMode.enabled()` treats invalid the same as on everywhere else; a spawn that can't classify
  its refusal target still refuses (never falls back to spawning as `kete`).
- `...KeteJobServer.replacements(options)` must stay the **last** entry in `routes.ts` `build`'s
  replacement list — an upstream reorder would silently drop job mode's restrictions (see the
  server e2e "off vs. on" control test, below).
- `KeteJobPlugin.Plugin` must stay immediately before `KeteUnattended.Plugin` in `post`, and
  `KeteUnattended.Plugin` must stay last — see the `permissions` card's full `evaluate`-hook-order
  rule; this plugin doesn't hook `evaluate` but shares the same guarded-registration mechanism.
- A `conform` function is pure and adapter-local (CLAUDE.md §3: no `if model == …`); a new gateway
  wire protocol needs its own adapter file and a `family()` case, or it's refused outright (fail
  closed, not silently unsupported) — see `docs/upstream-patches.md`'s sync checklist for this
  feature.
- `KeteJobMode.message()` never includes arguments or env values (may hold secrets) — only the
  basename of the refused command.
- AC1's static test (`job-spawn-sites.test.ts`) must keep classifying every spawn-adjacent file it
  finds; a file that starts matching one of the spawn-primitive patterns and isn't in the allowlist
  fails CI, by design.

## Testing
- `packages/util/test/kete/job-mode.test.ts`, `packages/util/test/kete/tool-runner.test.ts` —
  `bun test ./test/kete/{job-mode,tool-runner}.test.ts` inside `packages/util/` (flag parsing; the
  stub refuses a `touch <marker>` command and the marker is never created).
- `packages/util/test/kete/{tool-helper-protocol,tool-helper}.test.ts` — the real root-helper
  client, against a fake helper; see the `root-helper` card for the full list and how to run the Go
  side (Docker/Colima, no Go needed on the Mac).
- `packages/server/test/kete/job-mode.test.ts` case (g)/(h), `packages/server/test/kete/job-helper-e2e.test.ts` —
  server-side wiring (a socket set reaches a fake helper; an invalid socket value throws) and the
  real end-to-end run through the real helper (Linux only, gated on `HELPER_E2E_*`, not `KETE_*` —
  see Gotchas below).
- `packages/core/test/kete/job-spawn-sites.test.ts` — AC1, `bun run test
  ./test/kete/job-spawn-sites.test.ts` inside `packages/core/`.
- `packages/core/test/kete/job-request.test.ts` (pure `conform`/`family`/`transportReason` per family),
  `job-request-service.test.ts` (hand-built bodies through `KeteJobRequest.layer` over a fake
  `HttpClient`, incl. refusals that send zero bytes) and `job-request-wire.test.ts` (the real provider
  packages' tool-loop requests through the layer — the drift tripwire against the gateway) — `bun run test ./test/kete/job-request*.test.ts`
  inside `packages/core/`.
- `packages/core/test/kete/job-plugin.test.ts` — MCP/model transforms, no-op off — `bun run test
  ./test/kete/job-plugin.test.ts` inside `packages/core/`.
- `packages/server/test/kete/job-mode.test.ts` — e2e on an embedded server with
  `KeteJobServer.replacements(…, {kind:"on"})` passed as overrides: (a) shell tool call refused, no
  marker file; (b) stdio MCP server disabled; (c) `config.get()` shows none of a job-mode project's
  `kete.json`/`.kete/` entries (simplified from the plan's `agent.list`/`mcp.list` check — those
  endpoints returned empty regardless of job mode in this harness for lack of a seeded `ModelsDev`
  catalog); (d) PTY creation refused; (f) the same project with job mode **off** loads them (control).
  The plan's formatter-no-op and `.kete/plugins/p.ts` marker sub-cases aren't separately e2e-tested
  here — covered indirectly (formatter layer is unit-testable; the disk-plugin-off mechanism is the
  unmodified workerd precedent).
- `packages/cli/test/kete/job-connection.test.ts` — `--server` refusal, forced standalone,
  `JobGit.run` rejecting in job mode.
- Piece A3: util `{confined-fs,confined-fs-linux,job-fs-util,job-fs-util-linux,job-audit-sink}.test.ts`
  (+ `fixture/fake-syscalls.ts`), core `{job-files,job-files-linux,audit-sink,job-fs-sites}.test.ts`,
  server `{job-files-wiring.test.ts,fake-confine.ts}`, cli `job-run`/`job-serve`/`job-standalone`/
  `job-preflight` tests. The `*-linux` tests need a real Linux kernel (macOS skips them): run them in
  `oven/bun:1.4.2` (musl/root case: `oven/bun:1.4.2-alpine`, `--privileged`, `CONFINED_FS_ROOT_TESTS=1`);
  in CI they run in the existing `kete-build` Kete-tests job.
- Piece A1: `packages/util/test/kete/job-secrets.test.ts`; `packages/cli/test/kete/{dumpable,
  job-preflight,job-serve,job-standalone}.test.ts`; `packages/cli/test/kete/job-socket.subprocess.test.ts`
  (real CLI subprocess over the socket; on Linux set `JOBSOCK_E2E_BIN` to a built binary and run in
  a container as root ± `--cap-add=SYS_PTRACE` and as non-root); `packages/server/test/kete/{socket-listen,
  job-auth}.test.ts`; `packages/core/test/kete/gateway.test.ts` job-mode cases.
- `packages/core/test/kete/{unattended-service,policy-sync}.test.ts` — extended, not new, for job
  mode's unattended-implication and registration-off behavior; see the `unattended`/
  `runtime-registration` cards.

## Changes
- `docs/tasks/2026-09-29-job-root-helper/` — spec, plan (the root helper's full design, D1-D10),
  handoff (deviations found during the build, the test-flake fix, a corrected false claim about the
  race test — see the `root-helper` card's Gotchas).
- `docs/tasks/2026-09-29-job-tool-isolation/` — spec, plan (full 21-row spawn-site table, the D1-D8
  decisions, the AC1 allowlist's category reasoning), handoff (the implementer's deviations from the
  plan's letter and the open reviewer questions).
- `docs/upstream-patches.md` "Job mode, part 1 (feature/job-tool-isolation)" — the two upstream
  edits, the `server/package.json`/`bun.lock` JSON-only dependency change, and the sync checklist.
- `docs/jobs.md` "Job mode" — the image ↔ runtime env contract, what's ignored/refused, consequences
  until the root helper exists.
- `packages/core/src/kete/skill/kete.md` — one paragraph telling the model what job mode is.
- `docs/tasks/2026-10-02-job-gateway-allowlist/` — the request shape matches the gateway's job-key checks (routes, beta/query allowlists, provider-tool history, thinking budget, strict schemas copied as zod), Gemini `null` part fields omitted; item 11 audit in result.md; no upstream file edited.
- `docs/tasks/2026-10-01-job-file-confinement/` — piece A3: openat2 confinement and the audit pipe; review-fix round and the fd-4 limitation in handoff.md; no upstream file edited.
- `docs/tasks/2026-10-01-job-socket-server/` — piece A1: socket server, secrets by descriptor,
  non-dumpable, constant-time auth, `auth_token` refused, D2 (job key only); deviations in handoff.md;
  upstream edits in `docs/upstream-patches.md`.
- `docs/tasks/2026-09-30-job-entrypoint/` — F1 (job-mode `kete job run` in the prepared worktree)
  and the entrypoint that sets this card's variables (`job-entrypoint` card).

## Gotchas
- **Real binary: checked manually, not automated.** The automated tests use
  `createEmbeddedRoutes` (in-process). The Layer-shadowing reasoning for `cli/src/index.ts`/
  `cli/src/server-process.ts`'s own un-replaced `AppProcess.node`/`CrossSpawnSpawner.node` was checked manually on 2026-09-29 against a real `kete serve` binary built from this branch: in job mode `POST /api/shell` and `POST /api/pty` spawned nothing, registration was off; with job mode off the same shell call spawned (docs/tasks/2026-09-29-job-tool-isolation/handoff.md). No automated real-binary test exists yet. The container-image task should
  add it as an automated smoke test. A refused shell call currently reaches the HTTP client as a
  bare 500 with an empty body (follow-up: a typed error).
- **Resolved (F1): `kete job run` no longer stops at worktree creation in job mode.** `job-git.ts`'s
  direct `KeteJobMode.refuseSpawn` guard still refuses every git call; job mode simply makes none,
  using cwd as the entrypoint's prepared worktree (see Quick answers). A job-mode run started outside
  a checkout, or without `spec.branch`, is refused (2).
- `job-request.ts`'s `RequestExecutor` replacement had to be wired as a `makeGlobalNode` **node**
  replacement, not a raw closed `Layer` — `LayerNode.replace()`'s raw-layer form requires `R = never`,
  but `KeteJobRequest.layer(limits)` still needs `HttpClient.HttpClient`. This pulled `@opencode/ai`
  into `packages/server`'s direct dependencies (see Data and APIs used) — a mechanical consequence of
  the type system, not a design change, but worth knowing before "simplifying" this wiring.
- The server e2e test's (b)/(c)/(f) sub-cases use `client.config.get()`, not `agent.list()`/
  `mcp.list()` — those location-scoped endpoints came back empty in the embedded-routes harness
  regardless of job mode (no seeded `ModelsDev` catalog), so they weren't a reliable proxy; a
  follow-up task could wire a seeded catalog and use them instead.
- `packages/schema/src/kete/unattended.ts`'s `jobMode()` message deliberately starts with the same
  `"Unattended run refused: "` prefix as `refused()` so `classify()` reports it as `"refused"`
  without any change to `classify` itself — don't reword the prefix without checking `classify`'s
  string match.
- **`packages/server/script/kete/isolated-test.ts` strips every `KETE_*` variable** (and sets
  HOME/TMPDIR to temp dirs) before running server tests — a gated server test (e.g. the root-helper
  AC5 end-to-end test) can't use a `KETE_*`-prefixed name for its own gating env, or the script
  deletes it before the test process ever sees it. `job-helper-e2e.test.ts` uses
  `HELPER_E2E_SOCKET`/`HELPER_E2E_ROOT`/`HELPER_E2E_TOOL_UID` for exactly this reason.
- **`HTTP_PROXY` turns a unix-socket `fetch` into an absolute-form request** (Bun sends the full URL
  as the request target over the socket). The job's `kete` env has only `HTTPS_PROXY`, so the
  `http://localhost` client base is unaffected; don't add `HTTP_PROXY` to it.
- **Reading a secrets fd:** `fs.createReadStream` on a pipe whose writer stays open blocks a
  threadpool thread uninterruptibly (the timeout never fires); `job-secrets.ts` uses
  `Bun.file(fd).stream()` and cancels it (`:79-131`). Bun's `node:child_process` delivers an extra
  `"pipe"` stdio as a **socket**, not a FIFO — the reader accepts FIFO, socket or regular file.
