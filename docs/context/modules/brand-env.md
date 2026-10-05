---
module: brand-env
paths: [packages/util/src/kete/brand.ts, packages/util/src/kete/env.ts, packages/util/src/kete/wordmark.ts, packages/cli/src/kete/env-bridge.ts]
verified-at: 604889ab32
---
## Quick answers
- Which local-model env vars exist? `KETE_OFFLINE`, `KETE_OLLAMA_HOST`, `KETE_LMSTUDIO_HOST`, `KETE_VLLM_HOST` are bridged like any `KETE_*` (internal `OPENCODE_OFFLINE`, `OPENCODE_OLLAMA_HOST`, ...); Ollama's own `OLLAMA_HOST` is read unbridged as the fallback (`core/src/kete/local-hosts.ts:27`). See the `local-models` card.
- What are `KETE_JOB_MODE`/`KETE_JOB_MAX_OUTPUT_TOKENS`/`KETE_JOB_TOOL_SOCKET`? The cloud-job
  runtime image's own env contract (not defined in this card's files —
  `packages/util/src/kete/job-mode.ts`), bridged the same way as every other `KETE_*` var
  (prefix-based, no fixed list needed here): internal names
  `OPENCODE_JOB_MODE`/`OPENCODE_JOB_MAX_OUTPUT_TOKENS`/`OPENCODE_JOB_TOOL_SOCKET`.
  `KETE_JOB_TOOL_SOCKET` (a path to the Go root helper's unix socket, added in
  `feature/job-root-helper`) needed no bridge code either — same prefix rule. See the `job-mode` and
  `root-helper` cards and `docs/context/contracts.md`.
- Where is the product name / binary name / config dirs defined? `packages/util/src/kete/brand.ts:10-31`.
- Where do public releases live, and what's the npm/Homebrew name? `brand.ts:68` `urls.releases` (kete-org/kete-releases) and `brand.ts:91-96` `distribution`; ADR 0009.
- How does a user's `KETE_*` env var reach upstream code that reads `OPENCODE_*`? `packages/util/src/kete/env.ts:34-51` `bridge()`, run once at `packages/cli/src/kete/env-bridge.ts:6`.
- Where's the logo SVG (mark + "Kete Code") used on asset-less pages (OAuth callback)? `packages/util/src/kete/wordmark.ts:28`; its bars must equal `packages/app/src/kete/mark.tsx`'s `MARK_RECTS` (`packages/core/test/kete/oauth-page.test.ts`).
- What does Kete Code send providers that credit the calling app? `brand.ts:81-88` `attribution`, consumed by `core/src/kete/attribution.ts` (see docs/upstream-patches.md "Branding cleanup and provider attribution").

## Purpose
Single source of truth for Kete Code's product identity (display name, binary name, directory names, config filenames, env-var prefix, URLs, provider-attribution strings), plus the `KETE_*` → `OPENCODE_*` environment bridge that lets ~60 unmodified upstream `process.env.OPENCODE_*` reads keep working while the user-facing surface stays `KETE_*` (CLAUDE.md §5).

## Entry points
- `packages/cli/src/kete/env-bridge.ts:6` — `KeteEnv.bridge(process.env)`, the CLI entry point's first import (side-effect module).
- `brand.ts:98` `export * as Brand` — imported as `@opencode/util/kete/brand` throughout the engine.
- `env.ts:61` `export * as KeteEnv`.
- `wordmark.ts:28` `wordmarkSvg` — imported by `core/src/oauth/page.ts` (kete_change block, per docs/upstream-patches.md).

## Key files
- `brand.ts:10-31` names, dirs, config filenames (`configFiles`), env prefix (`envPrefix = "KETE_"`, no OPENCODE_ fallback), `filePrefix`, `shortName`.
- `brand.ts:33-43` `updatesAvailable = true` / `updatesUnavailableMessage` — the verified updater (ADR 0009, `cli/src/kete/updater.ts`); the message is what a build without a pinned update key reports.
- `brand.ts:48-74` `urls` — mostly `undefined` TODOs pending a domain; callers must omit the link rather than guess. `urls.releases` = `https://github.com/kete-org/kete-releases` (public downloads, ADR 0009).
- `brand.ts:91-96` `distribution` — `npmPackage` (`@ketecode/cli`) and `homebrewFormula` (`kete-org/tap/kete`), for messages pointing at package managers.
- `brand.ts:81-88` `attribution` — `title`, `nvidiaOrigin`, `cerebrasIntegration` sent to model providers that credit the calling app.
- `env.ts:34-51` `bridge()` — idempotent env rewrite (see Data flow); `env.ts:57-59` `publicName()` maps an internal `OPENCODE_X` back to `KETE_X` for user-facing messages.
- `env.ts:31` `hasPrefix` compares case-insensitively (Windows env names).

## Data flow
CLI process starts → `env-bridge.ts` is the first import → `KeteEnv.bridge(process.env)` runs: in a top-level process (no `KETE_ENV_BRIDGED` marker) every inherited `OPENCODE_*` variable is deleted; every `KETE_X` is moved to `OPENCODE_X`; the marker `KETE_ENV_BRIDGED=1` is set (`env.ts:34-51`) → every other module, including unmodified upstream files, reads `process.env.OPENCODE_*` exactly as it would on upstream OpenCode → child processes the runtime starts (background service, askpass, agent PTY shells) inherit the bridged `OPENCODE_*` values plus the marker, so they don't strip them again; a `KETE_X` set explicitly for a child still overrides the inherited value.

## Data and APIs used
None — no network or platform calls. `brand.ts` is deliberately dependency-free (file header, lines 4-7) since it's imported from code that runs before the CLI finishes starting.

## Rules that must not break
- No `OPENCODE_` fallback for user-facing config; `KETE_*` is the only supported surface (`brand.ts:24-25`, CLAUDE.md §5).
- `bridge()` must run before any other module evaluates the environment — only the CLI entry point (`packages/cli/src/index.ts`) calls it; other hosts that embed `core`/`server` directly (e.g. `packages/desktop`) are not bridged (docs/upstream-patches.md "Rebrand", env bridge note).
- A value the runtime hands to a child process must use the `KETE_` name if the parent might not be bridged (e.g. the private-server lease password in `cli/src/services/standalone.ts`, per docs/upstream-patches.md).
- Every upstream file reading `Brand.*` carries a `kete_change` marker (CLAUDE.md §4); see the seam list in Gotchas below.
- `urls.*` stay `undefined` until Kete Code has a domain — callers must omit the field/link, never guess an address (`brand.ts:45-47`).

## Testing
- `packages/util/test/kete/env.test.ts` — `bun test ./test/kete/env.test.ts` inside `packages/util`.
- No dedicated `brand.test.ts` or `env-bridge` test; brand constants are exercised indirectly through the seam files' own tests and `packages/cli/test/env.test.ts`.

## Changes
- docs/upstream-patches.md "Rebrand" (feature/rebrand) — introduced `brand.ts`, `env.ts`, `env-bridge.ts` and ~15 upstream seam edits.
- docs/upstream-patches.md "Branding cleanup and provider attribution" (chore/branding-cleanup) — added `urls.website`, `attribution`, and `wordmark.ts`.
- `docs/tasks/2026-10-03-cli-distribution/` (ADR 0009) — `updatesAvailable = true`, a new `updatesUnavailableMessage` (no pinned key), `urls.releases`, `distribution`.

## Gotchas
- Seam files outside `kete/` paths carry `kete_change` markers reading `Brand`: `packages/util/src/global.ts:11,13` (XDG dir name), `packages/util/src/observability/logging.ts:5,61-64` (log filename prefix), `packages/util/src/observability.ts:9,28` and `packages/util/src/observability/otlp.ts:4,46,52` (OTEL client/service name), `packages/cli/src/database-path.ts:3,11-14` (db filename prefix), `packages/core/src/app.ts:4,19,26` (default app name / User-Agent prefix).
- New upstream `OPENCODE_X` variables automatically become `KETE_X` with no patch needed — the bridge is prefix-based, not a fixed list (docs/upstream-patches.md "Env bridge" note).
- The env rewrite is silent: a mistyped or stray `OPENCODE_*` variable a user set directly is deleted in a top-level process, not warned about.
- After each upstream sync, run `git grep -nE '"\.opencode"|opencode\.jsonc?' -- packages/*/src` and `git grep -n 'OpenCode' -- packages/{cli,core,server,tui,util}/src` to catch new unbridged literals (docs/upstream-patches.md "Merge notes").
