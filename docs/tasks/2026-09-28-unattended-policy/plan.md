# Plan: Unattended runs fail closed (ADR 0008)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large: security change + upstream edits + a new session-metadata contract.** The user approves
> this plan (and the decisions below) before building.
> - **Upstream files edited (3, all minimal, every line `kete_change`-marked, upstream-guard reviews):**
>   1. `packages/core/src/plugin/internal.ts` — register the two new Kete plugins and add their IDs to
>      `guarded`. No seam: this list is the only way internal plugins load (every Kete plugin is
>      registered here the same way).
>   2. `packages/core/src/session/session.ts` — `setMetadata` (and `setPermissions`, if D2 = yes)
>      calls a Kete guard. No seam: metadata updates fire no hook, and session hooks can't fail
>      (`plugin/hooks.ts:23-30`: only `tool` `execute.before` may fail).
>   3. `packages/core/src/session/runner/llm.ts` — the four existing `kete_change` lines that wire
>      `KeteBudget` now wire `KeteRunChecks` (budget + unattended limits). No new lines. No seam: the
>      `session` `prompt` hook can't fail either, and the step boundary is where the budget check
>      already lives.
> - **Contract:** new session-metadata key `kete.unattended`, shape versioned (`version: 1`), strict
>   decode, fail closed on anything unknown. Recorded in `docs/context/contracts.md` after the build.
> - **No config schema change, no protocol/client regeneration** (metadata is opaque JSON,
>   `Session.Metadata` in `schema/src/session-metadata.ts`; `SessionError.type` is a plain string).
>   Only D1 option (b) would change the protocol.
> - **Coordinator's question (worktree subagents drop metadata):** they don't.
>   `KeteWorktrees.isolate` builds the child's metadata as `{ ...parent.metadata, kete.worktree }`
>   (`packages/core/src/kete/worktrees.ts:253`), so `kete.permissionMode` survives today. This task
>   still resolves `kete.unattended` from the root, as the spec requires (any child created with its
>   own metadata — e.g. a future caller, or a plain `Session.create` with `metadata` — can't shed it).
>   Nothing to fix for `kete.permissionMode`.

## Decisions for the user (defaults used in the steps below)

- **D1 — how a refused metadata update surfaces.** (a) *Default:* the guard fails as a defect
  (`KeteUnattended.LockedError`), logged with the reason; HTTP `PATCH /api/session/:id` returns a
  generic 500. No protocol change. (b) A typed `409 ConflictError`: adds edits to
  `protocol/src/groups/session.ts`, `server/src/handlers/session.ts`, the `Session.Interface` error
  types in `core/src/session.ts` and `core/src/session/session.ts`, plus protocol/client regeneration.
- **D2 — also refuse `session.update` `permissions` in an unattended family.** Setting session
  permission rules to `*: allow` makes every request `allow` before any hook runs — the same bypass
  class as AC4. *Default: yes* (one more guarded line in `setPermissions`; refused only in unattended
  families; interactive sessions unchanged).
- **D3 — saved "always" approvals in unattended runs.** Today they turn `ask` into `allow` before
  the hooks run (`permission.ts:175-177`). ADR 0008 says only the run's policy allows. *Default:
  ignore them* — the early hook recomputes the decision from the agent's and session's rules only
  (as `permission-ceiling.ts:62-75` does) and treats an `allow` that came only from a saved approval
  as `ask`. Alternative: count them (drop step 4c).
- **D4 — budget scope.** *Default: the whole run* — the sum of `cost` over the root and all its
  descendants, against the stricter of the run's `budget` and `kete.budget.session`, checked before
  every step in the family. Unattended runs never ask the `budget` permission (a `budget: allow` rule
  would otherwise remove the cap). Alternative: per session, as `kete.budget.session` is today.
- Not a decision, stated for approval: the run's clock starts at the **root session's
  `time.created`**; a fork is a new root and starts a new clock.

## Cards read
- docs/context/modules/permissions.md (verified-at bfd6c66, stale: no)
- docs/context/modules/budget.md (verified-at bfd6c66, stale: no)
- docs/context/modules/subagents.md (verified-at 715843563a, stale: no)
- docs/context/modules/worktrees-parallel.md (verified-at bfd6c66, stale: no)
- docs/context/modules/config-kete.md, server-sdk.md (staleness only: not stale)
- Also: INDEX.md, pitfalls.md, commands.md, contracts.md (headings), ADR 0008, spec.md, handoff.md

## Design

**Contract — `kete.unattended` (root session metadata), `packages/core/src/kete/unattended-policy.ts`:**
```
{ "version": 1,
  "allow":   [{ "action": "shell", "resource": "bun test*" }],   // optional; action/resource wildcards
  "budget":  5,                                                  // optional; USD, > 0
  "timeout": 30 }                                                // optional; minutes, > 0 (fractions allowed)
```
Decoded with an Effect Schema, excess properties rejected. Result is a discriminated union:
`{ kind: "interactive" }` (key absent on the root) | `{ kind: "unattended"; policy }` |
`{ kind: "unattended"; policy: empty; invalid: string }` for anything that fails to decode, an
unknown `version`, a missing ancestor, or a chain deeper than 32 — **fail closed**: no allows, and
no limits (so prompts are refused). Only the **root's** value counts; children's own copies are
ignored. Every new field bumps `version`.

**Permission hooks — two plugins, because hook order is plugin order:**
1. `KeteUnattended.PolicyPlugin` (`id: "kete.unattended.policy"`), in `pre` right after
   `KeteBudgetRule` and **before** `KetePermissionMode`: sees the base decision. In an unattended
   family: (D3) if the base is `allow` only because of a saved approval, treat it as `ask`; then an
   `ask` whose every resource matches a policy `allow` rule becomes `allow` — except actions
   `question` and `budget`, which a policy can never allow.
2. `KeteUnattended.Plugin` (`id: "kete.unattended"`), **last in `post`** (after
   `ConfigPolicyPlugin`), so it runs after permission mode, the ceiling, the sync-policy hook
   (`kete/sync/plugin.ts:279`) and `ConfigPolicyPlugin` (`config/plugin/policy.ts:44`): in an
   unattended family any remaining `ask` → `deny` with message `unattended run: not allowed by this
   run's policy`; action `question` → `deny` with `unattended run: no one to answer questions`. Never
   touches `deny`, never produces `allow`. So another hook's tightening (mode's `allow→ask`, the
   ceiling's `ask`, an org policy's `ask`) ends as `deny`, never as `allow`.
3. `KetePermissionCeiling`: ancestors in an unattended family get the policy's allow rules the way
   they already get saved approvals (`permission-ceiling.ts:60,74`; deny still checked first), so a
   subagent can use what the policy allows its root. Without this every policy-allowed `ask` would be
   denied in subagents.

**Required limits and the whole-run time limit:**
- `packages/core/src/kete/run-checks.ts` (new) replaces `KeteBudget` at the runner seam: for an
  interactive family it calls `KeteBudget` exactly as today (AC6); for an unattended family it calls
  `KeteUnattended.check` instead, which fails the step with `StepFailedError` and
  `SessionError.type: "unattended"` when:
  - no budget: run `budget` absent and `kete.budget.session` unset →
    `Unattended run refused: no spending budget. Set the run's budget or kete.budget.session.`
  - no time limit: run `timeout` absent and `kete.subagents.timeout` not explicitly set to > 0 (the
    60-minute default and `0` don't count) → `… no time limit. Set the run's timeout or kete.subagents.timeout.`
    (both missing → one message naming both)
  - past the deadline (`root.time.created + timeout`) → `Unattended run stopped: it reached its N-minute time limit.`
  - family cost ≥ effective budget (D4) → `Unattended run stopped: it reached its $X budget (spent $Y).`
  This runs before any model request of every step, so a refused prompt never reaches a model or
  a tool. Effective limits: `budget = min(run.budget, kete.budget.session)` over the defined ones;
  `timeout = run.timeout ?? explicit kete.subagents.timeout`.
- Mid-step stop: `KeteUnattended.Plugin` subscribes to `SessionEvent.Execution.Started`
  (published at `session/execution.ts:118`); for a session in an unattended family with a time limit
  it forks (in the plugin's scope, a `FiberMap` keyed by session ID — no module-level state) a sleep
  until the deadline, then `sessions.interrupt(sessionID)` and logs a structured warning
  (`session_id`, limit). Interrupted children are stopped by the existing cascade and by their own
  timers; the next step anywhere in the family is refused by the check above.

**Metadata lock (`session/session.ts` `setMetadata`):** `KeteUnattended.guardMetadata(current, next)`
refuses (D1) when the stored metadata has `kete.unattended` and `next` drops it or changes it
(JSON deep-equal), and when `next` adds it to a session that didn't have it (it can only be set at
creation). D2: `guardPermissions(current)` refuses `setPermissions` when the session's family is
unattended — this one needs the root, so it takes a `get` function; `session/session.ts` already has
`get`.

`unattended-policy.ts` holds the contract, decode, `resolve(get, sessionID)`, `allows()` and the
guards and imports **no** session/permission services (type imports only), so
`session/session.ts` can import it without a cycle (the same reason `worktree-lease.ts` exists).
`unattended.ts` holds the plugins and `check`.

**Post-review correction (reviewer finding, addressed during the build):** "Only the root's value
counts... a missing ancestor... fail closed: no allows and no limits" (above) was wrong in one way:
`session_v2.parent_id` has no FK and a restart can treat a missing parent as real, so an ordinary
**interactive** session can have a broken ancestor chain — the original rule made it unattended and
refused every prompt. Fixed two ways instead: (1) every session in the family now carries its own
copy of `kete.unattended` — `Session.create`'s `metadata` field (`packages/core/src/session.ts`, a
second upstream edit beyond the three above) calls a new `KeteUnattendedPolicy.inheritMetadata`,
which forces the parent's `kete.unattended` onto a child's metadata even when the caller supplies
its own (closing the same gap worktree subagents hit for the same reason plain inheritance doesn't
cover them); (2) `resolve` walks `parentID` upward defensively (for a session created before this
invariant existed) and returns `{ kind: "unattended"; policy; root: Info; invalid?: string }` —
unattended if the session itself or any *resolvable* ancestor carries the key, using the root-most
one found (`root` also anchors the run's clock, replacing the separate `root()` lookup `check`/`watch`
used before). A broken chain *before* any session is found is **interactive**, unchanged behavior;
a broken chain *after* one was found still fails closed, using that session's value.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/core/src/kete/unattended-policy.ts` | **new** | Contract (`metadataKey`, schema v1), `decode`, `resolve(get, sessionID)` (walk `parentID`, depth 32, fail closed), `allows(policy, action, resources)`, `guardMetadata`, `guardPermissions`, `LockedError` |
| `packages/core/src/kete/unattended.ts` | **new** | `PolicyPlugin` (early hook), `Plugin` (late hook + time-limit timer), `limits()`, `check()` (pure over a `Lookup`), `make` + `nodes` for the runner |
| `packages/core/src/kete/run-checks.ts` | **new** | `make`: interactive → `KeteBudget` as today; unattended → `KeteUnattended.check`; `nodes` = `KeteBudget.nodes` + `SessionStore.node` |
| `packages/core/src/kete/permission-ceiling.ts` | change | `Lookup` gains `policy(sessionID)` (the family's allow rules, `[]` when interactive); `ceiling()` appends them to `approved` (lines 55-77); plugin wires it via `KeteUnattended` resolve |
| `packages/core/src/plugin/internal.ts` | change (upstream, marked) | Import; `KeteUnattended.PolicyPlugin` after `KeteBudgetRule` (line ~276) and before `KetePermissionMode`; `KeteUnattended.Plugin` after `ConfigPolicyPlugin` (line ~311); both IDs in `guarded` (line ~316) so repository config can't remove them |
| `packages/core/src/session/session.ts` | change (upstream, marked) | Lines 76-89: `setMetadata` keeps the fetched session and calls `guardMetadata`; (D2) `setPermissions` calls `guardPermissions`; one import line |
| `packages/core/src/session/runner/llm.ts` | change (upstream, existing marked lines only) | Lines 33, 50, 229, 380: `KeteBudget` → `KeteRunChecks` |
| `packages/core/src/kete/budget.ts` | read | Checker shape, `StepFailedError`, `usd()` to reuse |
| `packages/core/src/kete/permission-mode.ts` | read | Plugin/hook pattern with `ctx.session.get` |
| `packages/core/src/kete/subagents.ts` | read (lines 36-50, 330-368) | `limits()` default handling; plugin subscribing to the bus with `forkScoped` |
| `packages/core/src/permission.ts` | read (lines 140-190) | `configured`, `savedRules`, `evaluateInput`, `evaluate` default effect |
| `packages/core/src/session/store.ts` | read (lines 20-60, 95-120) | `get`, `list({ parentID })` for the family cost walk |
| `packages/schema/src/session.ts` | read (lines 40-60) | `time.created` type (`DateTimeUtcFromMillis`) |
| `packages/schema/src/session-event.ts` | read (lines 240-262) | `Execution.Started` payload |
| `packages/core/test/kete/unattended.test.ts` | **new** | Pure tests: decode (valid, excess key, unknown version), resolve (root, child with `metadata: {}` — the worktree case, missing ancestor, depth), `allows`, early/late hook logic, `limits`, `check` messages, deadline, family cost |
| `packages/core/test/kete/unattended-service.test.ts` | **new** | Real `Permission` service (pattern: `test/kete/permission-mode-service.test.ts`) with the hooks registered in real order (policy, mode, ceiling, late): AC1 no `permission.asked`, deny message; AC2; AC3; AC6 interactive unchanged |
| `packages/core/test/kete/unattended-session.test.ts` | **new** | Real `Session.Service` (pattern: `test/session-create.test.ts:380-410`): AC4 drop/change/add refused and metadata unchanged; other keys still update; D2 permissions refused; interactive unchanged |
| `packages/core/test/kete/permission-ceiling.test.ts` | change | Existing `Lookup` fake (line ~103) gains `policy`; new case: a subagent in an unattended family gets the root's policy allow; an ancestor's deny still wins |
| `packages/core/test/kete/permission-mode-service.test.ts` | read | Service-level test pattern |
| `packages/core/test/session-create.test.ts` | read (lines 360-410) | Session service test pattern for `setMetadata` |
| `packages/core/test/kete/subagents.test.ts` | read (lines 170-180, 250-290) | `it.live` pattern for a timer that interrupts a session |
| `packages/core/src/kete/skill/kete.md` | change | Built-in skill: what an unattended run is, the policy shape, the required limits |
| `docs/upstream-patches.md` | change | New section "Unattended runs (feature/unattended-policy)" after "Subagent security": the three upstream files and a sync checklist |

## Steps
1. **`unattended-policy.ts`** — header comment (ADR 0008, root-only resolution, fail closed,
   contract rules). `metadataKey = "kete.unattended"`; `Policy` schema v1 (strict); `State` union as
   in Design; `resolve(get: (id) => Effect<Option<Info>>, sessionID)` walking `parentID` with
   `MAX_DEPTH = 32` (reuse the constant's meaning from `permission-ceiling.ts:39`); `allows(policy,
   action, resources)` = every resource evaluates `allow` against the policy rules (as `allow` rules)
   and `action` is not `question`/`budget`; `guardMetadata(current, next)` and
   `guardPermissions(get, sessionID)` returning `Effect<void>` that die with `LockedError` (D1a),
   message naming the key.
2. **`unattended.ts`** — `limits(policy, keteConfig)` → `{ budget?: number; timeout?: Duration;
   missing: ("budget" | "time limit")[] }`; `check(lookup, input)` (Lookup: `session`, `children`,
   `config`, `now`) implementing the four failures in Design; `make`/`nodes` resolving
   `SessionStore.Service` and `Config.Service`. Plugins: `PolicyPlugin` (step 4b-c), `Plugin` (late
   hook + `Execution.Started` timer, `FiberMap` in plugin scope, interrupt then log).
3. **`run-checks.ts`** — `make` resolves both checkers once; per call, resolve the family: interactive →
   `KeteBudget` checker unchanged; unattended → `KeteUnattended.check`.
4. **Hooks** — (a) late hook as in Design. (b) early hook: resolve family; interactive → return. (c)
   D3: if `event.effect === "allow"`, recompute `KetePermissionCeiling.decide(action, resources,
   Permission.merge(agent.permissions, session.permissions ?? []))` for the session's own agent
   (`event.agent ?? session.agent`, missing agent → deny rules); if that is `ask`, set
   `event.effect = "ask"`. (d) if `event.effect === "ask"` and `allows(...)` → `"allow"`.
5. **Ceiling** — `Lookup.policy`; `ceiling()` uses `[...approved, ...policy]`; deny-first order at
   `permission-ceiling.ts:73-74` unchanged.
6. **Upstream edits** (each line `// kete_change` with a short reason; no reformatting):
   `plugin/internal.ts` (import, two entries, `guarded`), `session/session.ts` (import, `setMetadata`,
   D2 `setPermissions`), `session/runner/llm.ts` (swap the four marked lines).
7. **Tests** — the four test files above. Bypass tests required by the spec: a child with its own
   `metadata: {}` is still unattended; a metadata update dropping, changing or adding the key is
   refused; a policy `allow` never beats a rule `deny`, the ceiling's deny, permission mode's `ask`
   (ends `deny`), or an org-policy `ask`; a policy `allow` for `question` or `budget` has no effect;
   an invalid policy denies every `ask` and refuses prompts; D2 permissions update refused.
   Time limit: `check` refuses past the deadline (pure, fixed `now`), and an `it.live` test with a
   policy `timeout` of ~0.01 minutes shows the timer interrupting a running unattended session.
8. **Docs** — `skill/kete.md` paragraph; `docs/upstream-patches.md` section listing the three files,
   what each marked line does, and the sync checklist: `Permission` still denies before `evaluate`;
   hook order (policy before mode; `KeteUnattended.Plugin` last in `post`); `setMetadata` still the
   only publisher of `MetadataUpdated`; session hooks still can't fail (else move the checks there).
9. Run the verification table; stop and report to the planner if an upstream edit beyond the three
   files seems necessary.

## Verification
All inside `packages/core/` unless noted (`node scripts/agent/check-summary.mjs bash -c "cd packages/core && …"` for agents).

| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun run test ./test/kete/unattended-service.test.ts -t "ask"` |
| AC2 | `bun run test ./test/kete/unattended-service.test.ts -t "allow"`; `bun run test ./test/kete/permission-ceiling.test.ts` |
| AC3 | `bun run test ./test/kete/unattended.test.ts -t "subagent"`; `bun run test ./test/kete/unattended-service.test.ts -t "subagent"` |
| AC4 | `bun run test ./test/kete/unattended-session.test.ts` |
| AC5 | `bun run test ./test/kete/unattended.test.ts -t "limit"`; `bun run test ./test/kete/budget.test.ts` |
| AC6 | `bun run test ./test/kete/permission-mode-service.test.ts ./test/kete/permission-mode.test.ts ./test/kete/permission-ceiling.test.ts ./test/kete/budget.test.ts`; `bun run test ./test/permission.test.ts ./test/session-create.test.ts ./test/session-runner.test.ts` |
| AC7 | `bun run typecheck` (core; schema untouched so its typecheck is a no-op check: `bun run typecheck` in `packages/schema`); `bun run test ./test/kete`; root `bun run lint`; root `bun run --cwd packages/kete-tools upstream:check`; root `bun run --cwd packages/kete-tools verify --base main`. Regeneration: not needed (no exposed schema change) unless D1 = (b), then `bun run generate` in `packages/protocol`, then in `packages/client` |

## Cards to update after the build
- `docs/context/modules/permissions.md` — third and fourth plugins, hook order across `pre`/`post`
  (including the sync-policy and `ConfigPolicyPlugin` evaluate hooks it doesn't list today), policy
  allow in the ceiling, D3.
- `docs/context/modules/budget.md` — `run-checks.ts` at the runner seam; unattended runs bypass the
  `budget` permission (D4).
- `docs/context/modules/subagents.md` — whole-run time limit for unattended families alongside the
  per-subagent timeout.
- `docs/context/modules/worktrees-parallel.md` — Data flow step 1: the child's metadata spreads the
  parent's (`worktrees.ts:253`).
- `docs/context/contracts.md` — `kete.unattended` v1 shape and rules (additive → version bump).
- `docs/context/decisions.md` — ADR 0008's rule.
- `docs/context/pitfalls.md` — "session hooks can't fail; refuse at the runner step or a marked
  guard"; "an evaluate hook that loosens must run before the tightening hooks".
