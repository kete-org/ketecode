# Handoff: Runtime type from configuration (ADR 0005)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-28 scout (3 questions)

- Q1 where the runtime type is defined and hard-coded → docs enough: yes (runtime-registration card).
- Q2 reading a kete setting and KETE_* variable; adding a config key end to end → docs enough: yes (config-kete, brand-env).
- Q3 other runtime-type-aware code → docs enough: yes (attribution-hosted, cli, server-sdk): none.
- 42k tokens, 43 s.

## 2026-09-28 coordinator

- spec.md approved by the user (2026-09-28).

## 2026-09-28 planner

- Done: plan.md written (12 files incl. 2 generated trees; no upstream edits). All cards current (stale-cards: none).
- Docs enough: no — missing: the core call site's config/env access (whether `make()` has an environment seam; it doesn't; gateway.ts:141 has the pattern) — opened `core/src/kete/sync/plugin.ts:109-120,355-369`.
- Docs enough: no — missing: how `kete whoami` reads config (CLI's own `globalConfig()` raw-JSON reader, global config only, `account-flow.ts:360-380`) and `whoami()` output lines (`account-flow.ts:298-330`); cli card doesn't mention either.
- Docs enough: no — missing: `State.registered` snapshot fields (`runtime-registration.ts:33-39`) — needed to see that a type change wouldn't re-register until a day passes.
- Docs enough: no — missing: which core test covers registration (`policy-sync.test.ts:63-191`, not agent-sync); runtime-registration card lists only the util test.
- Decisions: resolver lives in util (CLI can't import core); config wins over KETE_RUNTIME_TYPE; `runtime_type` added to the registered snapshot so a change re-registers; `whoamiJSON` unchanged (VS Code contract).
- Open questions: does the platform accept `kete_cloud`/`enterprise_private` today? ADR 0005 isn't in docs/adr/ (platform-side) and there's no docs/platform/ mirror of the registration contract.

## 2026-09-28 builder

- Done: built the plan exactly, all 8 steps.
  - `packages/schema/src/config/kete.ts`: added `ConfigKete.Runtime` (`type: Schema.Literals(["local",
    "kete_cloud", "enterprise_private"])`, optional, with the long description: values, default,
    `KETE_RUNTIME_TYPE` fallback, config wins, `whoami` reads only the global config, `kete` doesn't
    deep-merge across files) and `Info.runtime`.
  - `packages/util/src/kete/runtime-registration.ts`: `runtimeTypes` (const array), `RuntimeType`
    derived from it (same union as before), `runtimeTypeVariable = "OPENCODE_RUNTIME_TYPE"`,
    `resolveRuntimeType(configured, environment)` returning the `ok`/`invalid` discriminated union
    (messages/source use the name `"KETE_RUNTIME_TYPE"`, distinct from the internal
    `runtimeTypeVariable` used to read `environment`); values truncated to 50 chars before they can
    appear in a message. `State.registered.runtime_type` (optional `Schema.String`) added; `due`
    compares `(last.runtime_type ?? "local") !== (options.runtimeType ?? "local")`; `writeState`
    always writes the resolved type (defaulting to `"local"`).
  - `packages/core/src/kete/sync/plugin.ts`: `make()` gained `environment?: Record<string, string |
    undefined>` (default `process.env`); stored as `runtimeEnvironment` internally — the module
    already exports a top-level `environment = "development"` (an environment *kind* for policies,
    used a few lines away in the permission hook), so reusing that name as a local would have
    shadowed it silently. The registration effect now reads `Config.latest(yield*
    config.entries(), "kete")?.runtime?.type`, resolves it each tick, and on `invalid` calls
    `Effect.logError` (source + truncated value) and skips that tick's `register()` call instead of
    guessing; `ok` registers with the resolved type as before.
  - `packages/cli/src/kete/account-flow.ts`: imported `KeteRuntimeRegistration`; `globalConfig()`
    now also returns the raw `kete.runtime.type` (later file wins, same merge rule as `platform`);
    `whoami()` resolves it with `io.environment` right after the `Device:` line and prints
    `Runtime:      <type>` (14-column alignment, matching the other `whoami` lines) when the type
    isn't `local`, or `io.warn`s naming the source (`kete.runtime.type` / `KETE_RUNTIME_TYPE`) and
    that registration is skipped when the value is invalid. `whoamiJSON` untouched.
  - Tests: `packages/util/test/kete/sync-policy.test.ts` — a new `resolveRuntimeType` describe
    (config-wins, env fallback, empty-env-as-unset, default, invalid at both sources, truncation,
    and a literal-list-matches-the-schema check written by hand since `util` has no dependency on
    `@opencode/schema`) plus two new cases in the existing "runtime registration" describe:
    re-registration when only the type changes, and an `installation.json` written in the old shape
    (no `runtime_type`) still being read as `"local"`. `packages/core/test/kete/policy-sync.test.ts`
    — extended `start()` with `{ entries?, environment? }` wired into `Config.testLayer` and
    `KeteAgentSync.make({ environment })`; a `runtimeDocument()` helper building a `kete.runtime`
    config document via `Schema.decodeUnknownSync(Info)`; new `it.live` cases for config-set type,
    env-set type, config-beats-env, and an unknown `KETE_RUNTIME_TYPE` sending zero registrations
    (asserted after a fixed 200ms wait — this harness doesn't expose captured log output, so the
    error-log part of AC3 isn't asserted, only the "sends no registration" part); a small parity
    describe block round-trips every `KeteRuntimeRegistration.runtimeTypes` value through
    `Schema.decodeUnknownSync(Info)` and confirms an unknown one throws.
    `packages/cli/test/kete/login.test.ts` — four new `kete whoami` cases: prints `Runtime:` for a
    configured `kete_cloud`, prints nothing for `local`, falls back to `KETE_RUNTIME_TYPE`, and
    warns + names the source for an unknown value.
  - Generated: `bun run generate` in `packages/protocol` (openapi.json gained the `runtime` object
    under `kete`) then `packages/client` (`ConfigEntry.kete.runtime?: { type?: "local" | "kete_cloud"
    | "enterprise_private" }` in `src/promise/generated/types.ts`). Both committed to the working
    tree, not staged.
  - Docs: one line added to `packages/core/src/kete/skill/kete.md` (next to the platform URL
    sentence) naming `kete.runtime.type` / `KETE_RUNTIME_TYPE` and the three values.
  - `docs/upstream-patches.md`: no entry added — no upstream (non-`kete`-path) file was touched.
- No upstream file touched; `bun run --cwd packages/kete-tools upstream:check` passes.
- Checks run (all from the correct package directory, never repo root; using `node
  scripts/agent/check-summary.mjs bun run --cwd packages/<pkg> ...` for the `bun run` scripts and
  `bun test --cwd packages/<pkg> ...` for the plain `bun test` ones):
  - PASS `packages/core`: `bun run test ./test/kete/policy-sync.test.ts` (9 pass) — AC1
  - PASS `packages/core`: `bun run test ./test/kete/policy-sync.test.ts -t unknown` (1 pass) — AC3
  - PASS `packages/util`: `bun test ./test/kete/sync-policy.test.ts` (16 pass) — AC2/AC3
  - PASS `packages/cli`: `bun test ./test/kete/login.test.ts -t whoami` (9 pass) — AC4
  - PASS `packages/schema`, `packages/util`, `packages/core`, `packages/cli`: `bun run typecheck` — AC5
  - PASS `packages/core`: `bun run test ./test/kete` (130 pass); `packages/util`: `bun test
    ./test/kete` (55 pass); `packages/cli`: `bun test ./test/kete` (62 pass) — AC5
  - PASS root: `bun run lint` — AC5
  - PASS `bun run --cwd packages/kete-tools upstream:check` — AC5
  - `bun run generate` (protocol, then client) run; `bun run check:generated` in both shows the
    expected diff against the last commit (the new `runtime` field) because nothing is committed —
    this is the intended, idempotent output, not drift; re-running `generate` produced no further
    change. — AC5 generated
  - PASS `bun run --cwd packages/kete-tools verify --base main` (756.5s; finished after the rest of
    this entry was written, in the background) — Before PR
- Open questions carried over unchanged (platform acceptance of `kete_cloud`/`enterprise_private`,
  no `docs/platform/` mirror here) — nothing new found while building.
