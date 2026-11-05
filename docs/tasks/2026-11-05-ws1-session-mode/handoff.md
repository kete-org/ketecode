# Handoff: WS1 session mode

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 planner
- Done: plan.md written. Cards (unattended, permissions, config-kete, roles-skills, server-sdk) all current per `stale-cards.mjs`.
- Decision: the Work default agent is stored as the session's `agent` at create (`session.ts` `:314`) instead of
  editing every `Agent.select(session.agent)` caller (`session/context.ts:133`, `session/runner/model.ts:81`,
  `schedule/check.ts:192,254,369`, `config/plugin/command.ts:112`, `kete/plan-approval.ts:137`). Same outcome,
  agent and model agree everywhere, two upstream files instead of six. Code stores no agent, so `default_agent` still wins.
- Decision: a child that supplies its own metadata gets the parent's `kete.sessionMode` forced on (like
  `inheritMetadata`), and a child naming a different mode is refused, so a subagent can't leave Work.
- Decision: own `RefusedError`/`LockedError` classes in `core/src/kete/session-mode.ts`, same shape and `Effect.die`
  as `KeteAddDir`/`KeteUnattendedPolicy` (their messages hard-code their own keys).
- Docs enough: no — missing: the full list of `Agent.select(session.agent)` call sites (roles-skills names only
  `SessionContext.select`); how `Session.create` builds `metadata`/`agent` at `session.ts:301-317` (unattended card
  describes the `metadata:` line only); `KeteAddDir.RefusedError` dies rather than fails (`add-dir.ts:36,138`).
- Open: Plan-mode approval in a Work session (`plan-approval.ts` `target`) switches to the global default agent, not
  Work's; out of scope until 1.3/1.4 make Work real.

## 2026-11-05 implementer
- Done: steps 1-6 as planned. NO SHELL available in this run, so no check was run (typecheck, tests, lint, upstream:check all UNRUN).
- Files: util/src/kete/session-mode.ts, core/src/kete/session-mode.ts (new); core/src/session.ts, core/src/session/session.ts (marked);
  core/test/kete/session-mode.test.ts, session-mode-session.test.ts (new); docs/upstream-patches.md (new section at end), docs/desktop-enhancement-plan.md.
- Risks to check when run: `@opencode/util/kete/session-mode` export resolving in core; the compile-time Mode/Id check; `Effect.die` defect assertions via `Cause.squash`; `agent` metadata type in the "plan" test.
- Did not read AC4's `session-agent-model.test.ts`; just run it.
