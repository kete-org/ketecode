# Result: Runtime type from configuration (ADR 0005)

## What changed
- `packages/schema/src/config/kete.ts`: `ConfigKete.Runtime` and `kete.runtime.type` (`local` | `kete_cloud` | `enterprise_private`).
- `packages/util/src/kete/runtime-registration.ts`: `runtimeTypes`, `resolveRuntimeType()` (config, then `KETE_RUNTIME_TYPE`, then `local`); `runtime_type` stored in the registration snapshot, so a changed type re-registers.
- `packages/core/src/kete/sync/plugin.ts`: registration sends the resolved type each run; an unknown value logs an error and skips registration.
- `packages/cli/src/kete/account-flow.ts`: `kete whoami` prints `Runtime:` when not `local`, and warns on an unknown value.
- `packages/core/src/kete/skill/kete.md`: documents the setting.
- Tests: `util/test/kete/sync-policy.test.ts`, `core/test/kete/policy-sync.test.ts`, `cli/test/kete/login.test.ts`.
- Generated: `packages/protocol/openapi.json`, `packages/client/src/promise/generated/types.ts`.
- No upstream file touched.

## Checks
| Check | Result |
|---|---|
| core `bun run test ./test/kete` | PASS (130) |
| util `bun test ./test/kete` | PASS (55) |
| cli `bun test ./test/kete` | PASS (62) |
| typecheck schema, util, core, cli | PASS |
| `bun run lint` | PASS |
| `upstream:check` | PASS |
| `kete-tools verify --base main` | PASS (756 s) |

Reviewer: approve (2 minor: AC boxes ticked here; AC3's "logs an error" half is untested because the harness can't read the log, only "no registration" is asserted).

## Acceptance criteria
- [x] AC1 — `policy-sync.test.ts`: no setting sends `local`.
- [x] AC2 — `sync-policy.test.ts` and `policy-sync.test.ts`: config, variable, and config-wins precedence.
- [x] AC3 — `policy-sync.test.ts -t unknown`: no registration sent (log not asserted, see above).
- [x] AC4 — `login.test.ts -t whoami`.
- [x] AC5 — the checks table; generated files regenerated.

## Cards updated
runtime-registration, sync, cli, account-login, config-kete, subagents, workflows, roles-skills, server-sdk, and contracts.md §3 (platform accepts all three types: `RuntimeType` in the platform's `packages/shared/src/api/v1/runtimes.ts`). The planner's 4 "Docs enough: no" gaps are folded into the runtime-registration, sync, cli and account-login cards.

## Metrics
- Agents used: scout, planner, implementer, reviewer, librarian (verify run by the implementer)
- Scout lookups: 3, docs enough: 3 (100%); planner added 4 "no" gaps
- Tokens / cost (from /usage): ~0.55M subagent tokens
- Time: ~1 h 30 min
