# Spec: Runtime type from configuration (ADR 0005)

- Task: `docs/tasks/2026-09-28-runtime-type` · Size: large (config schema) · Created: 2026-09-28
- Status: approved (user, 2026-09-28)

## Goal
A runtime reports what it is — `local`, `kete_cloud` or `enterprise_private` — from configuration,
so the platform can tell a developer's laptop from a Kete-managed sandbox (ADR 0005) or an
enterprise runtime. Today `"local"` is hard-coded at the one registration call.

## Scope
- **Config** (config-kete): `kete.runtime.type`, one of the three values, default `local`, with
  `KETE_RUNTIME_TYPE` as the fallback when the config doesn't set it (the same precedence as
  `kete.platform.url` / `KETE_PLATFORM_URL`). Regenerate the protocol and client.
- **Registration** (runtime-registration, sync): the registration call in
  `packages/core/src/kete/sync/plugin.ts` sends the configured type instead of `"local"`.
- **Invalid values**: an unknown `KETE_RUNTIME_TYPE` is logged as an error and registration is
  skipped for that run (never guess a type, CLAUDE.md §10); an invalid config value is already
  rejected by schema validation.
- `kete whoami` shows the runtime type when it isn't `local` (cli).

## Out of scope
- Anything else behaving differently by runtime type (the scout found nothing that does today).
- The container image, `kete worker`, job tokens (later tasks).

## Acceptance criteria
- [x] AC1: With no setting, registration sends `local` (core Kete test).
- [x] AC2: `kete.runtime.type: "kete_cloud"` sends `kete_cloud`; `KETE_RUNTIME_TYPE=enterprise_private`
  sends `enterprise_private` when the config doesn't set it; the config wins over the variable (tests).
- [x] AC3: An unknown `KETE_RUNTIME_TYPE` logs an error and sends no registration (test).
- [x] AC4: `kete whoami` prints the runtime type when it isn't `local` (cli Kete test).
- [x] AC5: `openapi.json` and the client are regenerated; core, util, cli and schema typecheck; the
  Kete tests of core, util and cli pass; `bun run lint`; `upstream:check`.

## Risks and constraints
- Config schema change: protocol and client regeneration (commands.md "Generated code").
- The `kete` config section doesn't deep-merge (pitfalls.md): a project that sets `kete.runtime`
  must also carry its other `kete` settings. Document it next to the key.
- Upstream edits: none expected (schema/config/kete.ts, sync/plugin.ts and cli/src/kete are
  Kete-owned); upstream-guard reviews if any appear.
