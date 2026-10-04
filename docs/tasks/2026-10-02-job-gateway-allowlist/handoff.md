# Handoff: Job mode: runtime request shape matches the gateway's job-key allowlist; item 11 audit

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-02 coordinator agent (autonomous mode)

Done:
- Part B: job mode now refuses locally every request the gateway refuses for a job key (six routes,
  `anthropic-beta`/`openai-beta`/query allowlists, provider-tool history, hosted `tool_choice`,
  `background`, candidates, strict schemas copied as zod) and never sends `null` Gemini part fields.
  Thinking/reasoning budgets are lowered below the clamped output instead of refused.
- Part A: item 11 audit table in result.md. The one small gap (heartbeat kete-cgroup check could be
  silently omitted, unreadable exe skipped) is fixed with unit and integration tests.
- `docs/platform/jobs-v1.md` copied (platform `a2e3fbf`).

Decisions (none change security posture, money or a public contract; all stricter or equal):
- Budget lowering is a conformance like the existing output clamp; refusing would make the "max"
  thinking variant fail every job.
- `?beta=true` stays allowed on the Anthropic route (the gateway ignores it; refusing would break
  every Anthropic job).
- zod for the schema copies (diffable with the platform), not Effect Schema.

Open, for the coordinator / platform:
- OpenAI Chat replayed reasoning lowers to `reasoning_content`, which the gateway's Chat schema
  refuses; now a local failure. Platform may choose to admit it (only matters for non-native
  reasoning on the OpenAI Chat route).
- A `kete/deepseek-*` job model fails on the first request; the platform could refuse such a
  `spec.model` at job creation.
- The runtime relies on `KETE_JOB_MAX_OUTPUT_TOKENS` ≤ the gateway's `JOB_MAX_OUTPUT_TOKENS`.
- GHCR package visibility "public" is still a manual step (item 1).
- When the platform changes `apps/gateway/src/jobs/schemas/*`, re-copy (contracts.md §6e).
- `verify --base main` could not finish: the disk is full (~176 MB free; Docker holds ~7 GB of reclaimable images and ~5.7 GB of volumes, not removed because they aren't this task's to delete). Rerun it after freeing space.

## 2026-10-02 coordinator agent — CI fix (PR #67)

- `packages/cli/test/kete/job-socket.subprocess.test.ts` (Linux-only) used a `kete/test-chat` model on
  the deepseek compat route, which job mode now refuses like the gateway does. The fixture now uses the
  OpenRouter compat route (`/compat/openrouter/v1`, an allowed job route) with the same
  OpenAI-compatible model; the route allowlist is unchanged.
- Linux checks in `oven/bun:1.4.2` (arm64): `job-socket.subprocess.test.ts` 6/6 pass; core job-request
  tests 51/51 pass. Image rebuilt with this branch's `kete` (linux-arm64); `e2e.sh --scenario
  lifecycle` passes (seven Anthropic `messages` requests through the fake gateway, incl. `?beta=true`
  and the interleaved-thinking beta; export token scan clean). Built images removed afterwards.
