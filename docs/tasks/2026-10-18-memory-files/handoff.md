# Handoff: CLAUDE.md compatibility, @imports and nested memory (A2a)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-18 main session
Spec approved under the user's 2026-10-18 instruction to carry on through every remaining item without stopping ("proceed with the next tasks as recommended, don't stop until all tasks are completed"). A2 is split: this task is A2a; A2b (/remember, /memory, auto memory) follows.

## 2026-10-18 planner
- Done: read INDEX, spec, handoff, and the `instructions` and `config-kete` cards; ran `node scripts/agent/stale-cards.mjs instructions config-kete roles-skills`.
- Blocked: `roles-skills` is STALE (2 files changed since ecfae5cce7: `packages/cli/src/kete/skill-flow.ts`, `packages/util/src/kete/skill-source.ts`, from A9 `kete skill`). The librarian must refresh `roles-skills` before planning. `instructions` and `config-kete` are fresh.
- Not written: `plan.md` (still the template).
- Open question for main session: the stale files are A9's skill install code, which is probably unrelated to the `.claude` compatibility this task relies on. If the librarian refreshes the card (or the main session drops `roles-skills` from the spec's card list), re-run the planner.

## 2026-10-18 planner (second run)
- Done: `instructions`, `config-kete` and `roles-skills` (refreshed to 9a95cb7ac3) are current. Wrote `plan.md`.
- Decisions:
  - Nested `CLAUDE.md` uses the `ctx.tool.hook("execute.after")` seam, not a marked edit to `tool/plugin/read.ts`. Only `plugin/internal.ts` is edited upstream.
  - Only `.md` files can be imported from `~/.claude/` and the global config folder. This is a security tightening beyond the spec, because those folders hold `kete.json`, `settings.json` and transcripts.
  - Skip notes are added as trailing lines of the importing file's entry. Missing import targets are skipped silently.
- Docs enough: no — missing: the `instructions` card doesn't say that the `InstructionDiscovery` transform callback is synchronous. It also doesn't say how to reorder entries (remove, then re-add), so I read `instruction-discovery.ts` and `state.ts`.
- Docs enough: no — missing: no card names the runtime's secret-path matcher (`KeteShellRisk.credential`, `core/src/kete/shell-risk.ts:273`). No card notes that it matches `.config/kete`.
- Docs enough: no — missing: no card says the `execute.after` tool hook can stand in for edits inside a tool's `execute`, or what its event carries (`plugin/src/effect/tool.ts:29`).
- Open for the user at approval: the md-only rule and the hook-instead-of-`read.ts` change both depart from the spec.

## 2026-10-18 implementer
- Done (steps 1-7, 9): schema `ConfigKete.Memory` + `Info.memory`; `core/src/kete/memory-imports.ts` (pure rules); `core/src/kete/memory-files.ts` (`expand`, preloaded half, nested `execute.after` half); two marked lines in `plugin/internal.ts` (import + registration right after `ConfigInstructionPlugin.Plugin`); tests `test/kete/memory-imports.test.ts` and `test/kete/memory-files.test.ts`; `.github/README.md`, `CHANGELOG.md`, `docs/upstream-patches.md`.
- NOT RUN: this agent had no shell tool, so no check ran (no tests, no typecheck, no `upstream:check`, no lint). Step 8 (regenerate `packages/protocol/openapi.json` and `packages/client/src/*/generated/`) is NOT done and must be run by the main session: `bun run generate` in `packages/protocol`, then in `packages/client`. Everything below is untested code; expect small type/test fixes.
- Decisions:
  - `denied` picks the most specific root for the credential check and treats a path as markdown-only if ANY containing root is markdown-only (a project sitting in `~` can't reach `~/.claude/settings.json`).
  - Watchers are set only where the parent folder exists (`fs.watch` throws otherwise); a `.claude/` folder created later is noticed at the next rescan only.
  - If the plugin fails to activate it logs and leaves upstream's entries alone (upstream marks the source unavailable instead).
  - With `global: false` the ancestor walk skips `~/.claude/CLAUDE.md` too (mirrors upstream's global AGENTS.md exclusion).
  - Config switch changes (`kete.memory`) take effect at the next rescan/restart, not live.
- Type risks to check first: `event.sessionID` passed to `SessionInstructions.load` without a cast; `Effect.forkScoped` called inside `refresh` (via `watchAll`); `info.size` as bigint -> `Number`; `define()` inference with `ctx: PluginContext`; test harness casts (`as never`) for hook and `Config.testLayer` entries.
- Cards not touched (librarian): `instructions`, `config-kete`, `pitfalls` per the plan's "Cards to update".
