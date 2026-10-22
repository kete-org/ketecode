# Spec: BytePlus models from platform sync

- Task: `docs/tasks/2026-10-20-byteplus-sync` · Size: large · Created: 2026-10-20
- Status: closed 2026-10-20 <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
When a platform admin makes BytePlus (ByteDance ModelArk) models the tier defaults, the `kete`
CLI syncs the agents on them and runs them through the Kete gateway. This is Phase B of the
platform task `kete-code-platform/docs/tasks/2026-10-20-byteplus-tiers`; Phase A is deployed
(platform `78d94e5`, ADR 0032).

## Platform contract (deployed)
- `GET /api/v1/sync` (and skill-file requests) accept a request header
  `x-kete-sync-providers: <comma-separated provider ids>`. Agents whose `model.provider` is
  outside the default five (anthropic, openai, gemini, deepseek, openrouter) are sent only when
  the client lists that provider. Accepted extra ids: `byteplus`, `nvidia`. No header → the
  response is exactly as before.
- The gateway serves BytePlus at `/compat/byteplus/v1` (OpenAI-compatible: `/chat/completions`,
  `/models` lists Kete's enabled BytePlus catalog rows; bearer = Kete key).
- `/api/v1/models` may list `provider: "byteplus"` rows with prices (already tolerated here).
- Source of truth: platform `docs/contracts/sync-v1.md`, `packages/shared/src/api/v1/sync.ts`.

## Scope (modules: sync, gateway, cli)
- **Sync contract** (`packages/util/src/kete/sync/contract.ts:36`): `ProviderId` gains `byteplus`
  (a strict enum today: one unknown value fails the whole decode, `client.ts:57-59`).
- **Sync client** (`packages/util/src/kete/sync/client.ts:32-40`): send
  `x-kete-sync-providers: byteplus` on sync and skill-file requests (one constant, same value on
  both).
- **Sync cache** (`packages/util/src/kete/sync/cache.ts:18`, `sync.ts`): bump the cache format
  version so a cached pre-upgrade response (without BytePlus agents) isn't kept alive by a `304`,
  as the `delegable` bump did.
- **Gateway route** (`packages/core/src/kete/gateway.ts:133`): add `byteplus` to the compat list
  (`/compat/byteplus/v1`, bearer, OpenAI list parser).
- **Catalog entry**: the models.dev snapshot has no `byteplus` provider, so discovered models get
  no SDK package and `model-resolver.ts:397-407` skips them. Add a `byteplus` provider entry
  using `@ai-sdk/openai-compatible` (pattern: the `nvidia` provider plugin / catalog override).
  *Built as:* an optional `Route.package` fallback on the byteplus compat route in `gateway.ts`
  (plan.md), which avoids an upstream edit.
- Docs: this repo's `docs/platform/` sync notes and `docs/context` cards for sync and gateway.

## Out of scope
- Declaring `nvidia` (possible later with one header value).
- Cloud jobs on BytePlus (platform `JOB_MODEL_PROVIDERS` and the job request-shape allowlist do
  not admit it; `job-request.ts:44` maps only openrouter).
- Any platform change.
- Model-specific tuning (reasoning parameters, prompts) for GLM, DeepSeek or Seed models.

## Acceptance criteria
- [ ] AC1: Sync client test: every sync and skill-file request carries
  `x-kete-sync-providers: byteplus`.
- [ ] AC2: A sync response containing an agent with `model.provider: "byteplus"` decodes, and the
  agent is installed as `kete/<model_id>`; a response with an unknown provider (e.g. `"foo"`)
  still fails as today.
- [ ] AC3: Cache: a cache entry written by the previous format version is not reused (no
  `If-None-Match` from it); a fresh sync is fetched.
- [ ] AC4: Gateway discovery test: `/compat/byteplus/v1/models` is listed, its models get
  `baseURL = <gateway>/compat/byteplus/v1` and an `@ai-sdk/openai-compatible` package, and the
  model resolver does not skip them; a 404 on that route yields no models (unchanged behaviour).
- [ ] AC5: Existing providers unchanged: the repo's full checks pass.

## Risks and constraints
- **Contract**: uses the platform's opt-in header; older CLIs are unaffected. Ship only after
  platform `78d94e5` is deployed (done).
- **Discovery dedupe**: models are de-duplicated by ID across routes, first route wins
  (`gateway.ts:276-279`); BytePlus IDs (`glm-5-2-260617`, …) don't collide today, but a shared ID
  with another route would hide one.
- **Untested upstream**: no BytePlus model is enabled in production yet; an end-to-end check
  needs one row enabled and priced (platform `byteplus-models.sql`).
- **Rollout**: tier defaults are set on the platform only after this CLI release is out;
  members on older CLIs lose BytePlus-tier agents until they upgrade.
