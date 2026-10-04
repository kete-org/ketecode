# Handoff: Unattended runs fail closed (ADR 0008)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-28 scout

(Pasted by the coordinator; the scout has no write tool.)

- Q1 per-session flag → docs enough: no — missing: where a per-session flag lives so the permission hook reads it and subagents inherit it (permissions card). Answer: session metadata, like `kete.permissionMode` (`packages/core/src/kete/permission-mode.ts:41-43`); children inherit metadata unless they supply their own (`packages/core/src/session.ts:273-276`). Config can't tell sessions apart; plugin-local maps (`budget.ts:30`) aren't inherited.
- Q2 evaluate hook and deny reason → docs enough: yes. `permission.ts:173-188` triggers `permission.evaluate`; hooks mutate `event.effect`/`event.message`. `permission-ceiling.ts:82-98` tightens with `stricter()` and sets the message; `assert()` fails with `BlockedError({reason})` (`permission.ts:237-243`), which reaches the model as a tool failure.
- Q3 `kete run --auto` and jobs → docs enough: no — missing: the unattended entry points (cli card). `noninteractive.ts:135-154`: `--auto` replies "once" to every ask; without it, "reject" and interrupt. No `kete job` command or job route exists (`Job` in routes.ts is internal DI only).
- Q4 budget and timeout → docs enough: yes. `kete.budget.session` unset → no cap (`budget.ts:41-42`); `kete.subagents.timeout` unset → 60 min default (`subagents.ts:36`), `0` = no limit. "Refused without them" is new for unattended runs.
- Q5 audit log → docs enough: yes. None exists; architecture.md §109 is future, and centralized audit logs are platform-owned (`architecture.md:185`).
- ~66k tokens, ~2 min.

## 2026-09-28 coordinator

- spec.md approved by the user (2026-09-28). Audit log and `kete job run` are separate tasks.
- Found while drafting: worktree subagents pass their own metadata (`tool/plugin/subagent.ts:227`), which replaces the parent's, so `kete.permissionMode` is likely dropped for worktree subagents today too. The planner should confirm and say whether this task fixes it.

## 2026-09-28 planner

- Done: `plan.md` written (22 files: 3 new source, 4 upstream/Kete changes, 4 test files new/changed, docs). All cards current (`stale-cards.mjs`).
- Upstream edits: `core/src/plugin/internal.ts`, `core/src/session/session.ts`, `core/src/session/runner/llm.ts` (existing marked lines only). No config schema or protocol change unless D1 = (b).
- Coordinator's note refuted: worktree subagents keep the parent's metadata (`kete/worktrees.ts:253` spreads `parent.metadata`), so `kete.permissionMode` isn't dropped; the task still resolves `kete.unattended` from the root.
- Decisions for the user (in plan.md): D1 refusal surface (500 defect vs typed 409), D2 lock session `permissions` too, D3 ignore saved "always" approvals, D4 whole-run budget.
- Docs enough: no — missing: evaluate hook order across `pre` and `post`; the permissions card omits the sync-policy hook (`kete/sync/plugin.ts:279`) and `ConfigPolicyPlugin`'s (`config/plugin/policy.ts:44`) (permissions card).
- Docs enough: no — missing: how session metadata is updated (`session/session.ts:76-82` `setMetadata`, the only publisher of `MetadataUpdated`) and that no hook can refuse it; session hooks can't fail (`plugin/hooks.ts:23-30`) (permissions / worktrees-parallel cards).
- Docs enough: no — missing: a seam to refuse a prompt (the `session` `prompt` hook can't fail; the runner step at `session/runner/llm.ts:229` is the place) (budget card).
- Docs enough: no — missing: that worktree child metadata spreads the parent's (`worktrees.ts:253`) (worktrees-parallel card).
- Docs enough: no — missing: which code asks a person outside permissions: `Form` asks in the question tool (`tool/plugin/question.ts:75`, gated by the `question` permission), websearch provider choice (`tool/plugin/websearch.ts:76,109`) and MCP elicitation (`mcp/index.ts:235,263`) (no card).
- Docs enough: no — missing: which event marks a run starting (`SessionEvent.Execution.Started`, `session/execution.ts:118`) (subagents card).
- Docs enough: yes — budget config and checker; subagent timeout defaults; ceiling `Lookup`.
- Open (follow-ups, not this task): websearch provider form and MCP elicitation still wait for a person in an unattended run (bounded only by the time limit; needs a Form-level seam); an agent allowed to edit `.kete/` config could widen its own rules mid-run (for the `kete job run` task); user plugins' `evaluate` hooks load after the internal ones and could loosen (plugins are trusted code today).

## 2026-09-28 coordinator

- plan.md approved by the user (2026-09-28) with D1–D4 at the defaults: D1 internal error; D2 yes, refuse permission changes; D3 yes, ignore saved "always" approvals; D4 whole-run budget and time limit from the root session's creation.

## 2026-09-28 implementer

- Built the plan as written. New files: `packages/core/src/kete/unattended-policy.ts` (contract,
  strict decode, root resolution fail-closed, `allows`, `guardMetadata`/`guardPermissions`,
  `LockedError`), `packages/core/src/kete/unattended.ts` (`PolicyPlugin` early hook, `Plugin` late
  hook + time-limit timer, `limits`, `check`, `make`/`nodes`), `packages/core/src/kete/run-checks.ts`
  (`KeteRunChecks`: dispatches to `KeteBudget` or `KeteUnattended.check` by family kind).
- Changed (Kete-owned, no markers): `packages/core/src/kete/permission-ceiling.ts` — `Lookup` gained
  `policy(sessionID)`, wired from `KeteUnattendedPolicy.resolve` in the `Plugin`, filtering out any
  rule that would match `budget`/`question` (mirrors `allows`'s restriction, since the ceiling merges
  policy rules straight into a `Ruleset` rather than going through `allows`).
- Upstream edits (all `kete_change`-marked, `docs/upstream-patches.md` updated with a new section
  "Unattended runs (feature/unattended-policy)" after "Subagent security"):
  1. `packages/core/src/plugin/internal.ts` — import; `KeteUnattended.PolicyPlugin` in `pre` after
     `KeteBudgetRule`/before `KetePermissionMode`; `KeteUnattended.Plugin` last in `post`; both IDs in
     `guarded`.
  2. `packages/core/src/session/session.ts` — `setMetadata` keeps the fetched session and calls
     `guardMetadata`; `setPermissions` calls `guardPermissions` (D2).
  3. `packages/core/src/session/runner/llm.ts` — the four existing marked lines now wire
     `KeteRunChecks` instead of `KeteBudget` (renamed local var `budget` → `checks`).
  4. `packages/core/test/session-runner.test.ts` — "uses parent cache affinity for child model
     requests" fabricated a `parent_id` pointing at a session row that was never inserted (only
     testing cache-header propagation). `KeteUnattended`'s root walk now resolves that as a missing
     ancestor (fail closed → unattended, no budget/timeout → refused), which broke the scenario.
     Fixed by inserting a real parent row (`insertSession(parentID)`) before setting `parent_id`,
     matching what `Session.create` would actually produce; the test's own assertions are unchanged.
     This is the one place the plan's fail-closed design surfaced a pre-existing test fixture gap —
     not a plan error, just a fixture that needed a real parent row.
- Design decision not spelled out in the plan: extracted the two plugins' `evaluate`-hook bodies into
  standalone pure functions (`KeteUnattended.applyPolicy`, `applyLate`) and the timer's per-event
  logic into `KeteUnattended.watch` (over a `TimerLookup`), separate from `PolicyPlugin`/`Plugin`
  which just wire them to `ctx.permission.hook` / the bus subscription with real services. This
  mirrors `KetePermissionCeiling.apply` (already pure/testable, wired by its `Plugin`) and is what
  let `unattended-service.test.ts` register hooks in real order against the real `Permission` service
  and `unattended.test.ts` test the timer with `it.live` — without needing a full plugin host.
- Tests: `unattended.test.ts` (26, pure: decode/root/allows/guards/limits/check/watch),
  `unattended-service.test.ts` (6, real `Permission` service, hooks in real order — AC1/AC2/AC3/AC6),
  `unattended-session.test.ts` (5, real `Session.Service` — AC4, D2), `permission-ceiling.test.ts`
  (+1 case for the policy-widens-ancestors / ceiling-still-wins behavior).
- Docs: `packages/core/src/kete/skill/kete.md` — new "Unattended runs" bullet (policy shape, required
  limits, denial messages). Did not touch `docs/context/` (librarian's job per the plan's "Cards to
  update after the build" list and CLAUDE.md).
- Checks (all PASS): `packages/core` typecheck; `packages/schema` typecheck; `packages/core` full
  test suite (5583 pass · 30 fail, all pre-existing Ripgrep/network and ShellTool process-substitution
  failures unrelated to this change — confirmed none touch session/permission/budget/subagent code);
  `./test/kete` (168 pass); the AC-specific `-t` filters in the plan's verification table; root
  `bun run lint`; root `bun turbo typecheck`; `bun run --cwd packages/kete-tools upstream:check`;
  `bun run --cwd packages/kete-tools verify --base main` (see this entry's continuation, run last).
- Open questions: none — the plan built cleanly as written.
- Final check: `bun run --cwd packages/kete-tools verify --base main` — PASS (758.6s, exit 0).

## 2026-09-28 implementer (reviewer fix)

- Reviewer (major) finding: `stateOf(undefined)` (a missing ancestor) resolved as
  `{kind: "unattended", policy: emptyPolicy, invalid}`, so an ordinary **interactive** session with
  a broken parent chain (`session_v2.parent_id` has no FK; `session/execution/restart.ts` can treat
  a missing parent as real) got every ask denied and every prompt refused. Fixed exactly as the
  coordinator's message specified:
  1. **Invariant: every session in an unattended family now carries its own copy of
     `kete.unattended`.** New `KeteUnattendedPolicy.inheritMetadata(parentMetadata, providedMetadata)`
     forces the parent's `kete.unattended` onto a child's metadata even when the caller supplies its
     own (a plain child already got it via upstream's `input.metadata ?? parent?.metadata`). Wired
     into `packages/core/src/session.ts`'s `create` (a **new, second upstream edit** beyond the three
     in the original plan; marked, and added to `docs/upstream-patches.md`). Checked: today's only
     caller that supplies its own metadata at creation (the worktree subagent path,
     `tool/plugin/subagent.ts:227` via `kete/worktrees.ts:253`'s `isolate`) already spreads the
     parent's full metadata, so this wasn't an exploitable gap today — `inheritMetadata` is defense
     in depth for that path and any future caller that doesn't spread it. Corrected my earlier
     (inaccurate) comments/test descriptions that called `metadata: {}` "the worktree case" — it
     isn't, per `kete/worktrees.ts:253`'s actual code.
  2. **Resolution rewritten.** `KeteUnattendedPolicy.resolve` no longer separates a `root()` walk
     from a `stateOf()` decode; it's one walk from the session up through `parentID`: unattended if
     the session itself or any *resolvable* ancestor carries the key, using the root-most one found
     (its `Info` is now carried on the `Unattended` state as `root`, replacing the old standalone
     `root()`/`stateOf()` exports — `unattended.ts`'s `check`/`watch` now read `state.root` directly
     instead of a second lookup). A broken chain **before** any session is found is now
     **interactive**, unchanged behavior; a broken chain **after** one was found still fails closed,
     using that session's value. `guardMetadata` needed no change (it only ever compared a single
     session's own current/next metadata, never walked); `guardPermissions` automatically inherited
     the fix since it already called `resolve`.
  3. `check()` and the timer's `watch()` now treat `state.kind === "interactive"` as a no-op
     (defensive — the runner only calls them for a family `resolve` already found unattended), so no
     refusal message is ever emitted for a session that isn't actually unattended.
- Reverted `packages/core/test/session-runner.test.ts`'s earlier fixture fix (`insertSession(parentID)`
  before setting a fabricated `parent_id`) — no longer needed: that session has no
  `kete.unattended` of its own and its parent doesn't exist, which now resolves as interactive.
- Tests updated/added: `unattended.test.ts`'s resolve/check describe blocks rewritten for the new
  semantics (interactive-when-nothing-found vs. fails-closed-after-something-found, `root` on the
  state, depth-limit cases split into "nothing found in range" vs. "found at the query session
  itself"); `unattended-session.test.ts` gained the requested test (a child created with explicit
  `metadata: {}` of an unattended root still gets `kete.unattended`, plus a case with unrelated
  explicit metadata, plus a plain/interactive child control); `unattended-service.test.ts` gained the
  requested two tests (an orphaned interactive session's ask still produces a normal
  `permission.asked`-equivalent pending request; a child carrying its own copy of the key stays
  unattended even when its root row is never inserted/"gone"). Comments in the existing fixture
  corrected to describe it as "a session from before the invariant existed", not "the worktree case".
- Files touched beyond the original list: `packages/core/src/session.ts` (new upstream edit,
  marked), `docs/upstream-patches.md` (updated), `docs/tasks/2026-09-28-unattended-policy/plan.md`
  (appended a "Post-review correction" note to Design, did not rewrite).
- Checks re-run, all PASS: core typecheck; `bun run test ./test/kete` (173 pass); AC-filtered
  `-t ask`/`-t allow`/`-t subagent` on both service/pure files, `unattended-session.test.ts`,
  `-t limit` + `budget.test.ts`, permission-mode/permission-ceiling/permission/session-create/
  session-runner suites; root `bun run lint`; root `bun turbo typecheck`; root
  `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify
  --base main` — PASS (763.7s, exit 0), run last.
