# Result: BytePlus models from platform sync

## What changed
- `packages/util/src/kete/sync/contract.ts` — `ProviderId` gains `byteplus` (comment pairs it with `providersHeader`).
- `packages/util/src/kete/sync/client.ts` — exported `providersHeader` (`x-kete-sync-providers: byteplus`), sent on `GET /api/v1/sync`.
- `packages/util/src/kete/sync/skills.ts` — the same header on skill-file requests.
- `packages/util/src/kete/sync/cache.ts`, `sync.ts` — cache format version 4; an ETag is resent only from a v4 cache.
- `packages/core/src/kete/gateway.ts` — `/compat/byteplus/v1` route; optional `Route.package` fallback (`@ai-sdk/openai-compatible` for byteplus, which models.dev lacks).
- Tests: `util/test/kete/sync.test.ts`, `sync-skills.test.ts`; `core/test/kete/gateway.test.ts`, `agent-sync.test.ts`.
- Docs: `docs/platform/sync-v1.md` (mirror), `docs/context/contracts.md`, spec.md "Built as" note.
- No upstream OpenCode file edited.

## Checks
| Check | Result |
|---|---|
| util `bun test ./test/kete` | PASS 441 / 0 |
| core `bun run test ./test/kete` | PASS 1634 / 0 |
| cli `bun test ./test/kete` | PASS 427 / 0 |
| `bun run typecheck` util, core, cli | PASS |
| root `bun run lint` | PASS |
| root `bun turbo typecheck` | PASS |
| `upstream:check` | PASS |
| core full suite | not run (30 known machine-dependent failures, commands.md) |

## Acceptance criteria
- [x] AC1 — evidence: `sync.test.ts` "x-kete-sync-providers: every sync request declares byteplus"; `sync-skills.test.ts` asserts `fileProviders` = `["byteplus"]`.
- [x] AC2 — evidence: `sync.test.ts` "byteplus: an agent on a byteplus model decodes…; an unknown provider is still rejected"; `agent-sync.test.ts` "an agent on a byteplus model runs on the gateway as kete/<model_id>".
- [x] AC3 — evidence: `sync.test.ts` "a version-%i cache is used but refetched without If-None-Match; the new copy is version 4" for 1, 2, 3.
- [x] AC4 — evidence: `gateway.test.ts` "byteplus: models listed on /compat/byteplus/v1 get its baseURL and the OpenAI-compatible package" (incl. `ModelResolver.hasPackage`) and "byteplus: a 404 on its route offers no byteplus models".
- [x] AC5 — evidence: Checks table (Kete suites, typecheck, lint); engine full suites not run.

Review: reviewer approved, no blockers or majors; minor (enum/header pairing) addressed with a comment.
Not verified end to end: no BytePlus model is enabled in production yet (needs platform `byteplus-models.sql`).

## Cards updated
- `modules/sync.md` — byteplus in `ProviderId`, `x-kete-sync-providers` header, cache v4; gap added: agent-sync fixture lines and `apply()` ignoring `model.provider` (`plugin.ts:503`).
- `modules/gateway.md` — byteplus compat route, `Route.package` fallback; gap added: package string for non-catalog compat providers (`@ai-sdk/openai-compatible`, `aisdk-native.ts:67`) and `Route` type location.
- `contracts.md` — line refs this build touched re-verified (others not).
- `card-check`: clean (40 cards).

## Metrics
- Agents used: planner, implementer, reviewer, verifier (no shell; checks run in the main session), librarian
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: n/a
