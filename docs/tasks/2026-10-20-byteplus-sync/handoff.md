# Handoff: BytePlus models from platform sync

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-20 planner
- Done: plan.md written; cards sync, gateway, cli current (stale-cards: all current).
- Decision: BytePlus catalog gap closed by an optional `Route.package` fallback in `core/src/kete/gateway.ts` (Kete-owned), not a provider plugin or catalog override (would need an upstream edit). No upstream files touched.
- Docs enough: no — missing: gateway card doesn't say which package string a non-catalog compat provider should use (`@ai-sdk/openai-compatible`, mapped natively at `core/src/aisdk-native.ts:67`) or that the `Route` type is at `gateway.ts:55-60`; opened gateway.ts and aisdk-native.ts.
- Docs enough: no — missing: sync card doesn't name the agent-sync test fixture lines (`core/test/kete/agent-sync.test.ts:42,205`) or that `apply()` ignores `model.provider` (`plugin.ts:503`).
- Open: none.

## 2026-10-20 implementer
- Done: steps 1-6 test-first (each new test seen failing first, except the agent-sync AC2 case, which only needed the step-1 contract change already in place). No upstream file edited.
- Files: util `sync/{contract,client,skills,cache,sync}.ts`; util tests `sync.test.ts`, `sync-skills.test.ts`; core `kete/gateway.ts`; core tests `kete/gateway.test.ts`, `kete/agent-sync.test.ts`; docs `platform/sync-v1.md`, `context/contracts.md` (§2 client headers, §4 routes; plan step 6 named it, although the implementer rules leave docs/context to the librarian; line refs there not re-verified).
- Decision: `providersHeader` exported from `client.ts`, reused by `skills.ts` via `KeteSyncClient.providersHeader`.
- Decision: AC4 asserts `package` toContain("openai-compatible"): the model service rewrites `@ai-sdk/openai-compatible` to `@opencode/ai/providers/openai-compatible` (aisdk-native.ts:67), as existing tests do for anthropic/openai.
- Decision: `sync-v1.md` mirror gained only the header bullet, the `SyncProviderId`/`SYNC_PROVIDERS_HEADER`/`SyncModelProviderId` block and the model provider; it still lacks the platform's integrations/share wording (pre-existing drift, not touched).
- Left: version-3 cache fixtures in `core/test/kete/share.test.ts:55` and `cli/test/kete/job-socket.subprocess.test.ts:79` still decode; unchanged.
- Checks: AC1-AC4 narrow tests PASS; typecheck util/core/cli PASS; util kete 441/0, cli kete 427/0, core kete 1634/0; root lint PASS. Root `bun turbo typecheck` and core full suite not run.
- Open: none.
