# Plan: BytePlus models from platform sync

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Size: Large (approved 2026-10-20).** Touches a shared contract mirror (sync v1 `ProviderId`, the
`x-kete-sync-providers` request header) and the sync cache format. **No upstream file is edited**:
every change is in Kete-owned paths (`packages/*/src/kete/`, `packages/*/test/kete/`, `docs/`), so no
`kete_change` markers and no `docs/upstream-patches.md` entry are needed. The catalog gap is closed
inside `gateway.ts` (a per-route fallback package) instead of a new provider plugin or a catalog
override, which would need an upstream edit (`plugin/provider.ts` registration or the models.dev plugin).

## Cards read
- docs/context/modules/sync.md (verified-at aad7b54a7e, stale: no)
- docs/context/modules/gateway.md (verified-at aad7b54a7e, stale: no)
- docs/context/modules/cli.md (stale: no; nothing in scope: `kete sync` wiring is unchanged)
- docs/context/INDEX.md, commands.md, contracts.md §4, pitfalls.md (upstream markers)

## Files
| File | Read / change | Why |
|---|---|---|
| packages/util/src/kete/sync/contract.ts | change | `ProviderId` (`:36`) gains `"byteplus"` |
| packages/util/src/kete/sync/client.ts | change | export one constant, e.g. `providersHeader = { "x-kete-sync-providers": "byteplus" }`; spread into the `/api/v1/sync` headers (`:34-38`) |
| packages/util/src/kete/sync/skills.ts | change | `fetchFiles` (`:177-182`): spread the same constant into the skill-file request headers |
| packages/util/src/kete/sync/cache.ts | change | `version: Schema.Literals([1, 2, 3, 4])` (`:18`) plus one comment line: 3 predates BytePlus agents |
| packages/util/src/kete/sync/sync.ts | change | resend the ETag only when `cached?.version === 4` (`:102`), write `version: 4` (`:120`); update the comment at `:99-101` |
| packages/util/test/kete/sync.test.ts | change | AC1 (sync header), AC2 (decode byteplus; `"foo"` still rejected), AC3 (v3 cache: no `If-None-Match`, fresh 200, rewritten at 4). Request capture pattern at `:46`, old-version cache fixture at `:258-264`; update any assertion expecting `version: 3` |
| packages/util/test/kete/sync-skills.test.ts | change | AC1: the skill-file request carries the header (fake at `:69`) |
| packages/core/src/kete/gateway.ts | change | `Route` type (`:55-60`) gains optional `package?: string`; add `"byteplus"` to the compat array (`:134`) with `package: "@ai-sdk/openai-compatible"` set only for byteplus (e.g. a second spread entry, or a conditional in the map); in `ctx.provider.transform` (`:219`) `model.package = base?.package ?? origin?.provider.package ?? item.route.package` |
| packages/core/test/kete/gateway.test.ts | change | AC4: fake serves `/compat/byteplus/v1/models`; a listed id gets `baseURL = <origin>/compat/byteplus/v1`, `package === "@ai-sdk/openai-compatible"`, and is not skipped by the resolver (`hasPackage`); a 404 on that route yields no byteplus models. 404 pattern at `:149`, `:526`, `:558`; header assertions at `:220-238` |
| packages/core/src/model-resolver.ts | read only | `hasPackage` (`:348`), default selection (`:402-407`) |
| packages/core/src/aisdk-native.ts | read only | `:67` maps `@ai-sdk/openai-compatible` to the native openai-compatible provider; no byteplus entry needed |
| packages/core/test/kete/agent-sync.test.ts | change | AC2: an agent with `model: { provider: "byteplus", model_id: "glm-5-2-260617" }` is applied as `{ providerID: "kete", id: "glm-5-2-260617" }` (fixture `:42`, assertion pattern `:205`). Mapping is `core/src/kete/sync/plugin.ts:503`, provider-agnostic: no code change |
| docs/platform/sync-v1.md | change | mirror: `byteplus` provider value and the `x-kete-sync-providers` request header (from platform `docs/contracts/sync-v1.md`) |
| docs/context/contracts.md | change | §4 route list adds `/compat/byteplus/v1`; sync section notes the request header |

## Steps
1. util contract: add `"byteplus"` to `ProviderId`. Tests first (AC2) in `util/test/kete/sync.test.ts`: a byteplus agent decodes and is cached; `"foo"` still yields `SyncError` `invalid_response`. Watch the byteplus case fail, then change.
2. util client + skills: add the header constant in `client.ts`, use it in `fetchAgents` and `skills.ts` `fetchFiles`. Tests first (AC1): header present on the sync request and on a skill-file request.
3. util cache: bump to version 4 (`cache.ts`, `sync.ts` `:102`, `:120`, comments). Test first (AC3): seed a version-3 cache with an ETag, sync, assert no `If-None-Match` was sent and the cache is now version 4 with the new ETag. Fix existing tests that expect 3.
4. core gateway: `Route.package?`, the byteplus compat entry with the fallback package, the third fallback in the transform. Tests first (AC4). Do not touch `job-request.ts`: cloud jobs are out of scope and `/compat/byteplus` stays an unrecognized (refused) route there.
5. core agent-sync: add the AC2 mapping case.
6. Docs: `docs/platform/sync-v1.md`, `docs/context/contracts.md` §4 and sync section.
7. Run the verification below, narrowest first.

## Verification
Wrap each in `node scripts/agent/check-summary.mjs bash -c "cd packages/<pkg> && <command>"`.

| Criterion | Command (narrowest first) |
|---|---|
| AC1 | util: `bun test ./test/kete/sync.test.ts -t "x-kete-sync-providers"`, then `bun test ./test/kete/sync-skills.test.ts` |
| AC2 | util: `bun test ./test/kete/sync.test.ts -t byteplus`; core: `bun run test ./test/kete/agent-sync.test.ts` |
| AC3 | util: `bun test ./test/kete/sync.test.ts`, then `bun test ./test/kete` |
| AC4 | core: `bun run test ./test/kete/gateway.test.ts` |
| AC5 | `bun run typecheck` in util, core, cli; `bun test ./test/kete` (util, cli); `bun run test ./test/kete` (core); root `bun run lint`; optionally root `bun turbo typecheck`. Core's full suite has 30 known machine-dependent failures (commands.md) |

## Risks
- BytePlus models have no catalog entry: only `package`, `baseURL`, name and platform price are set; no models.dev limits or capabilities. Note it if compaction or tool use misbehaves on GLM/Seed (tuning out of scope).
- Dedupe by model ID, first route wins (`gateway.ts:276-279`): byteplus is last, so a colliding ID would be served by an earlier route.
- Pricing: `platformRoute` matches `route.catalog === provider`, so `provider: "byteplus"` price rows map with no change.
- No production BytePlus model enabled yet; an end-to-end check needs platform `byteplus-models.sql`.

## Cards to update after the build
- docs/context/modules/sync.md: `ProviderId` includes `byteplus`; headers sent (`x-kete-sync-providers` on sync and skill files); cache version 4 (Quick answers, Key files, Rules).
- docs/context/modules/gateway.md: compat routes include `byteplus`; the `Route.package` fallback for providers missing from the catalog (Quick answer on SDK packages, Key files).
- docs/context/contracts.md §4: librarian re-verifies line refs after step 6.
