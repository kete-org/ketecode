# Conventions for Kete-owned code

How code under `src/kete/` and `packages/kete-*` is written, following upstream's Effect
style (CLAUDE.md §4). See `docs/context/decisions.md` for the rules this enforces and
`docs/context/pitfalls.md` for mistakes these patterns exist to avoid.

## Module shape

Every Kete module opens with a comment explaining *why* it exists and what it changes,
then `export * as KeteX from "./x.js"` as its first statement, e.g.
`packages/core/src/kete/gateway.ts:1-21` (`KeteGateway`),
`packages/core/src/kete/budget.ts:1-17` (`KeteBudget`),
`packages/core/src/kete/sync/plugin.ts:1-41` (`KeteAgentSync`),
`packages/core/src/kete/skill.ts:3-12` (`KeteSkillPlugin`, explains it replaces
upstream's `opencode`/`report` skills without touching upstream markdown). Modules
inside upstream packages (`packages/core/src/kete/*.ts`) never need `kete_change`
markers themselves — only edits to files *outside* `kete/` directories do.

## Plugins as `{id, effect}`

Kete behavior is added as a plugin object built with `define({ id, effect })`
(`@opencode/plugin/effect/plugin`), e.g. `gateway.ts:143-145`
(`id: "kete.provider.gateway"`), `permission-mode.ts:28-30` (`id: "kete.permission-mode"`),
`skill.ts:37-39` (`id: "kete.skill"`). Plugins are registered in one ordered array in
`packages/core/src/plugin/internal.ts:232-291`, each with a one-line comment saying
*where* in the order and *why* (e.g. `internal.ts:267-268`: "after SkillPlugin and
OpenCodeTools; replaces their OpenCode-specific skills"). Order matters: later
registrations can see and override what earlier ones did (`sync/plugin.ts:6-7`: the
agent-sync plugin runs after `ConfigAgentPlugin` "so it has the last word").

## Effect.gen / Effect.fn

Plugin bodies and internal helpers are `Effect.fn(function* (ctx) { ... })` (unnamed) or
`Effect.fn("Label")(function* () { ... })` (named, for tracing) — never bare
`async`/`await`. Examples: `gateway.ts:145` (unnamed, plugin body),
`gateway.ts:148,159,207,217,256,289,306,316,381` (named helpers like
`"KeteGateway.discover"`, `"KeteGateway.pricing"`), `skill.ts:87,107`
(`reportWithDiagnostics`, `configuredPlugins`). Multi-step logic inside a step uses
`Effect.gen(function* () { ... })`, e.g. `permission-mode.ts:38-46`.

## Services via `Context.Service`

Upstream's own services are the pattern to extend, not to duplicate: e.g.
`packages/core/src/tool.ts:65` — `class Service extends Context.Service<Service,
Interface>()("@opencode/Tool") {}`. Kete modules generally don't define new services;
they consume existing ones (`Config.Service`, `HttpClient.HttpClient`) inside a plugin's
`effect`, e.g. `gateway.ts:146-147` (`const http = yield* HttpClient.HttpClient`).

## Hooks: permission and tool

Permission changes go through `ctx.permission.hook("evaluate", ...)`, ordered on top of
existing rules, and only ever tighten or deny — never loosen an existing "ask"/"deny"
into "allow": `permission-mode.ts:38-46` (comment at :3-5: "It only ever tightens"),
`permission-ceiling.ts:118`. Tool behavior goes through `ctx.tool.hook("execute.before" |
"execute.after", ...)`: `stale-write.ts:94-106` (before: reject a write over an unseen
version; after: record what the session has seen), `session-move.ts:54` (before: check
the target).

## Schema validation of external input

Every external shape (platform responses, config, secrets) is a `Schema.Struct` decoded
with `Schema.decodeUnknownOption`/`decodeUnknownSync`, never trusted as-is. Platform
responses: `packages/util/src/kete/sync/contract.ts` (whole file; header :1-3 states
unknown fields are ignored by default), consumed via
`packages/util/src/kete/sync/client.ts:50`. Gateway/platform HTTP bodies:
`packages/core/src/kete/gateway.ts:53-76` (`AnthropicList`, `PlatformModels`,
`PlatformMe`, with units documented inline, e.g. :56 "micro-USD per million tokens").
Local state files: `packages/util/src/kete/account.ts:18-28` (`Account`),
`packages/util/src/kete/runtime-registration.ts:32-36` (`State`). Regex/bounds checks
sit directly on the field (`Schema.isPattern`, `isMaxLength`), not validated separately.

## Errors

No swallowed errors (CLAUDE.md §10). Recoverable tool failures return a typed error
instead of throwing past the caller: `Tool.Error` (from `../../tool.js`) at
`session-move.ts:61,75,93,95` and `stale-write.ts:102`; `ToolFailure` (from
`@opencode/ai`) at `workflows.ts:274,279` and `subagents.ts:22+`. Network/client errors
get a dedicated class with a stable `code` for callers to switch on:
`packages/util/src/kete/sync/client.ts:11-18` (`SyncError`, codes `network` |
`unauthorized` | `unavailable` | `invalid_response` | `rejected`),
`packages/core/src/kete/git.ts:20` (`GitError`). Unrecoverable/background failures are
logged and the last-known state is kept rather than crashing the plugin:
`gateway.ts:241-246` (one gateway route failing keeps its last models),
`sync/plugin.ts:15-16` (a sync error keeps the last cached agents).

## Tests

Run per-package, never from the repo root (CLAUDE.md §8): `bun run test` in
`packages/{util,core,server,tui,cli}`; `core`'s and `server`'s test scripts isolate
HOME/XDG (`packages/core/script/test.ts:1-30`) so tests never read the developer's real
Kete account — don't bypass them with bare `bun test`. Kete tests live in
`packages/<pkg>/test/kete/` (e.g. `packages/core/test/kete/*.test.ts`, 19+ files).
Effect-based core tests use `testEffect` over an `AppNodeBuilder` fixture built from the
`LayerNode`s a test needs: `packages/core/test/kete/agent-sync.test.ts:23-27`
(`AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node,
Global.node]))`, `const it = testEffect(...)`). Fakes stand in for network/OS layers
(a fake `fetch`, a fake `KeteSecretStore`) passed as function options rather than
module-level mocking — see `fetch?: Fetch` on `fetchAgents`
(`packages/util/src/kete/sync/client.ts:23`) and `account?: KeteAccount.Options` on
`gateway.ts:136`.

## Naming and Brand

Never hard-code product names, directories, env prefixes or URLs; import from
`packages/util/src/kete/brand.ts` (`Brand.displayName`, `Brand.cliName`,
`Brand.appDirectory`, `Brand.envPrefix`, etc., defined :9-31). Used throughout, e.g.
`gateway.ts:154,175,185` (`Brand.displayName`, `Brand.cliName`). `brand.ts` is
kept dependency-free (header :5-7) since it's imported from code that runs before the
CLI finishes starting.

## Cross-platform paths

Always `path.join`/`path.posix`/`path.win32`, never string concatenation or hardcoded
separators (CLAUDE.md §11). Functions that build paths from config accept an injectable
`join` for Windows-path testing on any OS: `packages/util/src/kete/sync/cache.ts:28-29`
(comment: "tests pass path.win32.join to check Windows paths on any platform"),
`packages/util/src/kete/sync/skills.ts:36`. Directory names built from untrusted input
(an organization id) are validated before touching the filesystem:
`packages/util/src/kete/sync/cache.ts:31` (`guid.test(organization)` or throw) and path
traversal is rejected explicitly in `packages/util/src/kete/sync/skills.ts:49-55`
(`safeRelative`: rejects absolute paths, drive letters, `..`, empty segments).
