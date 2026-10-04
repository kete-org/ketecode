# Result: Unattended runs fail closed (ADR 0008)

## What changed
- `packages/core/src/kete/unattended-policy.ts` (new): the `kete.unattended` session-metadata contract (run policy: `allow` rules, budget, time limit), `resolve` (the session or any resolvable ancestor carrying the key; root-most wins; a chain broken before any flagged session is interactive), `inheritMetadata`, `guardMetadata`, `guardPermissions`.
- `packages/core/src/kete/unattended.ts` (new): `PolicyPlugin` (pre: the run's `allow` rules on the base decision, ignoring saved "always" approvals) and `Plugin` (post, last: any remaining `ask` → `deny`, "unattended run: not allowed by this run's policy"); `check` (refuses a prompt without a budget or time limit; whole-run budget) and `watch` (stops the run at its time limit, measured from the root session's creation).
- `packages/core/src/kete/run-checks.ts` (new): the runner checker, dispatching to `KeteBudget` (interactive) or `KeteUnattended.check` (unattended).
- `packages/core/src/kete/permission-ceiling.ts`: `Lookup.policy`, so subagents can use what the run's policy allows.
- Upstream, all `kete_change`-marked and recorded in `docs/upstream-patches.md`: `plugin/internal.ts` (registers both plugins, guarded), `session/session.ts` (`setMetadata`/`setPermissions` guards), `session.ts` (`create` forces the parent's `kete.unattended` onto a child), `session/runner/llm.ts` (the 4 existing marked lines now use `KeteRunChecks`).
- Tests: `test/kete/unattended.test.ts`, `unattended-service.test.ts`, `unattended-session.test.ts`, `permission-ceiling.test.ts` (+1).
- `packages/core/src/kete/skill/kete.md`: "Unattended runs".

## Checks
| Check | Result |
|---|---|
| core typecheck, root `bun turbo typecheck` | PASS |
| core `bun run test ./test/kete` | PASS (173) |
| AC-filtered tests (ask, allow, subagent, session, limit, budget, permission, session-create, session-runner) | PASS |
| root `bun run lint` | PASS |
| `upstream:check` | PASS |
| `kete-tools verify --base main` | PASS (764 s) |

Reviews: reviewer — changes needed (major: a missing ancestor made an interactive session unattended), fixed and re-reviewed → approve; upstream-guard — approve (twice).

## Acceptance criteria
- [x] AC1 — `unattended-service.test.ts -t ask`: `ask` denied, no `permission.asked`, reason reaches the model.
- [x] AC2 — `-t allow` and `permission-ceiling.test.ts`: policy allow, deny wins, ceiling and permission mode still tighten.
- [x] AC3 — `-t subagent`: plain and worktree subagents; a child created with explicit `{}` metadata.
- [x] AC4 — `unattended-session.test.ts`: removing/changing the key and (D2) permission changes refused.
- [x] AC5 — `-t limit` and `budget.test.ts`: refused without budget or time limit; runs with both; stopped at the time limit.
- [x] AC6 — the existing permission, permission-mode, session-create and session-runner suites pass; an interactive session with a missing parent behaves as before.
- [x] AC7 — the checks table (no schema exposed, so no regeneration).

## Known limitations
- If the root session's row is gone while descendants remain (no current code path does this), the time limit anchors on the oldest surviving member and the budget sums only its subtree; permissions are unaffected (`docs/upstream-patches.md`).
- Websearch provider prompts and MCP elicitation can still wait; only the time limit bounds them.
- An agent allowed to edit `.kete/` config could widen its rules during a run (for `kete job run`). *(Since fixed: `kete job run` denies edits to Kete config in unattended runs; see `docs/tasks/2026-09-28-job-run/result.md`.)*
- User plugins' `evaluate` hooks load after Kete's and could loosen a decision.

## Cards updated
New `unattended` card (and INDEX); permissions, budget, subagents, worktrees-parallel, roles-skills; decisions.md (ADR 0008); pitfalls.md (session hooks can't fail; loosening hooks before tightening ones; unattended waits). contracts.md unchanged: `kete.unattended` isn't a platform wire contract yet.

## Metrics
- Agents used: scout, planner, implementer (×2), reviewer (×2), upstream-guard (×2), librarian
- Scout lookups: 5, docs enough: 3 (60%); planner added 5 "no" gaps
- Tokens / cost (from /usage): ~1.6M subagent tokens
- Time: ~3 h
