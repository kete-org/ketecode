# Plan: Plan approval (parity B4)

Built directly by the main session (the maintainer authorised Milestone B end to end, 2026-11-04).

| File | Change |
| --- | --- |
| `packages/core/src/kete/plan-approval.ts` | new: `present_plan` tool, `context`/`compaction`/`generate` hooks |
| `packages/core/src/plugin/internal.ts` | register `KetePlanApproval.Plugin` (marked) |
| `packages/core/src/kete/permission-mode.ts` | `resolveFamily`/`resolveMode` take `Pick<Lookup, "session" \| "fallback">` |
| `packages/core/test/kete/plan-approval.test.ts` | AC1–AC5 and the review cases |
| `docs/permissions.md`, `docs/context/modules/permissions.md`, `docs/upstream-patches.md` | docs |

| Criterion | Command |
| --- | --- |
| AC1–AC5 | `bun run test ./test/kete/plan-approval.test.ts` in `packages/core` |
| AC6 | `bun run typecheck` and `bun run test ./test/kete` in `packages/core`; `bun run --cwd packages/kete-tools upstream:check` |
