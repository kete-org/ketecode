# Plan: Runtime type from configuration (ADR 0005)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large: config schema change** (new `kete.runtime.type` key, protocol and client regenerated).
> The user approves this plan before building. **Upstream edits: none.** Every file changed is
> Kete-owned (`kete` in the path): `packages/schema/src/config/kete.ts`,
> `packages/util/src/kete/runtime-registration.ts`, `packages/core/src/kete/sync/plugin.ts`,
> `packages/cli/src/kete/account-flow.ts`, plus generated files. If the build needs anything else,
> stop and send it back to the planner (upstream-guard reviews any upstream edit).
> **Security:** no permission, auth or secret handling changes. The registration payload keeps the
> same five fields; only the `runtime_type` value can now differ.

## Cards read
- docs/context/modules/config-kete.md (verified-at bfd6c66, stale: no)
- docs/context/modules/runtime-registration.md (verified-at bfd6c66, stale: no)
- docs/context/modules/sync.md (verified-at bfd6c66, stale: no)
- docs/context/modules/cli.md (verified-at bfd6c66, stale: no)
- docs/context/modules/brand-env.md (verified-at bfd6c66, stale: no)
- docs/context/modules/server-sdk.md (checked for staleness only: not stale)
- Also: pitfalls.md, commands.md, contracts.md §3, decisions.md

## Design (the smallest version)
- **One resolver, in util** (Kete-owned, shared by core and cli, because the CLI can't import core):
  `KeteRuntimeRegistration.runtimeTypes` (the three values as a `const` array, the `RuntimeType`
  type derived from it) and `resolveRuntimeType(configured: unknown, environment)` returning a
  discriminated union:
  `{ kind: "ok"; type: RuntimeType; source: "config" | "KETE_RUNTIME_TYPE" | "default" }` or
  `{ kind: "invalid"; source: "config" | "KETE_RUNTIME_TYPE"; value: string }`.
  Precedence: config value if set, else the environment variable, else `"local"`. The variable
  is read as `OPENCODE_RUNTIME_TYPE` (the env bridge renames `KETE_*`, as `platformVariable` does
  at `core/src/kete/gateway.ts:41`); messages name it `KETE_RUNTIME_TYPE`. Export the internal
  name as `runtimeTypeVariable`. The value is truncated (e.g. 50 chars) before it appears in a
  message or `value`.
- **Schema:** `ConfigKete.Runtime` class with `type: Schema.Literals(["local", "kete_cloud",
  "enterprise_private"])`, optional; `runtime: Runtime` optional on `ConfigKete.Info`. The schema
  package doesn't depend on util, so the literal list is written in both places; the core call
  site passes the config value to `resolveRuntimeType`, and typecheck plus a util test that
  compares both lists keep them together (see step 5).
- **Registration re-runs when the type changes:** add an optional `runtime_type` to the
  `registered` snapshot in `State` (`runtime-registration.ts:33-39`); the due check treats a
  missing one as `"local"` (older `installation.json` files stay valid) and re-registers when it
  differs. Without this a changed type waits up to a day.
- **Core call site:** resolve on every registration tick (so a config change is picked up without
  restart). `invalid` → `Effect.logError` naming the source and value, no `register()` call for
  that tick (never guess, CLAUDE.md §10). `make()` gains an optional `environment` option
  (default `process.env`), the same test seam gateway uses (`gateway.ts:141`).
- **whoami:** the CLI's `globalConfig()` (`account-flow.ts:360-380`) also returns the raw
  `kete.runtime.type`; `whoami()` resolves it with `io.environment` and prints
  `Runtime:      <type>` after the `Device:` line when the type isn't `local`, and a warning
  (`io.warn`) when it is invalid ("registration is skipped"). The CLI reads only the global config
  (as for `kete.platform.url`); a project-level `kete.runtime.type` is seen by the server but not by
  `whoami` — say so in the schema description. `whoamiJSON` is unchanged (its output is a contract
  the VS Code extension reads; adding `runtime_type` there is a separate decision).

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/schema/src/config/kete.ts` | change | Add `Runtime` class and `Info.runtime`; description states the default, the `KETE_RUNTIME_TYPE` fallback, config-wins, and that `kete` doesn't deep-merge across files |
| `packages/util/src/kete/runtime-registration.ts` | change | `runtimeTypes`, `runtimeTypeVariable`, `resolveRuntimeType()`; `runtime_type` in the `registered` snapshot and due check |
| `packages/core/src/kete/sync/plugin.ts` | change | Lines ~109-120 (`make` options) and ~355-369 (registration loop): resolve type from `Config.latest(entries, "kete")?.runtime?.type` and the environment; log error and skip on invalid |
| `packages/core/src/config.ts` | read (lines 20-30, 58-80) | `Config.latest`, `Config.testLayer` for the tests |
| `packages/core/src/kete/gateway.ts` | read (lines 35-45, 135-145, 430-440) | The existing config-then-env pattern and `environment` option to copy |
| `packages/cli/src/kete/account-flow.ts` | change | `globalConfig()` returns `runtime`; `whoami()` prints the runtime line or the warning |
| `packages/util/test/kete/sync-policy.test.ts` | change | Resolver unit tests (precedence, default, invalid env, invalid config), literal-list parity with the schema, re-registration when the type changes, old state without `runtime_type` |
| `packages/core/test/kete/policy-sync.test.ts` | change | Registration tests: default `local` (exists, line ~191), config `kete_cloud`, env `enterprise_private`, config beats env, unknown env → no registration + error |
| `packages/cli/test/kete/login.test.ts` | change | `kete whoami` tests (line ~441): prints `Runtime:` for `kete_cloud`, not for `local`, warns on unknown value |
| `packages/protocol/openapi.json` | generated | `bun run generate` in `packages/protocol` |
| `packages/client/src/*/generated/` | generated | `bun run generate` in `packages/client` (after protocol) |
| `packages/core/src/kete/skill/kete.md` | change (one line) | Built-in Kete skill lists the `kete.*` settings next to `kete.platform.url` (line ~64); mention `kete.runtime.type` / `KETE_RUNTIME_TYPE` |

## Steps
1. **Schema** — in `packages/schema/src/config/kete.ts` add `export class Runtime extends
   Schema.Class<Runtime>("ConfigKete.Runtime")({ type: Schema.Literals([...]).pipe(optional).annotate({description}) })`
   and `runtime: Runtime.pipe(optional).annotate({ description: "Where this runtime runs" })` in
   `Info`. Description: values, default `local`, falls back to `KETE_RUNTIME_TYPE`, config wins,
   `kete whoami` reads only the global config, and the whole `kete` object from the
   highest-priority config file wins (keep all `kete` settings in one file).
2. **Util** — in `runtime-registration.ts`: `export const runtimeTypes = ["local", "kete_cloud",
   "enterprise_private"] as const`, `RuntimeType = (typeof runtimeTypes)[number]` (same union as
   today), `runtimeTypeVariable = "OPENCODE_RUNTIME_TYPE"`, `resolveRuntimeType()` as in Design
   (config `undefined` → try env; empty env string counts as unset; anything not in the list →
   `invalid`). Add optional `runtime_type` to the `registered` struct, compare
   `(last.runtime_type ?? "local") !== (options.runtimeType ?? "local")` in `due`, and write it in
   `writeState`. Keep the file header's "no other fields" promise.
3. **Core** — in `plugin.ts` `make()` options add `readonly environment?: Record<string, string |
   undefined>`. Build the registration effect as: read `Config.latest(yield* config.entries(),
   "kete")?.runtime?.type`, resolve; `invalid` → `Effect.logError(\`${Brand.displayName} runtime
   registration skipped: unknown runtime type\`, { source, value })` and return; `ok` → the existing
   `register({ ...syncOptions, version, runtimeType: resolved.type })` and outcome logging. Keep
   `Effect.catch`, the repeat schedule and `forkScoped` unchanged.
4. **CLI** — in `account-flow.ts`: extend `globalConfig()`'s reduced result with `runtime?:
   unknown` (later file wins, same as `platform`); in `whoami()` after `Device:` call
   `KeteRuntimeRegistration.resolveRuntimeType(config.runtime, io.environment)`; `ok` and not
   `local` → `io.print(\`Runtime:      ${type}\`)`; `invalid` → `io.warn` naming the source
   (`KETE_RUNTIME_TYPE` or `kete.runtime.type`) and that runtime registration is skipped. Import
   from `@opencode/util/kete/runtime-registration` (check the import path already used for
   `KeteAccount` in that file).
5. **Tests** — util: resolver table tests; parity test importing `ConfigKete.Runtime` from
   `@opencode/schema` only if util's test can resolve it — otherwise put the parity check in the
   core test (core depends on both); re-registration on type change; old state file. Core: extend
   `policy-sync.test.ts` using `Config.testLayer([...entries with kete.runtime.type])` and the new
   `environment` option; the unknown-env case asserts zero registrations after the plugin's first
   tick and, if the test harness captures logs, the error. CLI: whoami cases via
   `session.io.environment` and a global `kete.json` in the session's config dir.
6. **Generate** — `bun run generate` in `packages/protocol`, then in `packages/client`. Stage both.
7. **Docs** — the one-line addition to `packages/core/src/kete/skill/kete.md`.
8. Run the verification table; nothing in `docs/upstream-patches.md` (no upstream edits).

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/core`: `bun run test ./test/kete/policy-sync.test.ts` |
| AC2 | in `packages/core`: `bun run test ./test/kete/policy-sync.test.ts`; in `packages/util`: `bun test ./test/kete/sync-policy.test.ts` |
| AC3 | in `packages/core`: `bun run test ./test/kete/policy-sync.test.ts -t "unknown"`; in `packages/util`: `bun test ./test/kete/sync-policy.test.ts` |
| AC4 | in `packages/cli`: `bun test ./test/kete/login.test.ts -t "whoami"` |
| AC5 generated | `bun run generate` in `packages/protocol` then `packages/client`; then `bun run check:generated` in both |
| AC5 typecheck | `bun run typecheck` in `packages/schema`, `packages/util`, `packages/core`, `packages/cli` |
| AC5 Kete tests | `bun run test ./test/kete` in `packages/core`; `bun test ./test/kete` in `packages/util` and `packages/cli` |
| AC5 lint, hygiene | root: `bun run lint`; `bun run --cwd packages/kete-tools upstream:check` |
| Before PR | `bun run --cwd packages/kete-tools verify --base main` |

## Risks
- **Platform acceptance:** the runtime's `RuntimeType` already lists all three values, but there is
  no `docs/platform/` copy of the registration contract and ADR 0005 is not in `docs/adr/` here
  (platform-side). If the platform rejects `kete_cloud`/`enterprise_private`, registration fails
  with a logged warning and retries daily; it never breaks anything else. Confirm with the
  platform repo before a release that sets a non-local type.
- **Non-CLI hosts** (`packages/desktop`, direct server embedding) aren't env-bridged, so there
  `KETE_RUNTIME_TYPE` isn't seen — same limitation as `KETE_PLATFORM_URL`; config still works.
- **Two literal lists** (schema and util): guarded by the parity test and typecheck at the core
  call site.
- **whoami vs. server** can disagree when only a project config sets `kete.runtime.type`
  (documented in the schema description).

## Cards to update after the build
- `config-kete` — `Runtime` class, `Info` line numbers, consumer `sync/plugin.ts`.
- `runtime-registration` — `resolveRuntimeType`, `runtime_type` in the snapshot and due check,
  call site no longer hard-codes `"local"`; Quick answer "how is the runtime type chosen".
- `sync` — `make()` `environment` option; registration error path.
- `cli` — `whoami` prints `Runtime:`; `globalConfig()` reads `kete.runtime.type`.
- `contracts.md` §3 — line numbers in `runtime-registration.ts`.
