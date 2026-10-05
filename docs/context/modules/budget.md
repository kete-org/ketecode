---
module: budget
paths: [packages/core/src/kete/budget.ts, packages/core/src/kete/budget-rule.ts, packages/core/src/session/runner/llm.ts]
verified-at: 604889ab32
---
## Quick answers
- Does offline mode change the budget check? No; the runner now also passes the resolved `model` to the run checks (`session/runner/llm.ts:229`) for the offline model check (`unattended` card), which does not affect `KeteBudget`.
- What does this enforce? A per-session USD spending cap, `kete.budget.session`, checked before each model request step — for an **interactive** session. An unattended session (the `unattended` card) is checked by `KeteRunChecks`/`KeteUnattended.check` instead, at the same seam.
- What happens at the limit? The step asks the `budget` permission (normal allow/ask/deny rules and prompt); approving unlocks another limit-sized amount before the next prompt. An unattended run never asks `budget` — it has no one to ask — and is refused instead once its family cost reaches its effective budget.
- Why does `budget-rule.ts` exist separately from `budget.ts`? Built-in agents allow unmatched actions by default (`build` starts with `*: allow`), which would silently approve `budget`; `budget-rule.ts` injects an explicit `budget: ask` rule into every built-in agent so it doesn't.
- Where's the seam to refuse a whole prompt, not just ask a permission? The `session` `prompt` hook can't fail; the runner step itself (`session/runner/llm.ts:229`, before the model request is built) is the place — this is where both `KeteBudget` and, for an unattended family, `KeteUnattended.check` run.

## Purpose
Stops a session from exceeding an operator-configured USD budget by checking recorded session cost against the limit before every step's model request, using the standard permission system (allow/ask/deny + saved "always" rules) rather than a bespoke gate. As of the unattended-runs task, the runner seam is shared with `KeteUnattended.check` via `KeteRunChecks` (`kete/run-checks.ts`), which dispatches per session family: interactive → this module unchanged; unattended → required-budget/required-timeout/deadline/family-cost checks instead (`unattended` card).

## Entry points
- `packages/core/src/kete/budget.ts:33` `make` — an `Effect.gen` that resolves `Config.Service`/`Permission.Service` once and returns the per-step checker function.
- `packages/core/src/kete/budget-rule.ts:17` `Plugin` (`id: "kete.budget"`) — an `agent.transform` plugin, registered in `packages/core/src/plugin/internal.ts:276` after `AgentPlugin` and before the `post` config plugins (so explicit configured `budget` rules still win).
- Seam: `packages/core/src/session/runner/llm.ts:33,50,229,380` (all `// kete_change`) now wires `KeteRunChecks.make`/`nodes` (`kete/run-checks.ts`) instead of `KeteBudget.make`/`nodes` directly; `KeteRunChecks` calls this module's checker unchanged for an interactive family.

## Key files
- `budget.ts:36-73` the checker itself: compares `input.cost` against a per-session threshold map (`thresholds`, `budget.ts:30`, process-local — resets on restart), calls `permission.assert` with action `"budget"` and a human-readable resource string, and on approval advances the threshold by another `limit`.
- `budget.ts:56-71` decline handling: a plain decline surfaces as a defect wrapped by `Permission.DeclinedError`; caught and converted to a `StepFailedError` with `SessionError.type: "budget"` (`budget.ts:76-83`) instead of an empty failure — mirrors how upstream's `executeTool` handles declines.
- `budget.ts:86` `nodes` — `[Config.node, Permission.node]`, the location-node dependency list the runner adds (`llm.ts:380`).
- `budget.ts:89-91` `usd()` — cents formatting, four decimals under a cent (used in prompts and error messages).
- `budget-rule.ts:15` `action = "budget"` (re-exported from `budget.ts:28` as `KeteBudget.action`) — the single source of truth for the permission action name.
- `budget-rule.ts:20-27` iterates a snapshot of agent IDs (not the live list) and appends `{action: "budget", resource: "*", effect: "ask"}`, replacing (not pushing onto) the frozen `permissions` array.

## Data flow
`SessionRunnerLLM` layer construction calls `KeteRunChecks.make` once (`llm.ts:50`), which itself resolves both `KeteBudget.make` and `KeteUnattended.make` → in `runStep`, immediately before building the model request transcript, it calls `checks({sessionID, agent: loaded.agent.id, cost: loaded.session.cost})` (`llm.ts:229`) → `KeteRunChecks` resolves the session family (`unattended` card) and dispatches: **interactive** → this module's checker exactly as before — if `loaded.session.cost` has crossed the session's threshold, `Permission.Service.assert` runs the normal permission pipeline (rules → saved approvals → `evaluate` hook); approval bumps the threshold and the step proceeds, decline/deny raises `StepFailedError`; **unattended** → `KeteUnattended.check` instead (no `budget` permission asked; refuses on a missing budget/timeout, past deadline, or family cost past the effective budget).

## Data and APIs used
- Config: `kete.budget.session` (USD, optional; unset = no cap) via `Config.latest(entries, "kete")?.budget?.session` (`budget.ts:41`). Schema: `schema/src/config/kete.ts` (per upstream-patches).
- Permission system: `Permission.Service.assert` (`packages/core/src/permission.ts`) — the same allow/ask/deny engine and `save: ["*"]` "always" mechanism every other permission uses.

## Rules that must not break
- The check must stay inside the step loop, at the step boundary before the model request is prepared, so retries and compaction don't bypass it (docs/upstream-patches.md "Session budget"). This is also why `KeteUnattended.check` shares the exact same seam via `KeteRunChecks` rather than a separate one.
- `budget-rule.ts` must run after `AgentPlugin` and before the `post` config plugins so a user's explicit `budget` rule in configuration overrides the injected `ask` default (`plugin/internal.ts:276`).
- Only built-in agents get the injected rule; agents defined solely in configuration are created later and rely on a top-level `budget` rule instead (module comment, `budget-rule.ts:1-8`).
- If upstream adds another top-level config key list, `kete` must be added there too (upstream-patches note).

## Testing
- `bun run test ./test/kete/budget.test.ts` inside `packages/core/`.
- `bun run test ./test/kete/budget-agents.test.ts` inside `packages/core/` (covers the injected agent rule).

## Changes
- docs/upstream-patches.md "Session budget" — full file-by-file list, including the generated `protocol/openapi.json` and `client/src/promise/generated/types.ts` regeneration required whenever the `kete` config section changes (CLAUDE.md §8, `bun run generate`).
- docs/upstream-patches.md "Unattended runs (feature/unattended-policy)" — `kete/run-checks.ts` at this seam; see the `unattended` card.

## Gotchas
- Approved thresholds live only in the in-memory `thresholds` map (`budget.ts:30`) — a process restart forgets prior approvals and the session is asked again at the same limit.
- The checker is built once per `SessionRunnerLLM` layer instance (`llm.ts:50`), not per call — don't assume fresh `Config`/`Permission` resolution on every step.
- `stopped()` embeds any `Permission.CorrectedError` feedback text into the session-ending error message (`budget.ts:68,80`) — don't strip that plumbing when refactoring error handling.
- `kete.budget.session` still feeds an unattended family's *effective* budget (the stricter of it and the run's own policy `budget`, `unattended` card `limits()`) — don't assume it's dead code once a session is unattended.
