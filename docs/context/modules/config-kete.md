---
module: config-kete
paths: [packages/schema/src/config/kete.ts, packages/schema/src/config.ts, packages/core/src/config/normalize.ts, packages/core/src/config/discovery.ts, packages/core/src/config.ts]
verified-at: a6f140247e
---
## Quick answers
- How does the runtime surface an invalid config file? It doesn't: `Config.parseInfo` (`core/src/config.ts`) drops a file that isn't JSONC, that `ConfigNormalize` rejects or that fails the `Info` schema, and only logs "configuration normalization diagnostic"; a malformed value inside a valid file is skipped with a diagnostic and the rest loads. `GET /api/config` returns only what loaded. The `kete.doctor` RPC (`core/src/kete/doctor.ts` `checkText`) re-checks each file the last load read (`KeteFolderTrust.configFiles()`) the same way, substituting `{env:}`/`{file:}` where the loader does (machine files always, project files once trusted), for `kete doctor` and `/doctor`. An unreadable global or top-level project `kete.json(c)` is different: `ConfigDiscovery.discover` realpaths it and fails with EACCES, so the runtime doesn't start; an unreadable `.kete/kete.json(c)` is skipped silently (the doctor lists it as unreadable).
- How far does project config discovery walk, and how do I boot a location without project config? `ConfigDiscovery.discover` calls `fs.up({targets:["."], start: location.directory})` with no `stop`, so it walks every ancestor to the filesystem root (`core/src/config/discovery.ts:35-37`), collecting `.kete/`, `.claude/`, `.agents/` and the config file names in each; only a location equal to the global config dir, or `Options.project === false`, skips the walk. The seam: `Config.configured({project:false})` (`core/src/config.ts:367`; `global:false` drops the global dir too) or instance `Options.discovery:false` (`core/src/instance.ts:131`), which swaps in `Config.configured({project:false, global:false})` and the instruction-discovery twin (`:143-144`, applied `:153`).
- Which file holds TUI settings, and what happens on a bad value? `cli.json` in the global config directory (`packages/cli/src/config/config.ts:31`), not `tui.json`; it is decoded with `Schema.decodeUnknownOption` (`:22`, applied `:65`), so one invalid value drops every setting in the file. Kete's keys: `statusline` (`{ items: string[], colors }`, `KeteStatusLineConfig` `tui/src/kete/statusline-config.ts:52`, `config/index.tsx:244`; `items` is a plain string array so an unknown ID is reported, not fatal) and `tips` (boolean, `config/index.tsx:245`; `false` hides the home tip). Keybind overrides are merged in `resolve` (`config/index.tsx:283-295`; `prompt.history.search`/`session.rename` rule in the `ui-branding` card). Not part of the protocol/client regen.
- What is `kete.sandbox` / `kete.lsp`? `ConfigKete.Sandbox` (`schema/src/config/kete.ts:91-123`: `mode` auto/required/off, `network`, `caches`, `loopback`, `allowWrite`/`allowRead`/`denyRead`/`denyWrite`; `Info.sandbox` `:190`) is the OS sandbox for shell commands (`docs/sandbox.md`); only the global config can loosen it, a project config can only tighten. `ConfigKete.Lsp.unsandboxed` (`:165`, `Info.lsp` `:197`) lets language servers start without an active sandbox (global config only). Hooks classes are at `:125-163`.
- How does Kete add a TUI config key? TUI config is separate from the runtime `kete` section: its schema is `Info` in `packages/tui/src/config/index.tsx:68` (resolved by `resolve` `:279`, read with `useConfig` `:372`), an upstream file. A new TUI key is therefore an upstream edit that needs `kete_change` markers (no `kete` path to exempt it), unlike a `kete.*` key in `packages/schema/src/config/kete.ts`, which needs no upstream edit and no TUI change. Not part of the protocol/client regen.
- What is `kete.hooks`? Shell hooks (`ConfigKete.Hooks`); unlike other `kete` fields it is read from every document, user vs project (project hooks need trust) — see the `hooks` card. Protocol and client regenerated. `kete job run` treats it as a guarded repository key.
- What is `kete.unattended.passEnv`? `ConfigKete.Unattended` (`schema/src/config/kete.ts:82-88`, `Info.unattended` `:187`): names an unattended run's shell commands keep although they look like credentials; read by `KeteToolEnv.forSession` via `Config.latest(entries, "kete")` (so, like every `kete` field, the highest-priority file's whole `kete` object wins). `kete job run` refuses a repository config that sets `kete.unattended` (or `kete.integrations`/`kete.platform`) unless `--trust-project-config`. Protocol and client regenerated.
- What is `kete.integrations.slack.clientId`? The Slack app client ID `kete mcp add slack` uses when `--client-id` isn't given (`schema/src/config/kete.ts:72`, camelCase as the spec named it, unlike `max_concurrent`); protocol and client regenerated. The CLI reads it straight from the project/global config files (`cli/src/kete/mcp-preset-io.ts:33`). See the `mcp-presets` card.
- What is `kete.offline`? An optional boolean (`schema/src/config/kete.ts:173`): offline mode (local models only, no platform/gateway/update/web/remote-MCP calls). Global config applies process-wide; a project config covers everything except the models.dev fetch and update checks (decided at startup). Fail-closed: a non-boolean counts as on. See the `local-models` card; the schema change regenerated `protocol/openapi.json` and the client types.
- Is there an env var that disables project config outside job mode? Yes — upstream's
  `OPENCODE_CONFIG_PROJECT_DISABLE`/`OPENCODE_DISABLE_PROJECT_CONFIG` (checked in that order,
  `packages/cli/src/server-process.ts:111-113`, user-facing `KETE_CONFIG_PROJECT_DISABLE` via the
  env bridge), which becomes `ServerOptions.config.project: false` — the same `Config.configured`
  flag job mode's own replacement sets. It only ever covers **project** config discovery
  (`core/src/config/discovery.ts`'s upward walk); it doesn't touch `ConfigPluginSource`, the process
  spawner, PTY, formatter or the model-request executor the way job mode's full replacement list
  does — this is why job mode needed its own `KeteJobServer.replacements`, not just this flag (plan
  `docs/tasks/2026-09-29-job-tool-isolation/plan.md` "Upstream edits").
- Does job mode (`KETE_JOB_MODE`) change config discovery? Not this module's code — job mode
  replaces the whole `Config.node` with `Config.configured({project: false, ...})`
  (`server/src/kete/job-server.ts:88-90`), an existing option this module already exposes
  (`core/src/config.ts`), not a new discovery rule. The effect: the project config walk (repo
  `kete.json(c)`, `.kete/`) never runs; the global config dir (where `kete.runtime.type` lives)
  still loads. See the `job-mode` card, `docs/jobs.md` "Job mode".
- Where do Kete-only settings live in `kete.json`/`.kete/`? Under the top-level `kete` key — schema at `packages/schema/src/config/kete.ts`.
- Where do I add a new `kete.*` field? `ConfigKete.Info` in `packages/schema/src/config/kete.ts:172-200`, plus the protocol/client regen in CLAUDE.md §8. Nothing to touch in `normalize.ts` or `discovery.ts` for a field *inside* an existing sub-object (e.g. a new `Budget` field) — only for a brand-new top-level sub-key of `kete` (none needed there either; see Changes).
- Does `kete.budget` merge with `kete.subagents` from a different config file? No — the whole `kete` object is replaced by the highest-priority file that sets it (`packages/core/src/config.ts:23-26`); see Gotchas.
- How do I read a kete setting in runtime code? `Config.latest(yield* config.entries(), "kete")?.<field>` — see `packages/core/src/kete/subagents.ts:113`, `:225`, `:300`, `workflows.ts:241`, and `sync/plugin.ts:363` (`?.runtime?.type`, resolved via `KeteRuntimeRegistration.resolveRuntimeType` — see the runtime-registration card).
- Where's the runtime type field (ADR 0005)? `ConfigKete.Runtime` (`kete.ts:22-27`), `Info.runtime` (`:179`) — one of `"local"`/`"kete_cloud"`/`"enterprise_private"`, default `local`, falls back to `KETE_RUNTIME_TYPE`; consumed by `runtime-registration` and read by `kete whoami` (`cli`/`account-login` cards).

## Purpose
`ConfigKete.Info` is the single Kete-owned config namespace (`kete` key of `Config.Info`), holding settings with no upstream OpenCode equivalent: session spend budgets, the Kete platform URL, subagent concurrency/timeout/worktree defaults, and named workflows. Kept as one namespace so upstream config sections never conflict with Kete's on sync (CLAUDE.md §4).

## Entry points
- Schema: `packages/schema/src/config/kete.ts` — `Budget`, `Platform`, `Runtime`, `Subagents`, `WorkflowStep`, `Workflow`, `Integrations`, `Unattended`, `Sandbox`, `Hook`/`Hooks`, `Lsp`, `Info` (`ConfigKete.Info`, lines 172-200).
- Wired into the root config schema: `packages/schema/src/config.ts:12` (import, `kete_change`), `:111` (`kete: ConfigKete.Info.pipe(optional)`, `kete_change`).
- Normalized as an atomic top-level field: `packages/core/src/config/normalize.ts:214` (`kete: Info.fields.kete` in the `nativeAtomic` map, `kete_change`).
- Read anywhere via `Config.Service.entries()` + `Config.latest(entries, "kete")`: `packages/core/src/config.ts:23-26`.

## Key files
| File | Role |
| --- | --- |
| `packages/schema/src/config/kete.ts` (200 lines) | Schema classes: `Budget`, `Platform`, `Runtime`, `Subagents`, `WorkflowStep`, `Workflow`, `Integrations`, `Unattended`, `Sandbox`, `Hooks`, `Lsp`, `Info` |
| `packages/schema/src/config.ts:12,111` | Wires `ConfigKete.Info` into `Config.Info` as the `kete` field |
| `packages/core/src/config/normalize.ts:200-221` | `nativeAtomic` — top-level fields (incl. `kete`) copied verbatim per source file, no per-field deep merge |
| `packages/core/src/config/discovery.ts` | Finds candidate config files/dirs; unrelated to `kete`-key semantics, only to which files are read (uses `Brand.configFiles`, `Brand.projectDirectory`, `kete_change` at lines 10,12,42-43,68-72) |
| `packages/core/src/config.ts:23-26` | `Config.latest(entries, key)` — last document (highest priority) that set the key wins, whole value |
| `packages/core/src/kete/subagents.ts` | Consumer: `kete.subagents.{timeout,max_concurrent,worktree}` |
| `packages/core/src/kete/workflows.ts` | Consumer: `kete.workflows` |
| `packages/core/src/kete/gateway.ts:15-17` | Consumer: `kete.platform.url` (gateway pricing/balance) |
| `packages/core/src/kete/sync/plugin.ts:363`, `packages/cli/src/kete/account-flow.ts:367-391` | Consumers: `kete.runtime.type` (runtime registration, `kete whoami`) |

## Data flow
1. `ConfigDiscovery.discover` finds candidate `kete.json`/`.kete/` files/dirs (lowest→highest priority; `packages/core/src/config.ts:29` comment).
2. Each file is parsed and run through `ConfigNormalize.normalize` (`packages/core/src/config/normalize.ts`), which copies `input.kete` verbatim into `encoded.kete` if present (no schema-aware merge at this stage beyond `decodeEncoded`/`overlay`, lines 216-221).
3. `Config.Service.entries()` (`packages/core/src/config.ts:30`) returns the ordered `Entry[]` (one `Document` per source file, low→high priority).
4. A consumer calls `Config.latest(entries, "kete")` (`config.ts:23-26`), which returns the **entire** `kete` object from the highest-priority document that defined it — not a deep merge across documents.
5. Consumers destructure the sub-object they need (`?.budget`, `?.platform?.url`, `?.subagents`, `?.workflows`).

## Data and APIs used
- `packages/protocol/openapi.json` embeds `ConfigKete.*` schemas (e.g. `ConfigKete.WorkflowEncoded`, `ConfigKete.WorkflowStepEncoded` — see `openapi.json:13234,13593,13602,13610`), generated by `bun run generate` in `packages/protocol` (`packages/protocol/script/generate-openapi.ts`, `--check` mode used in CI).
- `packages/client/src/promise/generated/types.ts` mirrors those schemas; generated by `bun run generate` in `packages/client` (`packages/client/script/build.ts`). Never hand-edit either generated tree (CLAUDE.md §4, §8).
- No direct platform API dependency; `kete.platform.url` only configures where `packages/core/src/kete/gateway.ts` looks up prices/balance (ADR 0004).

## Rules that must not break
- `kete` stays a Kete-owned schema module (`packages/schema/src/config/kete.ts` — no `kete` in the path pattern needed since the file itself is under a `kete` dir); the two edits to the upstream `packages/schema/src/config.ts` and `packages/core/src/config/normalize.ts` must keep their `kete_change` markers (CLAUDE.md §4).
- Never rename/move `packages/schema/src/config.ts` or `packages/core/src/config/normalize.ts` — upstream-owned files (CLAUDE.md §2).
- `kete` is merged as a whole value across config sources, like every other top-level key in `nativeAtomic`; do not special-case deep merging for `kete` without also handling every other atomic key consistently.
- Config precedence (project vs. user vs. global) is local-discovery precedence (`ConfigDiscovery.discover`), distinct from the platform/org/project/user/workspace policy precedence in CLAUDE.md §5 — don't conflate the two.

## Testing
- Schema-level: no dedicated `packages/schema/test` file for `ConfigKete` as of bfd6c66; schema classes are exercised indirectly through core tests.
- Narrowest: `bun run test ./test/kete/<file>.test.ts` inside `packages/core` — `config-discovery.test.ts`, `budget.test.ts`, `budget-agents.test.ts`, `subagents.test.ts`, `workflows.test.ts`, `gateway.test.ts` (all under `packages/core/test/kete/`).
- Package-wide: `bun run test` inside `packages/core` (isolates HOME/XDG — CLAUDE.md §8; don't bypass with bare `bun test`).
- Protocol/client drift check: `bun run check:generated` in `packages/protocol` and `packages/client` (see their `package.json` scripts) catches a schema change that wasn't regenerated.

## Changes
Adding a new `kete.*` config key end to end:
1. Add the field to the relevant class (or a new `Schema.Class`) in `packages/schema/src/config/kete.ts`, with an `.annotate({ description: ... })` (schema descriptions become config docs/JSON-schema hints).
2. If it's a new top-level sub-key of `ConfigKete.Info` (line 64), add it there (`Info`, line 172); no change needed in `packages/schema/src/config.ts` or `packages/core/src/config/normalize.ts` — both already treat `kete` atomically.
3. Read it in runtime code via `Config.latest(yield* config.entries(), "kete")?.<path>`, following the pattern in `packages/core/src/kete/subagents.ts:113` or `workflows.ts:241`.
4. Regenerate the protocol/client (CLAUDE.md §8): `bun run generate` in `packages/protocol` (writes `openapi.json`), then `bun run generate` in `packages/client` (writes `src/*/generated/`). Commit both.
5. Add a test under `packages/core/test/kete/` exercising the new field through `Config.Test`/`Config.testLayer` (see `packages/core/src/config.ts:58-68`).
6. Run `bun run typecheck` and `bun run test` in `packages/schema` and `packages/core`, then `bun run --cwd packages/kete-tools upstream:check` (confirms the two `kete_change` markers are still intact and no new unmarked upstream edits crept in).

## Gotchas
- Setting `kete.budget.session` in a higher-priority file silently drops `kete.platform.url`/`kete.subagents`/`kete.workflows` set in a lower-priority file *for that key's whole object* — because `Config.latest` returns one document's entire `kete` value, not a per-field merge. Document this for users who split settings across global and project config.
- `packages/schema/src/config.ts:111`'s description ("Kete Code settings") is the only place a human sees a top-level description for the whole namespace — keep it accurate as sub-keys grow.
- `unsupportedTopLevel`/`unsupportedExperimental` arrays in `normalize.ts` (lines 44-51) are upstream-key lists; don't add `kete` sub-fields there — they're for rejecting legacy/unsupported upstream keys, not for anything under `kete`.
