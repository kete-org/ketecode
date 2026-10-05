---
module: unattended
paths: [packages/core/src/kete/unattended-policy.ts, packages/core/src/kete/unattended.ts, packages/core/src/kete/run-checks.ts, packages/schema/src/kete/unattended.ts]
verified-at: 604889ab32
---

## Quick answers
- What does the run check do offline? `KeteRunChecks` takes an optional `model` input (`core/src/kete/run-checks.ts`) and, when offline mode is on, fails the step with `SessionError` type `offline` unless the model is local (`:50`, `KeteOffline.isLocalModel`); the runner passes it at `session/runner/llm.ts:229`. Cached policy is unaffected.
- Does job mode (`KETE_JOB_MODE`) change unattended enforcement? Yes — job mode *implies*
  unattended: `run-checks.ts:42-49` checks `KeteJobMode.enabled()` for an otherwise-`interactive`
  family and refuses the step with `StepFailedError({type: "unattended", message:
  KeteUnattendedSchema.jobMode()})` before `KeteBudget` ever runs — there's no one to ask a `budget`
  permission of in a job. `jobMode()` (`packages/schema/src/kete/unattended.ts`) is a new message
  builder sharing `refused()`'s `"Unattended run refused: "` prefix so `classify()` still reports it
  as `"refused"` without any change to `classify` itself. `kete job run` already sets
  `kete.unattended`, so a job started the normal way is unaffected; only a job-mode session created
  without that metadata hits this path. Full contract: the `job-mode` card, `docs/jobs.md` "Job mode".
- Is a Kete-config edit ever allowed in an unattended run, even with a matching policy/agent
  allow? No (D2, `kete job run` task, 2026-09-28) — `unattended.ts` `applyLate` calls
  `KeteUnattendedPolicy.configTarget(event.action, event.resources, {globalConfig})` **before** its
  "ask → deny" check and denies unconditionally (overriding an `allow` too, the one case this
  plugin ever tightens an `allow`) for an `edit`/`shell` resource under a `.kete/` path segment, a
  `kete.json`/`kete.jsonc` filename anywhere in the project, or inside the global config directory;
  `shell` matching is a best-effort text check on the command (`unattended-policy.ts:108-141`
  `configTarget`, `hasProjectConfigSegment`, `insideGlobalConfig`). Known gaps, not fixed: a
  symlink pointing into `.kete/` (resources are lexical) and an obfuscated shell command
  (`docs/jobs.md` "Known gaps").
- Where do the wire shapes and stop-message text live now? `@opencode/schema/kete/unattended`
  (`packages/schema/src/kete/unattended.ts`) — `AllowRule`/`Policy` (moved verbatim, same
  identifiers), the message builders `refused`/`timeLimit`/`budget`/`auditUnavailable`, and
  `classify(message)` (the inverse: message text → `"refused"|"audit"|"time_limit"|"budget"`).
  `unattended-policy.ts` re-exports `AllowRule`/`Policy` from there so every existing
  `KeteUnattendedPolicy.Policy` caller compiles unchanged; `unattended.ts`'s `refused`/
  `stoppedDeadline`/`stoppedBudget` and `audit.ts`'s audit-unavailable message all build their text
  through these shared builders (unchanged wording) — this is why the CLI (`cli/src/kete/job-spec.ts`,
  which can't import core) can validate a job's `policy` field with the exact schema the runtime
  decodes `kete.unattended` metadata with, and why `kete job run` can classify a stop message it
  reads from the audit log or an execution event without re-implementing the text matching.
- How does a stop reason (time limit, budget, refused) reach a client that isn't reading the audit
  log? Only as `session.execution.failed`'s `error.type: "unattended"` plus the message text
  (`unattended.ts:92-121`, `audit.ts:295-299`) — there's no separate typed field for *which* limit
  was hit; a client has to run the message through `KeteUnattendedSchema.classify` (or match the
  same substrings) to recover it, exactly what `kete job run` does with no local audit file. A
  plain interrupt (SIGINT, shutdown, a watchdog) instead comes through as
  `session.execution.interrupted`, whose own `reason` field is `"user" | "shutdown" | "superseded"
  | "inactivity"` (`schema/src/session-event.ts:256-260`) — never one of the unattended stop
  reasons, so a client can't confuse the two event shapes.
- Who sets `kete.unattended` today? `kete job run` (`cli/src/kete/job-run.ts`, `session.create`'s
  `metadata: {"kete.unattended": policy}`) is the first real caller — this module only added the
  enforcement; see the `cli` card.
- What makes a session family "unattended"? Session metadata key `kete.unattended`, set only when
  a session is created (`unattended-policy.ts:33` `metadataKey`), carrying the run's policy. Every
  session in the family carries its **own copy** — a plain child inherits it via upstream's own
  `metadata: input.metadata ?? parent?.metadata`; `resolve` also walks `parentID` upward
  defensively for a session created before this invariant existed.
- Can it be removed, changed, or added after creation? No — `Session.setMetadata`
  (`packages/core/src/session/session.ts:76-82`) calls `KeteUnattendedPolicy.guardMetadata`, which
  dies with `LockedError` on any drop/change, or an add to a session that didn't have it at
  creation. `setPermissions` is refused too (D2) via `guardPermissions`.
- What happens to an `ask`? `KeteUnattended.PolicyPlugin` (early `evaluate` hook) turns an `ask`
  the run's policy allows into `allow` (never for `question`/`budget`); `KeteUnattended.Plugin`
  (late `evaluate` hook, last registered) first denies any Kete-config target outright (D2, above,
  overriding even an `allow`), then turns any `ask` still standing into `deny`. Neither hook ever
  produces `allow` from a `deny`, or overrides another hook's `deny` for anything other than the
  D2 config-target case.
- What's required to start a prompt? A budget and a time limit, from the policy or from
  `kete.budget.session`/an explicitly-set `kete.subagents.timeout` (the 60-minute default and `0`
  don't count) — missing either refuses the step with a named reason (`unattended.ts` `refused`).
- What stops a run at its limits? `KeteRunChecks`/`KeteUnattended.check` refuses the *next* step
  once the family's summed cost or the deadline (`root.time.created + timeout`) is reached;
  `KeteUnattended.Plugin`'s `watch` additionally interrupts a session **mid-step**, on a timer
  started by `SessionEvent.Execution.Started` (`session/execution.ts:118`).
- Does this module write the audit log itself? No — `unattended.ts:217` `Plugin` installs
  `kete/audit.ts`'s read-only hooks (`KeteAudit.install`) right after registering its own late
  `evaluate` hook, and `run-checks.ts` calls `KeteAudit`'s `begin` (via `KeteAudit.make`) before
  `KeteUnattended.check` on every step of an unattended family, refusing the step if the log can't
  be written. The audit log itself — line format, redaction, storage, cap — is the `audit-log` card.
- Is a subagent of an unattended session unattended too, including a worktree subagent? Yes — a
  worktree subagent's own metadata already spreads the parent's (`kete/worktrees.ts:253`), and
  `inheritMetadata` (`unattended-policy.ts:119-128`) forces `kete.unattended` onto any future
  caller that doesn't.
- What if a session's ancestor chain is broken (a missing parent row)? Interactive, unchanged,
  **if no session in the chain up to that point carried the key** — `session_v2.parent_id` has no
  FK and a restart can make a missing parent look real, so a broken chain must not sweep an
  ordinary interactive session into "unattended, refuse everything". A broken chain **after** a
  session with the key was found still fails closed, using that session's policy.

## Purpose
ADR 0008: a session family marked unattended is enforced by the runtime, not a client — every
permission that would ask a person is denied unless the run's own policy allowed it in advance,
and the run can't start (or continue) without a spending budget and a time limit. This is the
enforcement layer `kete job run` (a future task) and cloud jobs (ADR 0005) will set the metadata
for; this task only adds the enforcement, not a way to start a job.

## Entry points
- `unattended-policy.ts` — the contract, decode, `resolve`, `allows`, `inheritMetadata`, the two
  guards. No session/permission service imports (type imports only), so `session/session.ts` and
  `session.ts` can import it without a cycle — the same reason `kete/worktree-lease.ts` is kept
  apart from `kete/worktrees.ts`.
- `unattended.ts:203` `PolicyPlugin` (`id: "kete.unattended.policy"`) — registered in
  `packages/core/src/plugin/internal.ts`'s `pre` list right after `KeteBudgetRule` and before
  `KetePermissionMode` (`:277`).
- `unattended.ts:217` `Plugin` (`id: "kete.unattended"`) — registered last in `plugin/internal.ts`'s
  `post` list, after `ConfigPolicyPlugin` (`:315`). Both plugin IDs are in `guarded`
  (`plugin/internal.ts:321-329`, a `// kete_change start/end` block since 895f9e239b) so repository
  config can't remove either. `Plugin`'s effect also calls `KeteAudit.install(ctx, ...)` at the very
  end, after `ctx.permission.hook("evaluate", applyLate)` — the audit log's hooks ride on this
  plugin's id and guarded status; no separate plugin, no new `plugin/internal.ts` edit (D1 option B,
  `audit-log` card, `docs/upstream-patches.md` "Unattended runs").
- `run-checks.ts:21` `KeteRunChecks.make` — the runner seam (`session/runner/llm.ts:33,50,229,380`,
  `// kete_change`), replacing a direct `KeteBudget.make`/`nodes` wire. `nodes` (`run-checks.ts:42`)
  also carries `KeteAudit.nodes` and `Config.node` now (the audit `begin` call needs both).
- Upstream edits carrying `kete_change` markers for this task (`docs/upstream-patches.md`
  "Unattended runs"): `plugin/internal.ts` (plugin registration + `guarded`), `session/session.ts`
  (`setMetadata`/`setPermissions` guards), `session/runner/llm.ts` (the four existing
  `KeteBudget`→`KeteRunChecks` lines), `session.ts` (`create`'s `metadata:` field calls
  `inheritMetadata`).

## Key files
- `unattended-policy.ts:46-55` `Policy` schema (`version: 1`, strict decode, excess properties
  rejected) and `emptyPolicy` — the fail-closed value (no allows, no limits) used whenever decoding
  fails or the version is unknown.
- `unattended-policy.ts:82-96` `resolve(get, sessionID)` — walks `parentID` up to `MAX_DEPTH = 32`
  (`:36`, mirrors `permission-ceiling.ts`'s own constant); returns `{kind:"interactive"}` if no
  session found carries the key, else `{kind:"unattended", policy, root, invalid?}` using the
  root-most session found.
- `unattended-policy.ts:103-110` `allows(policy, action, resources)` — every resource must match an
  `allow` rule for `action`; always `false` for `question`/`budget`.
- `unattended-policy.ts:119-128` `inheritMetadata(parentMetadata, providedMetadata)` — forces the
  parent's `kete.unattended` onto a child's metadata even when the caller supplies its own; wired
  into `session.ts` `create`.
- `unattended-policy.ts:141-160` `guardMetadata`/`guardPermissions` — die with `LockedError` (D1,
  an internal-error/500 surface, not a typed protocol error) on a refused update.
- `unattended.ts:49-61` `limits(policy, kete)` — effective `budget` (stricter of policy and
  `kete.budget.session`), effective `timeout` (policy, else an explicitly-set
  `kete.subagents.timeout` — `0`/unset don't count), and which of the two is `missing`.
- `unattended.ts:72-86` `familyCost(lookup, root)` — sums `cost` over the root and every descendant
  (BFS via `lookup.children`, same `MAX_DEPTH`), for the whole-run budget (D4).
- `unattended.ts:121-136` `check(lookup, input)` — the four refusal/stop conditions: no budget, no
  time limit, past the deadline, family cost ≥ effective budget; no-op for an interactive family
  (defensive — the runner only calls it once `resolve` already found unattended).
- `unattended.ts` `stopReason(lookup, sessionID)` — pure, shares `check`'s three comparisons
  (missing limit, deadline, family cost) so the audit log's `run ended` reason
  (`kete/audit.ts` `onEvent`) always agrees with why the runner actually stopped the run; returns
  `"time_limit" | "budget" | "refused" | undefined`. `undefined` under both limits, meaning the
  audit hook falls back to `audit_failed`/`interrupted`/`error` from its own state.
- `unattended.ts:169-186` `applyPolicy` — the early hook's pure body: D3 (an `allow` that came only
  from a saved approval is recomputed via `KetePermissionCeiling.decide` over the session's own
  agent+session rules and treated as `ask` if that recomputation isn't `allow`), then policy-allow.
- `unattended.ts:206-224` `applyLate(get, event, {globalConfig})` — the late hook's pure body,
  three-argument since D2: first, `KeteUnattendedPolicy.configTarget` → unconditional `deny` (even
  overriding `allow`); else any `ask` → `deny`, with a `question`-specific message. `Plugin` wires
  `{globalConfig: global.config}` (`Global.Service`, already in the plugin's requirements).
- `unattended-policy.ts:108-141` `configTarget`/`hasProjectConfigSegment`/`insideGlobalConfig` — D2,
  pure and string/path-only (case-insensitive, `\` and `/` both accepted for Windows); only
  `edit`/`shell` actions are checked.
- `unattended.ts:257-283` `watch` — per-`Execution.Started` event, forks a sleep-then-interrupt
  timer in a `FiberMap` keyed by session ID (plugin scope, no module-level state); logs a
  structured warning on firing.
- `run-checks.ts:21-38` `make` — resolves `KeteBudget.make`, `KeteUnattended.make` and
  `KeteAudit.make` once; per call, resolves the family via `KeteUnattendedPolicy.resolve` and
  dispatches: interactive → `KeteBudget`; unattended → `KeteAudit.begin` (`run started` line, or a
  fail-closed refusal) then `KeteUnattended.check`.
- `permission-ceiling.ts:49` `Lookup.policy(sessionID)` (owned by the `permissions` card, wired
  from here) — the family's policy allow rules (`budget`/`question` filtered out), appended into
  the ceiling's `approved` list so a subagent's ancestors get what the policy allows the root.

## Data flow
1. **Creation:** a root session gets `kete.unattended` in its metadata (today: only test/manual
   paths — `kete job run` will be the real caller). A child inherits it either by omission
   (`metadata: input.metadata ?? parent?.metadata`, upstream) or, if it supplies its own metadata,
   via `inheritMetadata` forcing the parent's value onto it (`session.ts` `create`).
2. **Permission evaluation:** `Permission.Service.assert` computes a base effect → `evaluate` hooks
   run in plugin order (`permissions` card has the full chain) → `PolicyPlugin` (first) may loosen
   an unattended family's `ask` to `allow` → mode/ceiling/sync-policy/`ConfigPolicyPlugin` may
   tighten → `Plugin` (last) denies any `ask` still standing in an unattended family.
3. **Per step, before the model request:** `session/runner/llm.ts:229` calls `KeteRunChecks`, which
   resolves the family and either runs `KeteBudget` (interactive) or, for an unattended family,
   first calls `KeteAudit.begin` (writes the root's `run started` audit line exactly once, or
   refuses the step with `StepFailedError({type: "unattended"})` if the log can't be written) and
   then `KeteUnattended.check`: refuses with a named reason if the run has no budget/time limit, has
   passed its deadline, or has spent its budget.
4. **Mid-step:** `KeteUnattended.Plugin` subscribes to `SessionEvent.Execution.Started`; for an
   unattended session with a time limit it schedules an interrupt at the deadline independent of
   the step-boundary check, so a single long-running step is still stopped on time.
5. **Metadata/permissions updates:** `session/session.ts`'s `setMetadata`/`setPermissions` call the
   guards directly (session hooks can't fail — `pitfalls.md` "Permissions and sessions") before
   publishing their events; a refused update dies as `LockedError`, surfacing as a generic 500 over
   HTTP (D1 default).

## Data and APIs used
- Session metadata: `kete.unattended` (`unattended-policy.ts:33`), read via `Session.Service.get`
  (through the `Get` type, an `Effect.option`-wrapped lookup) by every plugin/checker here.
- Config: `kete.budget.session` and `kete.subagents.timeout` (`ConfigKete.Info`, same keys the
  `budget`/`subagents` cards already document) as the fallback limits when the policy doesn't set
  its own.
- Services: `Session.Service`, `Agent.Service` (D3 recomputation), `Config.Service`, `Bus.Service`
  (`SessionEvent.Execution.Started`), `SessionStore.Service` (`get`/`list({parentID})` for
  `run-checks.ts`/family-cost walks).
- `KetePermissionCeiling.decide` — reused (not re-implemented) for D3's recomputation and for
  filtering the policy's allow rules before they're appended to the ceiling's `Lookup`.
- `KeteBudget.usd`/`StepFailedError`/`SessionError.type` — reused for the unattended checker's own
  error shape (`type: "unattended"`, distinct from `type: "budget"`).

## Rules that must not break
- `KeteUnattended.PolicyPlugin` must stay the first `pre` hook touching `evaluate` and
  `KeteUnattended.Plugin` must stay last in `post` — an evaluate hook that loosens must run before
  every hook that could tighten, or a widened `allow` could reach the caller, or a later
  tightening could be skipped (`pitfalls.md` "Permissions and sessions"; `plugin/internal.ts:277,315`).
- The policy can only narrow: `allows()` never returns `true` for `question`/`budget`
  (`unattended-policy.ts:39,104`); the late hook only ever tightens — `ask`→`deny`, and, since D2
  (config-edit deny, `kete job run` task), a Kete-config target's `allow`→`deny` too — never the
  reverse (`unattended.ts:206-224`).
- `kete.unattended` can only be set at session creation, never after — `guardMetadata` must run
  before `setMetadata` publishes (`session/session.ts:76-82`), and every family member must carry
  its own copy (`inheritMetadata`) so `resolve`'s ancestor walk is a defensive fallback, not the
  primary mechanism.
- A broken ancestor chain **before** any session carrying the key is found must resolve
  **interactive**, not unattended — the opposite (the original design, fixed in review) would fail
  closed on ordinary sessions with incomplete ancestry (`docs/upstream-patches.md` "Unattended
  runs", "Known limitation").
- `check`/`watch` must be no-ops for an interactive family (defensive double-check even though the
  runner/timer only invoke them once `resolve` already found unattended).
- An unattended run must never ask the `budget` permission — `KeteUnattended.check` replaces
  `KeteBudget`'s ask-based flow entirely rather than composing with it, because a `budget: allow`
  rule would otherwise remove the cap ADR 0008 requires.

## Testing
- `bun run test ./test/kete/unattended.test.ts` inside `packages/core/` — pure: decode, `resolve`,
  `allows`, the guards, `limits`, `check`, `watch`, and (D2) `configTarget` (relative `.kete/x`,
  `a/.KETE/x`, `../.kete/x`, `kete.jsonc`, `sub/kete.json`, absolute-in-global-config, Windows
  backslashes, `src/app.ts` untouched, a `shell` command text, non-edit/shell actions).
- `bun run test ./test/kete/unattended-service.test.ts` inside `packages/core/` — real
  `Permission.Service` with the hooks registered in real order (AC1/AC2/AC3/AC6, and D2: a config
  edit denied even with a matching policy+agent allow rule; an interactive session's own edit rules
  unaffected).
- `bun run test ./test/kete/unattended-session.test.ts` inside `packages/core/` — real
  `Session.Service` (AC4, D2, and the "child with its own explicit `metadata: {}`" case).
- `bun run test ./test/kete/permission-ceiling.test.ts` inside `packages/core/` — covers the
  policy-widens-ancestors / ceiling-still-wins case (`Lookup.policy`).
- `stopReason` and the `KeteAudit.begin` refusal are covered by the `audit-log` card's own tests
  (`test/kete/audit.test.ts`, `test/kete/audit-service.test.ts`), not here.

## Changes
- `docs/upstream-patches.md` "Unattended runs (feature/unattended-policy)" — full file list, the
  "Known limitation" note (a gone root row), and the invariant/resolution rewrite from the reviewer
  fix.
- `docs/adr/0008-unattended-runs-fail-closed.md` — the decision this implements; see
  `docs/context/decisions.md`.
- `docs/tasks/2026-09-28-unattended-policy/` — spec, plan (including a "Post-review correction"
  note in Design), handoff.
- `docs/tasks/2026-09-28-audit-log/` — added the audit log (`audit-log` card): `Plugin` installs
  `KeteAudit`'s hooks, `run-checks.ts` calls `KeteAudit.begin`, `stopReason` added. Zero new
  upstream edits (D1 option B).

- `docs/tasks/2026-09-28-job-run/` — added `kete job run` (`cli` card), the D2 config-edit deny
  (`applyLate`/`configTarget`, above), and moved `AllowRule`/`Policy`/the stop-message builders to
  `@opencode/schema/kete/unattended` (zero new upstream edits).
- `docs/tasks/2026-09-29-job-tool-isolation/` — `run-checks.ts` gained the job-mode-implies-
  unattended check and `unattended.ts` (schema) gained `jobMode()`; see the `job-mode` card.

## Gotchas
- **A `permission.asked` from a subagent (not the root session) during a `kete job run` isn't
  recognized as the runtime-bug case** the job's CLI-side event watcher checks for — only the root
  session's own asks are (`cli/src/kete/job-run.ts`'s `watchEvents`, documented in
  `docs/jobs.md` "Known gaps"). This is a `kete job run` client-side limitation, not a gap in this
  module's own fail-closed enforcement — the runtime still denies the subagent's `ask` itself via
  `applyLate` exactly as for the root; only the CLI's "the runtime asked during a job, stop and
  report a bug" detection misses subagents' own ask events on the wire.
- A **decode failure or unknown `version`** on an already-unattended session's `kete.unattended`
  fails closed to `emptyPolicy` (no allows, no limits) — it does **not** make the session
  interactive. Only a *missing* session/ancestor before any key is found does that.
- `familyCost` and `resolve`'s ancestor walk share the same `MAX_DEPTH = 32` constant but count
  differently: `resolve` walks **up** through `parentID`; `familyCost` walks **down** via
  `lookup.children` (BFS by depth, not total node count) — a family deeper than 32 generations
  undercounts cost rather than erroring.
- `watch`'s timer is per-session, forked from `Execution.Started`; it does not by itself stop a
  *different* session in the same family from starting a new step past the deadline — that's what
  the step-boundary `check` in `run-checks.ts` is for. Both exist because either alone leaves a gap
  (a single very long step, or a session that never gets a `Started` event before the deadline).
- The known limitation for a root session whose own row has since been deleted (not reachable via
  any current code path) is documented, not fixed — see `docs/upstream-patches.md`.
- `kete/audit.ts` takes only a **type-only** (`import type`) reference to this module (for `Limits`);
  `unattended.ts`'s `Plugin` passes a `stopReason` closure into `KeteAudit.install` rather than a
  `KeteUnattended.Lookup` value, so the two modules don't form a runtime import cycle
  (`audit.ts` calls back into `unattended.ts` only through that closure). Don't "fix" this by giving
  `audit.ts` a runtime import of `unattended.ts` — it would cycle.
