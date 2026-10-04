# Plan: Job mode: runtime request shape matches the gateway's job-key allowlist; item 11 audit

<!-- Autonomous mode: built directly from the spec by the coordinating agent (no separate planner run); this records what was done. -->

## Cards read
- docs/context/modules/job-mode.md, job-entrypoint.md (verified-at 508e1f85ba, stale: no); the
  item 11 audit also read job-image, root-helper, egress, audit-log, cli, config-kete,
  runtime-registration via a scout.

## Files
| File | Read / change | Why |
|---|---|---|
| platform `apps/gateway/src/jobs/{request-shape,output-limit}.ts`, `schemas/*.ts`, `docs/gateway.md` §2.8 | read | the checks to mirror |
| `packages/core/src/kete/job-request.ts` | change | six routes only, header/query allowlists |
| `packages/core/src/kete/job-request/{anthropic-messages,openai-chat,openai-responses,gemini}.ts` | change | pre-checks, thinking budget, Gemini nulls, strict schema |
| `packages/core/src/kete/job-request/shared.ts`, `schemas/*.ts` | new | shared helpers; zod copies of the gateway schemas |
| `packages/core/test/kete/job-request{,-service,-wire}.test.ts` | change/new | AC1–AC3 |
| `packages/kete-job-entrypoint/internal/{job/job.go,entry/entry_linux.go}` + tests, itest | change | heartbeat kete-cgroup check fails closed (AC5) |
| `docs/platform/jobs-v1.md` | new | AC4 |

## Steps
1. Copy the schemas; add `shared.ts`; extend each conformer in the gateway's order; route and transport checks.
2. Update tests to schema-valid bodies; add refusal cases; add the wire test with real provider packages.
3. Item 11 audit (scout) → table; fix the small gap (2f) in Go with unit + integration tests.
4. Copy the contract; cards; checks.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1–AC3 | `bun run test ./test/kete/job-request.test.ts ./test/kete/job-request-service.test.ts ./test/kete/job-request-wire.test.ts` in `packages/core` |
| AC5 | entrypoint unit + integration commands in `docs/context/commands.md` (Docker) |
| all | `bun run typecheck` + `bun run test ./test/kete` (core), `bun run lint`, `upstream:check`, `verify --base main` |
